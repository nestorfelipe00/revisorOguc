// Entrada del visor para la web: reemplaza a main.ts (escritorio). Arma el visor That Open con sus herramientas dentro de un
// contenedor y expone una API para React; no hay host C#, así que los mensajes del protocolo se atienden aquí mismo.
import { BncViewer } from "./viewer";
import { ViewerTools } from "./tools";
import { Toolbar } from "./toolbar";
import { TerritoryContext } from "./territory";
import { TheoreticalVolume } from "./envelope";
import { RasantePlanes } from "./rasante";
import { ParcelDrawing } from "./parceldraw";
import type { ClassCount, ElementInfo, EnvelopeGrid, RasanteScene, TerritoryScene, ViewerMessage } from "./protocol";
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
    this.toolbar.attachCity(this.city, () => this.events.onCityRequested());
    this.toolbar.attachPlacement(
      () => this.events.onLog("info", "Colocación rápida: disponible en una próxima versión web."),
      () => this.events.onLog("info", "Ajuste fino: disponible en una próxima versión web."),
    );
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
    if (first) this.city.frame();
    this.toolbar.cityLoaded();
  }

  startParcelDrawing(current: number[] | null): void {
    void this.parcelDrawing.start(current);
  }

  /** No se pudo armar la ciudad 3D: la barra explica el motivo. */
  cityUnavailable(reason: string): void {
    this.toolbar.cityUnavailable(reason);
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
