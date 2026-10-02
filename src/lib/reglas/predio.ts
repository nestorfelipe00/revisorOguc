// Porte de Core/Territory/Parcel.cs (superficie, largos, orientación y lectura validada del JSON guardado) y de
// Infrastructure/Gis/ParcelImporter.cs (GeoJSON del predio, predio dibujado y predio rectangular). En la web no hay base de
// ciudad: los tipos de deslinde no se proponen por cercanía a calles; sin «deslindes» declarados todos quedan como vecino y los
// frentes los fija el usuario en la ventana Deslindes.
import { z } from "zod";
import { fromGeographic, toGeographic, zoneFor, type GeoPoint } from "@/lib/territorio/utm";
import type { BoundaryKind, Parcel, ParcelEdge } from "./tipos";

/** Entrada que puede venir de terceros y no sirve: se informa con un mensaje claro, nunca con una excepción inesperada. */
export class InvalidDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidDataError";
  }
}

const utmRing = (vertices: GeoPoint[]) => {
  const zone = zoneFor(vertices[0].longitude);
  return vertices.map((v) => fromGeographic(v, zone));
};

const signedArea2 = (p: { easting: number; northing: number }[]): number => {
  let area = 0;
  for (let k = 0; k < p.length; k++) {
    const a = p[k];
    const b = p[(k + 1) % p.length];
    area += a.easting * b.northing - b.easting * a.northing;
  }
  return area;
};

/** Superficie en m² (plano UTM, suficiente a escala de predio). */
export const parcelArea = (parcel: Parcel): number => Math.abs(signedArea2(utmRing(parcel.vertices))) / 2;

/** Largo del deslinde i en metros, en el plano UTM (el mismo de la revisión y de parcelArea). */
export function edgeLength(parcel: Parcel, i: number): number {
  const zone = zoneFor(parcel.vertices[0].longitude);
  const a = fromGeographic(parcel.vertices[i], zone);
  const b = fromGeographic(parcel.vertices[(i + 1) % parcel.vertices.length], zone);
  return Math.hypot(b.easting - a.easting, b.northing - a.northing);
}

const ORIENTATIONS = ["Norte", "Nororiente", "Oriente", "Suroriente", "Sur", "Surponiente", "Poniente", "Norponiente"];

/** Orientación del deslinde i hacia afuera del predio (Norte, Nororiente…), como en las inscripciones. */
export function orientation(parcel: Parcel, i: number): string {
  const p = utmRing(parcel.vertices);
  const area = signedArea2(p);
  const a = p[i];
  const b = p[(i + 1) % p.length];
  const dx = b.easting - a.easting;
  const dy = b.northing - a.northing;
  // Normal hacia afuera: a la derecha si el anillo es antihorario, a la izquierda si es horario.
  const [nx, ny] = area > 0 ? [dy, -dx] : [-dy, dx];
  const bearing = ((Math.atan2(nx, ny) * 180) / Math.PI + 360) % 360;
  return ORIENTATIONS[Math.round(bearing / 45) % 8];
}

// ---------- JSON guardado (mismo camelCase que Parcel.ToJson del escritorio) ----------

const KINDS: Record<string, BoundaryKind> = { vecino: "Vecino", frente: "Frente", areaverde: "AreaVerde" };

const kindSchema = z.preprocess(
  (v) => (typeof v === "string" ? (KINDS[v.toLowerCase()] ?? v) : v),
  z.enum(["Vecino", "Frente", "AreaVerde"]),
);

const edgeSchema = z.object({
  kind: kindSchema,
  officialLinesWidth: z.number().finite().nullable().optional(),
  label: z.string().nullable().optional(),
});

const parcelSchema = z
  .object({
    vertices: z
      .array(z.object({ latitude: z.number().min(-56).max(-17), longitude: z.number().min(-76).max(-66) }))
      .min(3)
      .max(500),
    edges: z.array(edgeSchema),
    naturalGroundZ: z.number().min(-500).max(6000),
    source: z.string(),
    groundConfirmed: z.boolean().optional(),
    positionConfirmed: z.boolean().optional(),
  })
  .refine((p) => p.edges.length === p.vertices.length, { message: "Debe haber un deslinde por vértice." });

export const parcelToJson = (parcel: Parcel): string => JSON.stringify(parcel);

/**
 * Predio guardado (JSON camelCase). Null si el texto no es un predio válido: 3 a 500 vértices dentro de Chile, un deslinde por
 * vértice y suelo natural entre −500 y 6 000 m.
 */
