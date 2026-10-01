import * as THREE from "three";
import * as OBC from "@thatopen/components";
import * as OBF from "@thatopen/components-front";
import * as FRAGS from "@thatopen/fragments";
import { convertIfc } from "./ifcConvert";
import type { WorkerRequest, WorkerResponse } from "./ifcWorker";
import { toIfcClassName } from "./ifcClassNames";
import type { ClassCount, ElementInfo, NameValue, PropertySetInfo } from "./protocol";

export const SELECT = "select";
const BACKGROUND = "#1f2226";
const SELECTION_COLOR = "#43d17a";

// Relaciones que se leen al describir un elemento. Se nombran explícitamente para no
// arrastrar relaciones masivas (p. ej. ObjectTypeOf: todas las instancias de un tipo).
const DESCRIBE_RELATIONS = {
  IsDefinedBy: { attributes: true, relations: true },
  HasProperties: { attributes: true, relations: false },
  Quantities: { attributes: true, relations: false },
  HasPropertySets: { attributes: true, relations: true },
};

type ProgressHandler = (stage: string, progress: number) => void;
type SelectionHandler = (count: number, element: ElementInfo | null) => void;

export interface LoadResult {
  elementCount: number;
  classes: ClassCount[];
  fromCache: boolean;
  /** Fragments recién convertidos desde IFC (para guardarlos en la caché del host). */
  fragments: Uint8Array | null;
}

/**
 * Núcleo del visor sobre That Open: mundo 3D, carga (IFC o caché .frag), selección y visibilidad.
 * Las herramientas (cortes, pisos, mediciones…) viven en tools.ts. No conoce al host C#.
 */
export class BncViewer {
  onSelectionChanged: SelectionHandler = () => {};

  readonly components = new OBC.Components();
  world!: OBC.SimpleWorld<OBC.SimpleScene, OBC.OrthoPerspectiveCamera, OBC.SimpleRenderer>;
  fragments!: OBC.FragmentsManager;
  highlighter!: OBF.Highlighter;
  private grid!: OBC.SimpleGrid;
  private readonly hiddenModels = new Set<string>();
  private selectionSeq = 0;
  private workerBroken = false;

  async init(container: HTMLElement): Promise<void> {
    const world = this.components
      .get(OBC.Worlds)
      .create<OBC.SimpleScene, OBC.OrthoPerspectiveCamera, OBC.SimpleRenderer>();
    world.scene = new OBC.SimpleScene(this.components);
    world.scene.setup();
    world.scene.three.background = new THREE.Color(BACKGROUND);
    world.renderer = new OBC.SimpleRenderer(this.components, container);
    // Rendimiento: en pantallas 4K/escaladas no se renderiza a más de 1,5 píxeles por píxel CSS.
    world.renderer.three.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    world.camera = new OBC.OrthoPerspectiveCamera(this.components);
    await world.camera.controls.setLookAt(18, 14, 18, 0, 0, 0);
    this.components.init();
    this.world = world;

    this.grid = this.components.get(OBC.Grids).create(world);
    this.grid.config.color = new THREE.Color("#3a3f45");
    this.components.get(OBC.Raycasters).get(world);

    // Todo se sirve localmente: nada de CDN (la app debe funcionar sin internet).
    this.fragments = this.components.get(OBC.FragmentsManager);
    this.fragments.init(await loadWorkerUrl(new URL("/fragments-worker.mjs", location.origin).href));

    // Fragments decide qué detalle (LOD) y qué elementos dibujar según la cámara:
    // actualización ligera mientras se mueve y completa al detenerse.
    world.camera.controls.addEventListener("update", () => this.fragments.core.update());
    world.camera.controls.addEventListener("rest", () => this.fragments.core.update(true));
    const useCamera = (camera: THREE.PerspectiveCamera | THREE.OrthographicCamera) => {
      for (const [, model] of this.fragments.list) model.useCamera(camera);
      this.fragments.core.update(true);
    };
    world.onCameraChanged.add((camera) => useCamera(camera.three));
    world.camera.projection.onChanged.add(useCamera);

    this.fragments.list.onItemSet.add(({ value: model }) => {
      model.useCamera(world.camera.three);
      world.scene.three.add(model.object);
      this.fragments.core.update(true);
    });

    // Elementos solapados (caras coplanares): un desplazamiento de polígono distinto por
    // material evita el parpadeo ("z-fighting") típico de modelos BIM.
    this.fragments.core.models.materials.list.onItemSet.add(({ value: material }) => {
      if (!("isLodMaterial" in material && material.isLodMaterial)) {
        material.polygonOffset = true;
        material.polygonOffsetUnits = 1;
        material.polygonOffsetFactor = Math.random();
      }
    });

    await this.components.get(OBC.IfcLoader).setup({ autoSetWasm: false, wasm: { path: this.wasmPath, absolute: true } });

    this.highlighter = this.components.get(OBF.Highlighter);
    this.highlighter.setup({
      world,
      selectName: SELECT,
      selectMaterialDefinition: {
        color: new THREE.Color(SELECTION_COLOR),
        opacity: 1,
        transparent: false,
        renderedFaces: FRAGS.RenderedFaces.TWO,
      },
    });
    this.highlighter.events[SELECT].onHighlight.add((map) => void this.publishSelection(map));
    this.highlighter.events[SELECT].onClear.add(() => {
      this.selectionSeq++;
      this.onSelectionChanged(0, null);
    });
  }

