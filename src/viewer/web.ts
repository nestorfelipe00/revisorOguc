// Entrada del visor para la web: reemplaza a main.ts (escritorio). Arma el visor That Open con sus herramientas dentro de un
// contenedor y expone una API para React; no hay host C#, así que los mensajes del protocolo se atienden aquí mismo.
import * as THREE from "three";
import { CSS2DObject } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import { BncViewer } from "./viewer";
import { ViewerTools } from "./tools";
import { Toolbar } from "./toolbar";
import { TerritoryContext } from "./territory";
import { TheoreticalVolume } from "./envelope";
import { RasantePlanes } from "./rasante";
import { ParcelDrawing } from "./parceldraw";
import { QuickPlacement } from "./quickplace";
import { PlacementPanel } from "./placement";
import type { ClassCount, ElementInfo, EnvelopeGrid, HostMessage, RasanteScene, TerritoryScene, ViewerMessage } from "./protocol";

export type PlacementState = Extract<HostMessage, { type: "placementState" }>;
import type { IfcMeta, MetaRequest, MetaResponse } from "./ifcMetaWorker";
import type { ModelExtent } from "@/lib/territorio/location";
import { propertyValues } from "./propiedades";

/** Límite de la versión web (advertencia b del plan): sobre este tamaño el IFC no se abre. */
export const MAX_IFC_BYTES = 100 * 1024 * 1024;

export interface LoadedModel {
  modelId: string;
  name: string;
  bytes: number;
  sha256: string;
  elementCount: number;
  classes: ClassCount[];
  loadMs: number;
  extent: ModelExtent | null;
  meta: IfcMeta | null;
  /** Fragments convertidos (para guardarlos en caché o en el proyecto). */
  fragments: Uint8Array | null;
  /** El archivo IFC original (se vuelve a leer para extraer la geometría de la revisión; no sale del navegador). */
  file: File;
}

export interface WebViewerEvents {
  onProgress(stage: string, progress: number, modelId: string): void;
  onModelsChanged(models: LoadedModel[]): void;
  onSelectionChanged(count: number, element: ElementInfo | null): void;
  onLog(level: "info" | "warn" | "error", message: string): void;
  onPointPicked(point: { x: number; y: number; z: number }): void;
  onParcelDrawn(points: number[]): void;
  /** El usuario pidió la ciudad 3D desde la barra del visor. */
  onCityRequested(): void;
  /** Orden de la colocación rápida o del ajuste fino (quick-open, open, quick, turn, move, raise, elevate, rotate, step, undo, accept, cancel, confirm, fine, more, ground). */
  onPlacementCommand(command: string, argument: string | null): void;
}

export class WebViewer {
  readonly viewer = new BncViewer();
  // Se crean en init(): ViewerTools captura viewer.world, que solo existe después de viewer.init().
  tools!: ViewerTools;
  toolbar!: Toolbar;
  city!: TerritoryContext;
  envelope!: TheoreticalVolume;
  rasantes!: RasantePlanes;
  parcelDrawing!: ParcelDrawing;
  quick!: QuickPlacement;
  placement!: PlacementPanel;
  private readonly models = new Map<string, LoadedModel>();
  private queue = Promise.resolve();
  private disposed = false;

  constructor(private readonly events: WebViewerEvents) {}

  async init(container: HTMLElement): Promise<void> {
    await this.viewer.init(container);
    if (this.disposed) return;
    this.viewer.onSelectionChanged = (count, element) => this.events.onSelectionChanged(count, element);
    this.tools = new ViewerTools(this.viewer);
    this.tools.init(container);
    this.toolbar = new Toolbar(container, this.viewer, this.tools);
    this.tools.onModeChanged = (mode, hint) => this.toolbar.setMode(mode, hint);
    this.tools.onStoreysChanged = (storeys) => this.toolbar.setStoreys(storeys);
    this.tools.onPointPicked = (point) => {
      this.toolbar.showPoint(point);
      if (point) this.events.onPointPicked({ x: point.local.x, y: point.local.y, z: point.local.z });
    };
    this.city = new TerritoryContext(this.viewer);
    const send = (message: ViewerMessage) => this.handleViewerMessage(message);
    this.parcelDrawing = new ParcelDrawing(this.viewer, container, send);
    this.quick = new QuickPlacement(this.viewer, container, send);
    this.placement = new PlacementPanel(container, send);
    this.toolbar.attachCity(this.city, () => this.events.onCityRequested());
    this.toolbar.attachPlacement(() => this.quick.open(), () => this.placement.open());
    this.envelope = new TheoreticalVolume(this.viewer);
    this.rasantes = new RasantePlanes(this.viewer);
    this.toolbar.attachEnvelope(this.envelope, this.rasantes);
    container.addEventListener("keydown", (e) => this.onKey(e));
    container.tabIndex = 0;
  }