export function parcelFromJson(json: string | null | undefined): Parcel | null {
  if (json === null || json === undefined || json.trim() === "") return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  const parsed = parcelSchema.safeParse(raw);
  if (!parsed.success) return null;
  const p = parsed.data;
  return {
    vertices: p.vertices.map((v) => ({ latitude: v.latitude, longitude: v.longitude })),
    edges: p.edges.map((e) => ({ kind: e.kind, officialLinesWidth: e.officialLinesWidth ?? null, label: e.label ?? null })),
    naturalGroundZ: p.naturalGroundZ,
    source: p.source,
    groundConfirmed: p.groundConfirmed ?? false,
    positionConfirmed: p.positionConfirmed ?? false,
  };
}

// ---------- Importación desde GeoJSON (EPSG:4326, un polígono) ----------

type JsonObject = Record<string, unknown>;

const isObject = (v: unknown): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);

const NO_POLYGON = "El GeoJSON no contiene un polígono de predio.";

const isPosition = (p: unknown): p is number[] => Array.isArray(p) && p.length >= 2 && typeof p[0] === "number" && typeof p[1] === "number";

/** Anillo exterior de un polígono GeoJSON (cerrado, como exige NetTopologySuite al leerlo). */
function exteriorRing(polygon: unknown): number[][] {
  if (!Array.isArray(polygon) || polygon.length === 0 || !Array.isArray(polygon[0])) throw new InvalidDataError(NO_POLYGON);
  const ring = polygon[0] as unknown[];
  if (!ring.every(isPosition) || ring.length < 4) throw new InvalidDataError(NO_POLYGON);
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) throw new InvalidDataError("El anillo del predio no está cerrado (el último vértice debe repetir el primero).");
  return ring;
}

const ringArea = (ring: number[][]): number => {
  let area = 0;
  for (let k = 0; k < ring.length - 1; k++) area += ring[k][0] * ring[k + 1][1] - ring[k + 1][0] * ring[k][1];
  return Math.abs(area) / 2;
};

/** Anillo exterior del polígono de una geometría: el único de un Polygon o el mayor de un MultiPolygon. */
function polygonRing(geometry: unknown): number[][] | null {
  if (!isObject(geometry)) return null;
  if (geometry.type === "Polygon") return exteriorRing(geometry.coordinates);
  if (geometry.type === "MultiPolygon") {
    if (!Array.isArray(geometry.coordinates)) throw new InvalidDataError(NO_POLYGON);
    const rings = geometry.coordinates.map(exteriorRing);
    if (rings.length === 0) throw new InvalidDataError(NO_POLYGON);
    return rings.reduce((best, r) => (ringArea(r) > ringArea(best) ? r : best));
  }
  return null;
}

const isPolygonal = (geometry: unknown): boolean => isObject(geometry) && (geometry.type === "Polygon" || geometry.type === "MultiPolygon");

/**
 * Importa el predio desde GeoJSON (EPSG:4326, un polígono: Feature, FeatureCollection o Polygon/MultiPolygon). Propiedades
 * opcionales: deslindes (lista con tipo vecino | frente | area_verde, ancho_lineas_oficiales y colindante, en el orden del anillo),
 * suelo_natural_z y suelo_natural_confirmado.
 */
export function importParcelGeoJson(text: string, fileName: string): Parcel {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    throw new InvalidDataError("El archivo no es GeoJSON válido: no se pudo leer como JSON.");
  }
  // El archivo puede venir de terceros: sin "type" de texto no es GeoJSON (se informa, no se cae).
  if (!isObject(root) || typeof root.type !== "string") {
    throw new InvalidDataError('El archivo no es GeoJSON válido: falta el campo "type" (Feature, FeatureCollection o Polygon).');
  }
  let geometry: unknown;
  let properties: JsonObject | null = null;
  switch (root.type) {
    case "FeatureCollection": {
      const features = Array.isArray(root.features) ? root.features : [];
      const feature = features.find((f) => isObject(f) && isPolygonal(f.geometry));
      if (!isObject(feature)) throw new InvalidDataError(NO_POLYGON);
      geometry = feature.geometry;
      properties = isObject(feature.properties) ? feature.properties : null;
      break;
    }
    case "Feature":
      geometry = root.geometry;
      properties = isObject(root.properties) ? root.properties : null;
      break;
    default:
      geometry = root;
      break;
  }
  const ring = polygonRing(geometry);
  if (ring === null) throw new InvalidDataError(NO_POLYGON);
  const vertices = ring.slice(0, ring.length - 1).map((c) => ({ latitude: c[1], longitude: c[0] }));
  if (vertices.length < 3) throw new InvalidDataError("El polígono del predio tiene menos de tres vértices.");
  if (vertices.some((v) => v.latitude < -90 || v.latitude > 90 || v.longitude < -180 || v.longitude > 180)) {
    throw new InvalidDataError("Las coordenadas no son latitud/longitud (EPSG:4326). Exporte el predio en WGS 84.");
  }
  return fromAttributes(vertices, properties, fileName);
}

