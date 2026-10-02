// Contrato de la revisión normativa en la web. Porte de Core/Rules/RuleResult.cs, Core/Territory/Parcel.cs y de los
// records de Infrastructure/Rules/GeometricRuleEngine.cs, ModelGeometry.cs y CabidaStudy.cs del escritorio.
// Todo lo que cruza un Web Worker es serializable por structured clone: geometrías como GeoJSON (coordenadas del
// modelo, metros) y nubes de puntos como Float32Array.
import type { GeoPoint } from "@/lib/territorio/utm";

// ---------- Resultado de una regla ----------

/** Nunca se da «Cumple» si el resultado depende de un supuesto no comprobado. */
export type RuleState = "Cumple" | "NoCumple" | "RevisionRequerida" | "NoVerificable" | "NoAplica" | "Informativo";

export const RULE_STATE_LABELS: Record<RuleState, string> = {
  Cumple: "Cumple",
  NoCumple: "No cumple",
  RevisionRequerida: "Revisión requerida",
  NoVerificable: "No verificable",
  NoAplica: "No aplica",
  Informativo: "Informativo",
};

/** Fuente normativa verificada: documento, artículo (y página), texto literal, versión y enlace. */
export interface NormSource {
  document: string;
  article: string;
  quote: string;
  version?: string | null;
  url?: string | null;
  page?: number | null;
}

export const citation = (s: NormSource): string => (s.page != null ? `${s.document}, ${s.article}, p. ${s.page}` : `${s.document}, ${s.article}`);

/** Elemento del modelo involucrado en un resultado, con su valor (p. ej. exceso en metros) y detalle. */
export interface ElementFinding {
  modelId: string;
  expressId: number;
  globalId: string | null;
  ifcClass: string;
  name: string | null;
  value: number;
  detail: string;
}

/** Resultado trazable de una regla (contrato del informe bnc-report/1). */
export interface RuleResult {
  id: string;
  title: string;
  state: RuleState;
  summary: string;
  required: string | null;
  measured: string | null;
  sources: NormSource[];
  elements: ElementFinding[];
  notes: string[];
}

// ---------- Predio ----------

/** Tipo de deslinde según cómo se aplican las rasantes (OGUC 2.6.3). */
export type BoundaryKind = "Vecino" | "Frente" | "AreaVerde";

/** Deslinde i del predio (del vértice i al i + 1). officialLinesWidth: ancho entre líneas oficiales (solo frentes; CIP o PRC). */
export interface ParcelEdge {
  kind: BoundaryKind;
  officialLinesWidth: number | null;
  label: string | null;
}

/**
 * Predio del proyecto: vértices en lon/lat (sin repetir el primero), el tipo de cada deslinde, la cota del suelo natural en Z del
 * modelo y de dónde se obtuvo. groundConfirmed y positionConfirmed los declara el usuario: sin ellos ninguna regla que dependa de
 * esos datos da «Cumple». Mismo JSON (camelCase) que Parcel.ToJson del escritorio.
 */
export interface Parcel {
  vertices: GeoPoint[];
  edges: ParcelEdge[];
  naturalGroundZ: number;
  source: string;
  groundConfirmed: boolean;
  positionConfirmed: boolean;
}

// ---------- Geometrías (GeoJSON en coordenadas del modelo, metros) ----------

export interface Polygon2D {
  type: "Polygon";
  coordinates: number[][][];
}

export interface MultiPolygon2D {
  type: "MultiPolygon";
  coordinates: number[][][][];
}

export interface LineString2D {
  type: "LineString";
  coordinates: number[][];
}

export interface MultiLineString2D {
  type: "MultiLineString";
  coordinates: number[][][];
}

export type Area2D = Polygon2D | MultiPolygon2D;

export type Geometry2D = Polygon2D | MultiPolygon2D | LineString2D | MultiLineString2D;

// ---------- Geometría del IFC ----------

/** Versión del extractor de geometría web; cambia cuando cambia lo que produce (invalida la caché). */
export const GEOMETRY_VERSION = "w3";

/** Geometría de un elemento (coordenadas del modelo, m): caja, huella en planta, puntos de su malla y piso. */
export interface ElementGeometry {
  expressId: number;
  globalId: string | null;
  ifcClass: string;
  name: string | null;
  storeyName: string | null;
  storeyElevation: number | null;
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  zMin: number;
  zMax: number;
  /** Unión de los triángulos proyectados en planta; null si no tiene malla. */
  footprint: Area2D | null;
  /** [x, y, z, x, y, z, …] */
  points: Float32Array;
  /** Los puntos son una muestra (malla muy densa). */
  sampled: boolean;
}