  get list(): LoadedModel[] {
    return [...this.models.values()];
  }

  private handleViewerMessage(message: ViewerMessage): void {
    if (message.type === "parcelDrawn") this.events.onParcelDrawn(message.points);
    else if (message.type === "log") this.events.onLog(message.level, message.message);
    else if (message.type === "placementCommand") this.events.onPlacementCommand(message.command, message.argument);
  }

  /** Estado de la edición de la georreferencia: lo muestran la barra de colocación rápida y el panel de ajuste fino. */
  setPlacementState(state: PlacementState): void {
    this.placement.setState(state);
    this.quick.setState(state);
  }

  setPlacementHint(suggest: boolean, message: string | null): void {
    this.toolbar.setPlacementHint(suggest, message);
  }

  /** Quita la ciudad 3D del visor. */
  clearTerritory(): void {
    this.city.setVisible(false); // también oculta la leyenda y restaura el plano lejano de la cámara
    this.city.dispose();
    this.viewer.setGridVisible(true);
    this.toolbar.cityLoaded();
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(operation, operation);
    return this.queue;
  }

  /** Abre un IFC local. El archivo no sale del navegador. */
  loadFile(file: File): Promise<void> {
    return this.enqueue(async () => {
      if (file.size > MAX_IFC_BYTES) {
        this.events.onLog("error", `${file.name}: el modelo supera los 100 MB y no se puede abrir en la versión web. Use la versión de escritorio.`);
        return;
      }
      const modelId = `m${this.models.size + 1}-${Date.now().toString(36)}`;
      const started = performance.now();
      const url = URL.createObjectURL(file);
      try {
        const [result, bytes] = await Promise.all([
          this.viewer.loadModel(url, "ifc", modelId, (stage, progress) => this.events.onProgress(stage, progress, modelId)),
          file.arrayBuffer().then((b) => new Uint8Array(b)),
        ]);
        this.events.onProgress("Leyendo georreferencia", 0.5, modelId);
        const [sha256, meta] = await Promise.all([digest(bytes), readMeta(bytes).catch((e) => (this.events.onLog("warn", `Metadatos del IFC: ${errorMessage(e)}`), null))]);
        const extent = this.viewer.extentOf(modelId);
        this.models.set(modelId, {
          modelId,
          name: file.name,
          bytes: file.size,
          sha256,
          elementCount: result.elementCount,
          classes: result.classes,
          loadMs: Math.round(performance.now() - started),
          extent: extent ? { minX: extent.min[0], minY: extent.min[1], minZ: extent.min[2], maxX: extent.max[0], maxY: extent.max[1], maxZ: extent.max[2] } : null,
          meta,
          fragments: result.fragments,
          file,
        });
        if (meta?.geolocation.mapConversion) this.tools.setGeoreference(modelId, meta.geolocation.mapConversion);
      } catch (error) {
        this.events.onLog("error", `${file.name}: ${errorMessage(error)}`);
      } finally {
        URL.revokeObjectURL(url);
        this.events.onProgress("", 1, modelId);
        await this.afterModelsChanged();
      }
    });
  }

  unload(modelId: string): Promise<void> {
    return this.enqueue(async () => {
      await this.viewer.unloadModel(modelId);
      this.tools.forgetModel(modelId);
      this.models.delete(modelId);
      await this.afterModelsChanged();
    });
  }

  setVisible(modelId: string, visible: boolean): Promise<void> {
    return this.enqueue(() => this.viewer.setModelVisibility(modelId, visible));
  }

  async selectElements(query: { modelId?: string; expressIds?: number[]; globalIds?: string[] }, zoom = true, isolate = false): Promise<boolean> {
    return this.viewer.selectElements(query, zoom, isolate);
  }

  setEnvelope(grid: EnvelopeGrid | null): void {
    this.envelope.set(grid);
    this.toolbar.envelopeChanged();
  }