  get modelCount(): number {
    return this.fragments.list.size;
  }

  get selection(): OBC.ModelIdMap {
    return this.highlighter.selection[SELECT] ?? {};
  }

  hasSelection(): boolean {
    return Object.values(this.selection).some((ids) => ids.size > 0);
  }

  private get wasmPath(): string {
    return new URL("/wasm/", location.origin).href;
  }

  /**
   * Carga un modelo federado (cargar uno no descarga los demás). Desde la caché .frag es casi
   * inmediato; desde IFC se convierte en un Web Worker y se devuelven los fragments para cachearlos.
   */
  async loadModel(url: string, format: "ifc" | "frag", modelId: string, onProgress: ProgressHandler): Promise<LoadResult> {
    if (this.fragments.list.has(modelId)) await this.unloadModel(modelId);

    const bytes = await fetchWithProgress(url, (p) => onProgress(format === "frag" ? "Leyendo caché" : "Leyendo archivo", p));
    let fragBytes: Uint8Array | null = null;
    if (format === "ifc") {
      onProgress("Procesando geometría", 0);
      fragBytes = await this.convert(bytes, (p) => onProgress("Procesando geometría", p));
    }

    onProgress("Preparando visualización", 1);
    // fragments.core.load puede transferir el buffer a su worker: se entrega una copia y se
    // conserva el original para la caché.
    const model = await this.fragments.core.load(fragBytes ? fragBytes.slice() : bytes, { modelId });

    this.placeGrid();
    this.fitAll();
    return { ...(await summarize(model)), fromCache: format === "frag", fragments: fragBytes };
  }

  private async convert(bytes: Uint8Array, onProgress: (p: number) => void): Promise<Uint8Array> {
    if (!this.workerBroken) {
      try {
        return await convertInWorker(bytes, this.wasmPath, onProgress);
      } catch (error) {
        if (!(error instanceof WorkerUnavailableError)) throw error;
        this.workerBroken = true;
      }
    }
    return convertIfc(bytes, this.wasmPath, onProgress); // respaldo: hilo principal
  }

  /**
   * Extensión del modelo en coordenadas IFC (X, Y en planta, Z altura). Fragments lleva cada modelo
   * al origen y guarda sus coordenadas originales (baseCoordinates); el visor usa Y hacia arriba.
   */
  extentOf(modelId: string): { min: number[]; max: number[] } | null {
    const model = this.fragments.list.get(modelId);
    if (!model || model.box.isEmpty()) return null;
    const [bx, by, bz] = this.fragments.core.baseCoordinates ?? [0, 0, 0];
    const { min, max } = model.box;
    return {
      min: [min.x - bx, -(max.z - bz), min.y - by],
      max: [max.x - bx, -(min.z - bz), max.y - by],
    };
  }

  async unloadModel(modelId: string): Promise<void> {
    await this.highlighter.clear(SELECT);
    this.hiddenModels.delete(modelId);
    if (this.fragments.list.has(modelId)) await this.fragments.core.disposeModel(modelId);
    this.placeGrid();
  }

  async setModelVisibility(modelId: string, visible: boolean): Promise<void> {
    const model = this.fragments.list.get(modelId);
    if (!model) return;
    if (visible) this.hiddenModels.delete(modelId);
    else this.hiddenModels.add(modelId);
    await model.setVisible(undefined, visible);
    await this.fragments.core.update(true);
  }

  async selectElements(query: { modelId?: string; expressIds?: number[]; globalIds?: string[] }, zoom: boolean, isolate: boolean): Promise<boolean> {
    const map = await this.resolveIds(query);
    if (Object.keys(map).length === 0) return false;
    if (isolate) await this.components.get(OBC.Hider).isolate(map);
    await this.highlighter.highlightByID(SELECT, map, true, false);
    if (zoom) this.fitTo(map);
    return true;
  }

  async clearSelection(): Promise<void> {
    await this.highlighter.clear(SELECT);
  }

