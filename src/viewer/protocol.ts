// Contrato de mensajes entre la aplicación C# (host) y el visor.
// Debe mantenerse sincronizado con src/BimNormativeChecker.Core/Viewer/ViewerMessages.cs.

export const PROTOCOL_VERSION = 2;

/**
 * Versión de la caché de fragments (.frag). Cambiarla invalida las cachés existentes:
 * hay que hacerlo al actualizar @thatopen/fragments, web-ifc o la configuración del importador.
 */
export const FRAGMENTS_CACHE_VERSION = "fragments-3.4.7_web-ifc-0.0.77_v1";

/** Georreferencia del IFC (IfcMapConversion) para mostrar coordenadas de mapa. */
export interface Georeference {
  crsName: string | null;
  eastings: number;
  northings: number;
  height: number;
  xAxisAbscissa: number;
  xAxisOrdinate: number;
  /** IfcMapConversion.Scale (unidades del proyecto → unidades del mapa); 1 si no viene. */
  scale: number;
  /** Metros por unidad de longitud del proyecto (0,001 si el IFC está en mm). */
  lengthScale: number;
}

/** Mensajes que el host C# envía al visor. */
export type HostMessage =
  | { type: "loadModel"; modelId: string; url: string; name: string; format: "ifc" | "frag"; cacheKey?: string }
  | { type: "unloadModel"; modelId: string }
  | { type: "setModelVisibility"; modelId: string; visible: boolean }
  | { type: "setGeoreference"; modelId: string; georef: Georeference | null }
  | {
      type: "selectElements";
      modelId?: string;
      expressIds?: number[];
      globalIds?: string[];
      zoom?: boolean;
      isolate?: boolean;
    }
  | { type: "clearSelection" }
  | { type: "isolateSelection" }
  | { type: "showAll" }
  | { type: "fitAll" }
  | { type: "setTerritoryContext"; scene: TerritoryScene; keepView?: boolean }
  | {
      type: "placementState";
      open: boolean;
      /** "quick": colocación rápida en planta; "fine": ajuste fino. */
      mode: "quick" | "fine";
      step: number;
      center: string;
      rotation: string;
      elevation: string;
      error: string | null;
      rotationDegrees: number;
      /** Centro del modelo en coordenadas del modelo: pivote de los giros. */
      pivotX: number;
      pivotY: number;
      offset: string;
      confirmRequired: boolean;
      canUndo: boolean;
    }
  | { type: "placementHint"; suggest: boolean; message: string | null }
  | { type: "setEnvelope"; grid: EnvelopeGrid | null }
  | { type: "setRasantes"; scene: RasanteScene | null }
  | { type: "startParcelDrawing"; current: number[] | null }
  | { type: "territoryContextUnavailable"; reason: string };

/**
 * Escena territorial en coordenadas del modelo (IFC, m). X/Y relativas a origin (precisión); Z es cota del modelo.
 * Anillos y líneas: [x0, y0, x1, y1, …]; el primer anillo es el exterior.
 */
export interface TerritoryScene {
  origin: number[];
  terrain: { x0: number; y0: number; step: number; columns: number; rows: number; z: number[] };
  buildings: { rings: number[][]; base: number; height: number; heightSource: "dato" | "pisos" | "estimada" }[];
  roads: { points: number[]; kind: string; width: number }[];
  water: { rings: number[][] }[];
  green: { rings: number[][] }[];
  /** [x, y, z, x, y, z, …] */
  trees: number[];
  zones: { code: string; name: string; maxHeight: number | null; source: string | null; rings: number[][] }[];
  project: number[] | null;
  notes: string[];
  attribution: string;
  /** Relación modelo → mapa usada: [origenX, origenY, Este, Norte, cos, sen, escala, desfase Z]. */
  modelToWorld: number[] | null;
  /** Predio del proyecto (anillo relativo a origin) y el tipo de cada deslinde: "Vecino" | "Frente" | "AreaVerde". */
  parcel?: number[] | null;
  parcelKinds?: string[] | null;
}

/**
 * Rasantes de la revisión en coordenadas del modelo: cada línea sube hacia (inwardX, inwardY) con el ángulo de la región, desde
 * groundZ hasta topHeight sobre el suelo. critical: punto más comprometido de cada corte (altura y límite de la rasante ahí).
 */
export interface RasanteScene {
  angle: number;
  groundZ: number;
  topHeight: number;
  lines: { number: number; kind: string; ax: number; ay: number; bx: number; by: number; inwardX: number; inwardY: number }[];
  critical: { x: number; y: number; height: number; limit: number }[];
}

/**
 * Volumen teórico (cabida) en coordenadas del modelo: celda (i, j) centrada en (x0 + (i + ½)·step, y0 + (j + ½)·step),
 * altura heights[j·columns + i] sobre groundZ (0 = no edificable).
 */
export interface EnvelopeGrid {
  x0: number;
  y0: number;
  step: number;
  columns: number;
  rows: number;
  heights: number[];
  groundZ: number;
  volumeM3: number;
}

export interface NameValue {
  name: string;
  value: string;
}

export interface PropertySetInfo {
  name: string;
  properties: NameValue[];
}

export interface ElementInfo {
  modelId: string;
  expressId: number;
  globalId: string | null;
  ifcClass: string;
  name: string | null;
  /** Tipo asociado (IfcRelDefinesByType), p. ej. "Floor:Generic 300mm · IfcSlabType". */
  typeName: string | null;
  attributes: NameValue[];
  propertySets: PropertySetInfo[];
}

export interface ClassCount {
  ifcClass: string;
  count: number;
}

/** Mensajes que el visor envía al host C#. */
export type ViewerMessage =
  | { type: "ready"; protocolVersion: number; cacheVersion: string }
  | { type: "loadProgress"; modelId: string; stage: string; progress: number }
  | { type: "modelLoaded"; modelId: string; elementCount: number; classes: ClassCount[]; loadMs: number; fromCache: boolean }
  | { type: "loadFailed"; modelId: string; message: string }
  | { type: "fragmentsReady"; modelId: string; cacheKey: string; size: number }
  | { type: "fragmentsWritten"; modelId: string; cacheKey: string }
  /** Extensión del modelo en coordenadas IFC (m): [x, y, z] mínimos y máximos. */
  | { type: "modelExtent"; modelId: string; min: number[]; max: number[] }
  | { type: "selectionChanged"; count: number; element: ElementInfo | null }
  | { type: "selectionNotFound"; query: string }
  | { type: "log"; level: "info" | "warn" | "error"; message: string }
  // Las rutas las completa el host a partir de los File adjuntos (el visor no las conoce).
  | { type: "filesDropped" }
  | { type: "territoryContextRequested" }
  | { type: "georeferenceRequested" }
  /** Clic sobre un objeto: punto en coordenadas del modelo (IFC, m). */
  | { type: "pointPicked"; x: number; y: number; z: number }
  | { type: "parcelDrawn"; points: number[] }
  | { type: "placementCommand"; command: string; argument: string | null };