  setRasantes(scene: RasanteScene | null): void {
    this.rasantes.set(scene);
    this.toolbar.envelopeChanged(false);
  }

  setTerritory(scene: TerritoryScene, keepView = false): void {
    const first = !this.city.loaded;
    this.city.setScene(scene, keepView);
    this.toolbar.setEnabled(true);
    this.quick.onSceneApplied();
    // En la colocación rápida la vista se queda en su encuadre (isométrica o planta); si no, se muestra el entorno en perspectiva.
    if (first && this.quick.isActive) void this.quick.reframe();
    else if (first) this.city.frame();
    this.toolbar.cityLoaded();
  }

  startParcelDrawing(current: number[] | null): void {
    if (this.quick.isActive) {
      this.toolbar.notify("Termine primero la colocación rápida (Aceptar o Cancelar).");
      return;
    }
    void this.parcelDrawing.start(current);
  }

  /** No se pudo armar la ciudad 3D: la barra explica el motivo. */
  cityUnavailable(reason: string): void {
    this.toolbar.cityUnavailable(reason);
  }

  /**
   * Isométrica de la cabida para el informe: perspectiva desde el suroriente que encuadra el predio, el volumen teórico y las
   * rasantes, con las alturas máximas del PRC y la ciudad si está cargada. Renderiza al doble de resolución, dibuja encima las
   * etiquetas del predio (son HTML: no están en el lienzo) y devuelve un PNG como data URL. La vista del usuario queda como estaba.
   */
  async capturarIsometrica(): Promise<string> {
    if (!this.envelope.loaded) throw new Error("calcule primero la cabida 3D.");
    if (this.quick.isActive) throw new Error("termine primero la colocación rápida.");
    const world = this.viewer.world;
    const camera = world.camera;
    const controls = camera.controls;
    const renderer = world.renderer!.three;
    const saved = {
      projection: camera.projection.current,
      position: controls.getPosition(new THREE.Vector3()),
      target: controls.getTarget(new THREE.Vector3()),
      pixelRatio: renderer.getPixelRatio(),
      envelope: this.envelope.group.visible,
      rasantes: this.rasantes.group.visible,
      city: this.city.visible,
      heights: this.city.heightsVisible,
    };
    try {
      this.envelope.setVisible(true);
      this.rasantes.setVisible(true);
      if (this.city.loaded) {
        if (!saved.city) this.city.setVisible(true);
        this.city.setHeightsVisible(true);
      }
      if (saved.projection !== "Perspective") await camera.projection.set("Perspective");
      const box = new THREE.Box3().setFromObject(this.envelope.group);
      if (this.rasantes.loaded) box.union(new THREE.Box3().setFromObject(this.rasantes.group));
      const parcel = this.city.loaded ? this.city.group.getObjectByName("predio") : undefined;
      if (parcel) box.union(new THREE.Box3().setFromObject(parcel));
      const center = box.getCenter(new THREE.Vector3());
      const d = Math.max(box.getSize(new THREE.Vector3()).length(), 20);
      // Visor: X este, Y arriba, Z sur. Desde el suroriente: +X y +Z.
      await controls.setLookAt(center.x + d, center.y + d * 0.8, center.z + d, center.x, center.y, center.z, false);
      await controls.fitToSphere(box.getBoundingSphere(new THREE.Sphere()), false).catch(() => {});
      controls.update(0);
      await this.viewer.fragments.core.update(true);
      renderer.setPixelRatio(2);
      // Sin preserveDrawingBuffer el lienzo solo es legible justo después de renderizar: se copia en el mismo turno.
      renderer.render(world.scene.three, camera.three);
      const canvas = renderer.domElement;
      const out = document.createElement("canvas");
      out.width = canvas.width;
      out.height = canvas.height;
      const ctx = out.getContext("2d");
      if (!ctx) throw new Error("el navegador no permite componer la imagen.");
      ctx.drawImage(canvas, 0, 0);
      this.drawLabels(ctx, camera.three, out.width, out.height, out.width / Math.max(1, canvas.clientWidth));
      return out.toDataURL("image/png");
    } finally {
      renderer.setPixelRatio(saved.pixelRatio);
      this.envelope.setVisible(saved.envelope);
      this.rasantes.setVisible(saved.rasantes);
      if (this.city.loaded) {
        this.city.setHeightsVisible(saved.heights);
        if (!saved.city) this.city.setVisible(false);
      }
      if (saved.projection !== "Perspective") await camera.projection.set(saved.projection);
      const { position: p, target: t } = saved;
      await controls.setLookAt(p.x, p.y, p.z, t.x, t.y, t.z, false);
      controls.update(0);
      void this.viewer.fragments.core.update(true);
    }
  }