/** Ventanas, puertas, muros cortina y huecos en muros: fachada con vano para la tabla de distanciamientos. */
export const isOpening = (e: ElementGeometry): boolean =>
  isVoid(e) || ["IfcWindow", "IfcDoor", "IfcCurtainWall", "IfcWindowStandardCase", "IfcDoorStandardCase"].includes(e.ifcClass);

/** Hueco en un muro sin ventana ni puerta (IfcOpeningElement): cuenta como vano, pero no es volumen construido. */
export const isVoid = (e: ElementGeometry): boolean => e.ifcClass === "IfcOpeningElement";

export interface ModelGeometry {
  modelId: string;
  elements: ElementGeometry[];
}

// ---------- Entrada del motor ----------

/** Parte del predio en una zona del PRC, en coordenadas del modelo. */
export interface ZonePart {
  code: string;
  area: Area2D;
}

/** Afectación según las capas del PRC, en coordenadas del modelo: polígono (plaza, parque) o línea de faja vial. */
export interface PublicUseArea {
  kind: string;
  name: string;
  geometry: Geometry2D;
}

/** Clave de fireRatings: `${modelId}:${expressId}`. */
export const fireRatingKey = (modelId: string, expressId: number): string => `${modelId}:${expressId}`;

/**
 * Datos de una revisión: predio en coordenadas del modelo, norma de la zona y geometría de los modelos.
 * zoneParts: partes del predio en cada zona del PRC (art. 2.1.21); si falta, todo el predio es de zoneCode.
 */
export interface RuleInput {
  lotRing: { x: number; y: number }[];
  edges: ParcelEdge[];
  groundZ: number;
  groundConfirmed: boolean;
  positionConfirmed: boolean;
  zoneCode: string | null;
  region: string | null;
  isExtension: boolean;
  models: ModelGeometry[];
  zoneParts?: ZonePart[] | null;
  publicUse?: PublicUseArea[] | null;
  fireRatings?: Record<string, string> | null;
  isSubdivision?: boolean;
  /** Nombre de las capas del PRC de las que salen publicUse (para citarlas en R-11). */
  publicUseLayers?: string | null;
  reviewSuspended?: string | null;
}

// ---------- Salida del motor ----------

/** Volumen teórico (cabida) como grilla de alturas sobre el suelo, en coordenadas del modelo. */
export interface TheoreticalVolume {
  x0: number;
  y0: number;
  step: number;
  columns: number;
  rows: number;
  /** heights[j·columns + i] sobre groundZ (0 = no edificable). */
  heights: Float32Array;
  groundZ: number;
  volumeM3: number;
  buildableArea: number;
}

/**
 * Línea desde donde se levanta una rasante (coordenadas del modelo): el deslinde con un vecino o un área verde, o el eje entre
 * líneas oficiales en un frente (a offset m hacia afuera del deslinde). La rasante sube hacia el interior (inward).
 */
export interface RasanteLine {
  number: number;
  kind: BoundaryKind;
  ax: number;
  ay: number;
  bx: number;
  by: number;
  offset: number;
  inwardX: number;
  inwardY: number;
}

/** Tramo de un elemento cortado por la sección: de s0 a s1 m desde la línea de rasante, entre bottom y top m sobre el suelo. */
export interface SectionBlock {
  s0: number;
  s1: number;
  bottom: number;
  top: number;
}

/** Corte perpendicular a una línea de rasante por el punto más comprometido; s es la distancia horizontal desde la línea. */
export interface RasanteSection {
  line: RasanteLine;
  originX: number;
  originY: number;
  length: number;
  blocks: SectionBlock[];
  criticalS: number;
  criticalHeight: number;
  criticalElement: string | null;
}

export const rasanteLimit = (s: RasanteSection, angle: number): number => Math.tan((angle * Math.PI) / 180) * s.criticalS;

export const rasanteExcess = (s: RasanteSection, angle: number): number => s.criticalHeight - rasanteLimit(s, angle);

/** Rasantes aplicadas en la revisión: ángulo, suelo, altura de la zona, líneas y un corte por cada línea. */
export interface RasanteGeometry {
  angle: number;
  groundZ: number;
  zoneHeight: number | null;
  lines: RasanteLine[];
  sections: RasanteSection[];
}

export interface RuleEvaluation {
  results: RuleResult[];
  volume: TheoreticalVolume | null;
  lotArea: number;
  rasantes: RasanteGeometry | null;
}

/** Planta posible en un piso del estudio de cabida: de base a top m sobre el suelo natural. */
export interface CabidaFloor {
  number: number;
  base: number;
  top: number;
  envelopeArea: number;
  area: number;
}

export interface CabidaEvaluation extends RuleEvaluation {
  floors: CabidaFloor[];
  buildableArea: number;
}

// ---------- Cabida preliminar (edificio de departamentos) ----------