/** Predio dibujado a mano (lon/lat): todos los deslindes quedan como vecino hasta que el usuario marque los frentes. */
export function parcelFromVertices(vertices: GeoPoint[], source: string): Parcel {
  if (vertices.length < 3) throw new InvalidDataError("El predio necesita al menos tres vértices.");
  return fromAttributes([...vertices], null, source);
}

function fromAttributes(vertices: GeoPoint[], attributes: JsonObject | null, name: string): Parcel {
  const declared = readEdges(attributes, vertices.length);
  const edges = declared ?? vertices.map((): ParcelEdge => ({ kind: "Vecino", officialLinesWidth: null, label: null }));
  const ground = attributeNumber(attributes, "suelo_natural_z") ?? 0;
  const groundConfirmed = attributes?.suelo_natural_confirmado === true;
  const source = declared === null ? `${name} (sin tipos de deslinde declarados: todos como vecino; marque los frentes)` : name;
  return { vertices, edges, naturalGroundZ: ground, source, groundConfirmed, positionConfirmed: false };
}

function readEdges(attributes: JsonObject | null, count: number): ParcelEdge[] | null {
  const list = attributes?.deslindes;
  if (!Array.isArray(list)) return null;
  const edges: ParcelEdge[] = [];
  for (const item of list) {
    if (!isObject(item)) return null;
    let kind: BoundaryKind;
    switch (String(item.tipo ?? "vecino").toLowerCase()) {
      case "frente":
        kind = "Frente";
        break;
      case "area_verde":
      case "área verde":
      case "area verde":
        kind = "AreaVerde";
        break;
      default:
        kind = "Vecino";
    }
    const label = item.colindante === null || item.colindante === undefined ? null : String(item.colindante);
    edges.push({ kind, officialLinesWidth: attributeNumber(item, "ancho_lineas_oficiales"), label });
  }
  return edges.length === count ? edges : null;
}

const attributeNumber = (attributes: JsonObject | null, name: string): number | null => {
  const v = attributes?.[name];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
};

// ---------- Predio rectangular ----------

const fmt = (value: number, decimals: number): string =>
  value.toLocaleString("es-CL", { minimumFractionDigits: 0, maximumFractionDigits: decimals, useGrouping: false });

/**
 * Predio rectangular centrado en center: front m a lo largo del frente y depth m de fondo. El frente mira a bearingDegrees grados
 * desde el norte o, sin él, al sur (en la web no hay base de ciudad con calles cercanas: la orientación la fija el usuario).
 */
export function rectangleParcel(center: GeoPoint, front: number, depth: number, bearingDegrees: number | null): { parcel: Parcel; orientation: string } {
  let ux: number;
  let uy: number;
  let orientation: string;
  if (bearingDegrees !== null) {
    ux = Math.sin((bearingDegrees * Math.PI) / 180);
    uy = Math.cos((bearingDegrees * Math.PI) / 180);
    orientation = `frente hacia ${fmt(bearingDegrees, 1)}° desde el norte`;
  } else {
    ux = 0;
    uy = -1;
    orientation = "sin orientación indicada: frente hacia el sur";
  }
  // Anillo antihorario que parte por el frente: su normal hacia afuera es la dirección hacia la calle.
  const tx = -uy;
  const ty = ux;
  const c = fromGeographic(center);
  const at = (along: number, towardStreet: number): GeoPoint =>
    toGeographic({ ...c, easting: c.easting + tx * along + ux * towardStreet, northing: c.northing + ty * along + uy * towardStreet });
  const vertices = [at(-front / 2, depth / 2), at(front / 2, depth / 2), at(front / 2, -depth / 2), at(-front / 2, -depth / 2)];
  const vecino: ParcelEdge = { kind: "Vecino", officialLinesWidth: null, label: null };
  const edges: ParcelEdge[] = [{ kind: "Frente", officialLinesWidth: null, label: "calle (propuesto)" }, vecino, { ...vecino }, { ...vecino }];
  const parcel: Parcel = {
    vertices,
    edges,
    naturalGroundZ: 0,
    source: `Predio rectangular ${fmt(front, 2)} × ${fmt(depth, 2)} m (${orientation})`,
    groundConfirmed: false,
    positionConfirmed: false,
  };
  return { parcel, orientation };
}