  /** Etiquetas CSS2D visibles (deslindes del predio, mediciones) dibujadas en la imagen, en su posición proyectada. */
  private drawLabels(ctx: CanvasRenderingContext2D, camera: THREE.Camera, width: number, height: number, scale: number): void {
    const v = new THREE.Vector3();
    ctx.font = `600 ${Math.round(12 * scale)}px "Segoe UI", Arial, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    this.viewer.world.scene.three.traverseVisible((object) => {
      if (!(object instanceof CSS2DObject)) return;
      object.getWorldPosition(v).project(camera);
      if (v.z < -1 || v.z > 1) return;
      const parts = [...object.element.children].map((c) => c.textContent?.trim() ?? "").filter((t) => t !== "");
      const text = parts.length > 0 ? parts.join(" · ") : (object.element.textContent?.trim() ?? "");
      if (!text) return;
      const x = ((v.x + 1) / 2) * width;
      const y = ((1 - v.y) / 2) * height;
      const w = ctx.measureText(text).width + 12 * scale;
      const h = 20 * scale;
      ctx.beginPath();
      ctx.roundRect(x - w / 2, y - h / 2, w, h, 4 * scale);
      ctx.fillStyle = "rgba(255, 255, 255, 0.92)";
      ctx.fill();
      ctx.lineWidth = 2 * scale;
      ctx.strokeStyle = object.element.style.getPropertyValue("--tag") || "#1b1f23";
      ctx.stroke();
      ctx.fillStyle = "#1b1f23";
      ctx.fillText(text, x, y);
    });
  }

  /** Resistencia al fuego declarada (propiedad FireRating) de los elementos indicados, por ExpressID. */
  async fireRatings(modelId: string, expressIds: number[]): Promise<Map<number, string>> {
    const model = this.viewer.fragments.list.get(modelId);
    if (!model) return new Map();
    return propertyValues(model, expressIds, "FireRating");
  }

  private async afterModelsChanged(): Promise<void> {
    this.toolbar.setEnabled(this.viewer.modelCount > 0);
    if (this.viewer.modelCount === 0 && (this.envelope.loaded || this.rasantes.loaded)) {
      this.envelope.set(null);
      this.rasantes.set(null);
      this.toolbar.envelopeChanged();
    }
    try {
      await this.tools.refreshStoreys();
    } catch (error) {
      this.events.onLog("warn", `No se pudieron preparar las plantas por piso: ${errorMessage(error)}`);
    }
    this.events.onModelsChanged(this.list);
  }

  private onKey(e: KeyboardEvent): void {
    if ((e.target as HTMLElement).closest("input, textarea")) return;
    if (e.key === "Escape") {
      if (this.tools.currentMode !== "select") this.tools.setMode("select");
      else if (this.tools.activeStorey) this.tools.closeStorey();
      else void this.viewer.clearSelection();
    } else if (e.key === "Delete" || e.key === "Backspace") {
      void this.tools.deleteUnderCursor();
    } else if (e.key === "f" || e.key === "F") {
      this.viewer.fitAll();
    }
  }

  dispose(): void {
    this.disposed = true;
    // Las herramientas enganchan escuchadores en window y elementos en document.body: sin esto quedarían instancias zombi.
    this.quick?.dispose();
    this.placement?.dispose();
    this.parcelDrawing?.dispose();
    try {
      this.viewer.components.dispose();
    } catch {
      // El visor puede no haber terminado de iniciarse.
    }
  }
}

async function digest(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function readMeta(bytes: Uint8Array): Promise<IfcMeta> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./ifcMetaWorker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<MetaResponse>) => {
      worker.terminate();
      if (event.data.type === "done") resolve(event.data.meta);
      else reject(new Error(event.data.message));
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message || "No se pudo leer el IFC en segundo plano."));
    };
    const request: MetaRequest = { bytes, wasmPath: new URL("/wasm/", location.origin).href };
    worker.postMessage(request);
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