/**
 * De dónde sale un dato: la ficha de la zona (PRC), la OGUC, el CIP que indica el usuario, un supuesto editable, el polígono del
 * predio, la cabida 3D, o falta (el resultado que lo usa queda «Revisión requerida»).
 */
export type OrigenDato = "PRC" | "OGUC" | "CIP" | "Supuesto" | "Predio" | "Cabida3D" | "Faltante";

/** Dato de entrada con su origen y, si es normativo, su fuente literal; advertencia: la ficha trae la cifra con una salvedad. */
export interface DatoCabida {
  valor: number | null;
  origen: OrigenDato;
  fuente: NormSource | null;
  advertencia: string | null;
}

/** Un paso del desarrollo matemático: fórmula → valores sustituidos → resultado, con su fuente o el supuesto que usa. */
export interface PasoDesarrollo {
  concepto: string;
  formula: string;
  sustitucion: string;
  resultado: number | null;
  unidad: string;
  fuentes: NormSource[];
  supuestos: string[];
}

/** Resultado de la cabida preliminar (CP-01…CP-06): nunca «Cumple»; «Revisión requerida» si falta un dato. */
export interface ItemCabida {
  id: string;
  titulo: string;
  estado: RuleState;
  resumen: string;
  valor: number | null;
  unidad: string;
  desarrollo: PasoDesarrollo[];
  fuentes: NormSource[];
  notas: string[];
}

/** Qué limita el número de departamentos. */
export type TopeDepartamentos = "superficie" | "densidad" | "altura" | "volumen";

/** Piso de la cabida preliminar: superficie construida y útil, departamentos y mezcla sugerida [1D, 2D, 3D]. */
export interface PisoCabidaPreliminar {
  numero: number;
  base: number;
  top: number;
  superficie: number;
  util: number;
  departamentos: number;
  mezcla: [number, number, number];
}

/** Restricción adicional con su cita (rasantes, distanciamientos, antejardín, cesiones, estacionamientos). */
export interface RestriccionCabida {
  id: string;
  titulo: string;
  estado: RuleState;
  texto: string;
  fuentes: NormSource[];
}

/** Datos ya resueltos de la cabida preliminar (normas con su origen, supuestos y, si se calculó, el volumen de la cabida 3D). */
export interface EntradaCabidaPreliminar {
  superficiePredio: number;
  zona: string | null;
  ocupacion: DatoCabida;
  constructibilidad: DatoCabida;
  alturaMetros: DatoCabida;
  alturaPisos: DatoCabida;
  /** La ficha no fija altura máxima («sin tope»): la limitan las rasantes (solo la cabida 3D la resuelve). */
  alturaLibre: boolean;
  /** hab/ha; con densidadLibre la Ordenanza no fija densidad (declarado por el usuario desde el CIP). */
  densidad: DatoCabida;
  densidadLibre: boolean;
  antejardin: DatoCabida;
  razonEstacionamientos: DatoCabida;
  pisoAPiso: number;
  m2Departamento: number;
  mezcla: [number, number, number];
  /** Fracción de la superficie construible en circulaciones y muros (supuesto editable). */
  circulaciones: number;
  habPorVivienda: number;
  m2Estacionamiento: number;
  /** anchoMaximoFrente: sobre ese ancho entre líneas oficiales no hay rasante en el frente (art. 2.6.3). */
  rasante: { angulo: number | null; region: string | null; fuentes: NormSource[]; advertencia: string | null; anchoMaximoFrente: number };
  distanciamientos: { tabla: { upTo: number | null; withOpening: number; withoutOpening: number }[]; fuente: NormSource };
  adosamiento: { largoPct: number; altura: number; angulo: number; fuentes: NormSource[] };
  definiciones: { ocupacion: NormSource | null; constructibilidad: NormSource | null };
  alturaMinimaPisoCielo: { metros: number; fuente: NormSource };
  /** Plantas que admite el volumen teórico de la cabida 3D (envolvente de cada piso), o null si no se calculó. */
  volumen: { numero: number; base: number; top: number; envolvente: number }[] | null;
  notasZona: string[];
}

export interface CabidaPreliminar {
  entrada: EntradaCabidaPreliminar;
  /** CP-01 construible, CP-02 ocupación, CP-03 útil, CP-04 departamentos, CP-05 pisos, CP-06 estacionamientos. */
  items: ItemCabida[];
  tope: TopeDepartamentos | null;
  pisos: PisoCabidaPreliminar[];
  restricciones: RestriccionCabida[];
  construible: number | null;
  ocupacion: number | null;
  util: number | null;
  departamentos: number | null;
  numeroPisos: number | null;
  alturaEdificio: number | null;
  estacionamientos: number | null;
  superficieEstacionamientos: number | null;
}