  async isolateSelection(): Promise<void> {
    if (this.hasSelection()) await this.components.get(OBC.Hider).isolate(this.selection);
  }

  async hideSelection(): Promise<void> {
    if (!this.hasSelection()) return;
    const selection = this.selection;
    await this.highlighter.clear(SELECT);
    await this.components.get(OBC.Hider).set(false, selection);
  }

  async isolate(map: OBC.ModelIdMap): Promise<void> {
    await this.components.get(OBC.Hider).isolate(map);
    this.fitTo(map);
  }

  async showAll(): Promise<void> {
    await this.components.get(OBC.Hider).set(true);
    // "Mostrar todo" respeta los modelos que el usuario apagó en la lista de modelos.
    for (const modelId of this.hiddenModels) await this.fragments.list.get(modelId)?.setVisible(undefined, false);
    await this.fragments.core.update(true);
  }

  fitAll(): void {
    this.fitTo(undefined);
  }

  fitSelection(): void {
    if (this.hasSelection()) this.fitTo(this.selection);
  }

  // La promesa de la animación de cámara solo se resuelve cuando la cámara queda
  // en reposo (y nunca si el usuario sigue orbitando), por eso no se espera.
  fitTo(map: OBC.ModelIdMap | undefined): void {
    // Con el visor oculto (tamaño 0) el encuadre deja la cámara en NaN.
    if (this.world.renderer!.three.domElement.clientHeight === 0 || this.modelCount === 0) return;
    this.world.camera.fitToItems(map).catch(() => {});
  }

  /** La ciudad 3D trae su propio terreno: la grilla de referencia se oculta mientras está visible. */
  setGridVisible(visible: boolean): void {
    this.grid.three.visible = visible;
  }

  // La grilla queda bajo el punto más bajo de los modelos, como plano de referencia.
  private placeGrid(): void {
    const models = [...this.fragments.list.values()];
    if (models.length === 0) return;
    this.grid.three.position.y = Math.min(...models.map((m) => m.box.min.y)) - 0.01;
  }

  /** Convierte ExpressIDs o GlobalIds en un ModelIdMap, descartando los que no existen. */
  private async resolveIds(query: { modelId?: string; expressIds?: number[]; globalIds?: string[] }): Promise<OBC.ModelIdMap> {
    if (query.globalIds?.length) {
      return this.fragments.guidsToModelIdMap(query.globalIds);
    }
    const map: OBC.ModelIdMap = {};
    if (!query.expressIds?.length) return map;
    for (const [modelId, model] of this.fragments.list) {
      if (query.modelId && query.modelId !== modelId) continue;
      const guids = await model.getGuidsByLocalIds(query.expressIds);
      const found = query.expressIds.filter((_, i) => guids[i] !== null);
      if (found.length > 0) map[modelId] = new Set(found);
    }
    return map;
  }

  private async publishSelection(map: OBC.ModelIdMap): Promise<void> {
    const seq = ++this.selectionSeq;
    const entries = Object.entries(map).filter(([, ids]) => ids.size > 0);
    const count = entries.reduce((n, [, ids]) => n + ids.size, 0);
    if (count === 0) {
      this.onSelectionChanged(0, null);
      return;
    }
    const [modelId, ids] = entries[0];
    const element = await this.describe(modelId, ids.values().next().value!);
    if (seq === this.selectionSeq) this.onSelectionChanged(count, element);
  }

  private async describe(modelId: string, localId: number): Promise<ElementInfo> {
    const model = this.fragments.list.get(modelId)!;
    const [[data], [guid]] = await Promise.all([
      model.getItemsData([localId], {
        attributesDefault: true,
        relations: DESCRIBE_RELATIONS,
        relationsDefault: { attributes: false, relations: false },
      }),
      model.getGuidsByLocalIds([localId]),
    ]);

    const attributes: NameValue[] = [];
    for (const [key, entry] of Object.entries(data ?? {})) {
      if (key.startsWith("_") || Array.isArray(entry)) continue;
      attributes.push({ name: key, value: formatValue(entry.value) });
    }

    const definitions = Array.isArray(data?.IsDefinedBy) ? data.IsDefinedBy : [];
    const type = definitions.find(isTypeObject);
    return {
      modelId,
      expressId: localId,
      globalId: guid ?? null,
      ifcClass: categoryName(data),
      name: (attributeValue(data, "Name") as string | undefined) ?? null,
      typeName: type ? `${attributeValue(type, "Name") ?? "(sin nombre)"} · ${categoryName(type)}` : null,
      attributes,
      propertySets: [
        ...readPropertySets(definitions.filter((d) => !isTypeObject(d)), ""),
        // Propiedades heredadas del tipo (Revit suele guardarlas ahí).
        ...readPropertySets(type && Array.isArray(type.HasPropertySets) ? type.HasPropertySets : [], " (tipo)"),
      ],
    };
  }
}

class WorkerUnavailableError extends Error {}

function convertInWorker(bytes: Uint8Array, wasmPath: string, onProgress: (p: number) => void): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL("./ifcWorker.ts", import.meta.url), { type: "module" });
    } catch (error) {
      reject(new WorkerUnavailableError(String(error)));
      return;
    }
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;
      if (message.type === "progress") onProgress(message.progress);
      else {
        worker.terminate(); // libera de inmediato la memoria de web-ifc
        if (message.type === "done") resolve(message.bytes);
        else reject(new Error(message.message));
      }
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new WorkerUnavailableError(event.message || "No se pudo iniciar el procesador IFC en segundo plano."));
    };
    // Se copia (no se transfiere) para poder reintentar en el hilo principal si el worker no arranca.
    const request: WorkerRequest = { bytes, wasmPath };
    worker.postMessage(request);
  });
}

async function loadWorkerUrl(url: string): Promise<string> {
  // Se carga como Blob para no depender del MIME que el host asigne a ".mjs".
  const response = await fetch(url);
  const blob = new Blob([await response.arrayBuffer()], { type: "text/javascript" });
  return URL.createObjectURL(blob);
}

async function fetchWithProgress(url: string, onProgress: (p: number) => void): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`No se pudo leer el archivo (HTTP ${response.status}).`);
  }
  const total = Number(response.headers.get("content-length")) || 0;
  const reader = response.body.getReader();
  // Con tamaño conocido se escribe directo en un único buffer (sin duplicar memoria).
  const bytes = total > 0 ? new Uint8Array(total) : null;
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (bytes && received + value.length <= total) bytes.set(value, received);
    else chunks.push(value);
    received += value.length;
    if (total > 0) onProgress(Math.min(1, received / total));
  }
  if (bytes && chunks.length === 0 && received === total) return bytes;

  const result = new Uint8Array(received);
  let offset = 0;
  if (bytes) {
    result.set(bytes.subarray(0, Math.min(total, received)));
    offset = Math.min(total, received);
  }
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

/** Cuenta por clase IFC los elementos con geometría (excluye tipos, psets y relaciones). */
async function summarize(model: FRAGS.FragmentsModel): Promise<{ elementCount: number; classes: ClassCount[] }> {
  const counts = new Map<string, number>();
  for (const category of await model.getItemsWithGeometryCategories()) {
    if (category) counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  const classes: ClassCount[] = [...counts]
    .map(([category, count]) => ({ ifcClass: toIfcClassName(category), count }))
    .sort((a, b) => b.count - a.count || a.ifcClass.localeCompare(b.ifcClass));
  return { elementCount: classes.reduce((n, c) => n + c.count, 0), classes };
}

function attributeValue(data: FRAGS.ItemData | undefined, name: string): unknown {
  const entry = data?.[name];
  return entry && !Array.isArray(entry) ? entry.value : undefined;
}

function categoryName(item: FRAGS.ItemData | undefined): string {
  return toIfcClassName(String(attributeValue(item, "_category") ?? ""));
}

// IsDefinedBy trae tanto los psets (IfcRelDefinesByProperties) como el tipo (IfcRelDefinesByType).
function isTypeObject(item: FRAGS.ItemData): boolean {
  return /(TYPE|STYLE)$/.test(String(attributeValue(item, "_category") ?? ""));
}

function readPropertySets(definitions: FRAGS.ItemData[], suffix: string): PropertySetInfo[] {
  return definitions.map((definition) => {
    const children = definition.HasProperties ?? definition.Quantities;
    const properties: NameValue[] = Array.isArray(children)
      ? children.map((property) => ({
          name: String(attributeValue(property, "Name") ?? ""),
          value: formatValue(firstValue(property)),
        }))
      : [];
    return { name: `${attributeValue(definition, "Name") ?? ""}${suffix}`, properties };
  });
}

// Propiedades simples guardan el dato en NominalValue; cantidades en <Tipo>Value.
const VALUE_KEYS = ["NominalValue", "LengthValue", "AreaValue", "VolumeValue", "CountValue", "WeightValue", "TimeValue"];

function firstValue(item: FRAGS.ItemData): unknown {
  for (const key of VALUE_KEYS) {
    const value = attributeValue(item, key);
    if (value !== undefined) return value;
  }
  return undefined;
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "Sí" : "No";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(6)));
  if (Array.isArray(value)) return value.map(formatValue).join(", ");
  return String(value);
}
