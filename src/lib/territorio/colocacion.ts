// Porte de Core/Territory/UserPlacement.cs (y MapCrs de Utm.cs) y de LocationResolver.FromPlacement / Site:
// georreferencia definida por el usuario con la semántica de IfcMapConversion. Coordenadas del modelo en metros.
import { fromGeographic, toGeographic, type GeoPoint, type UtmPoint } from "./utm";
import {
  buildLocation,
  frameToUtm,
  hasSite,
  isSiteOutsideChile,
  placedFrame,
  type ModelExtent,
  type ModelFrame,
  type ModelGeolocation,
  type ProjectLocation,
} from "./location";

/** Sistema de referencia de mapa ofrecido al georreferenciar (UTM en Chile continental). */
export interface MapCrs {
  name: string;
  description: string;
  geodeticDatum: string;
  zone: number;
}

export const MAP_CRS_CHILE: readonly MapCrs[] = [
  { name: "EPSG:32719", description: "WGS 84 / UTM zone 19S", geodeticDatum: "WGS84", zone: 19 },
  { name: "EPSG:5361", description: "SIRGAS-Chile / UTM zone 19S", geodeticDatum: "SIRGAS-Chile", zone: 19 },
  { name: "EPSG:32718", description: "WGS 84 / UTM zone 18S", geodeticDatum: "WGS84", zone: 18 },
  { name: "EPSG:5362", description: "SIRGAS-Chile / UTM zone 18S", geodeticDatum: "SIRGAS-Chile", zone: 18 },
];

export const crsFor = (name: string | null | undefined, zone: number): MapCrs =>
  MAP_CRS_CHILE.find((c) => c.name === name) ?? MAP_CRS_CHILE.find((c) => c.zone === zone && c.geodeticDatum === "WGS84") ?? MAP_CRS_CHILE[0];

/**
 * El origen del modelo (0, 0, 0) queda en (Este, Norte) del mapa, el eje X del modelo gira rotationDegrees en sentido
 * antihorario desde el Este y Z = 0 está a la cota elevation (null: apoyado en el terreno). Mismo JSON que el escritorio.
 */
export interface UserPlacement {
  easting: number;
  northing: number;
  elevation: number | null;
  rotationDegrees: number;
  crsName: string;
  zone: number;
}

const rad = (degrees: number) => (degrees * Math.PI) / 180;

export const placementFrame = (p: UserPlacement): ModelFrame => ({
  originX: 0,
  originY: 0,
  easting: p.easting,
  northing: p.northing,
  cos: Math.cos(rad(p.rotationDegrees)),
  sin: Math.sin(rad(p.rotationDegrees)),
  factor: 1,
  zone: p.zone,
  south: true,
  elevation: p.elevation,
  assumed: false,
});

/** Ángulo en (−180°, 180°]. */
export function normalizeDegrees(degrees: number): number {
  const d = ((((degrees + 180) % 360) + 360) % 360) - 180;
  return d === -180 ? 180 : d;
}

/** Misma rotación y cota, trasladada para que el punto (x, y) del modelo quede en `target`. */
export function centeredAt(p: UserPlacement, x: number, y: number, target: UtmPoint): UserPlacement {
  const converted = target.zone === p.zone ? target : fromGeographic(toGeographic(target), p.zone);
  const cos = Math.cos(rad(p.rotationDegrees));
  const sin = Math.sin(rad(p.rotationDegrees));
  return { ...p, easting: converted.easting - (x * cos - y * sin), northing: converted.northing - (x * sin + y * cos) };
}

/** Colocación rápida: el pivote se traslada (dx, dy) en coordenadas del modelo y el modelo gira alrededor de él. */
export function movedAndRotated(p: UserPlacement, pivotX: number, pivotY: number, dx: number, dy: number, rotationDegrees: number): UserPlacement {
  const center = frameToUtm(placementFrame(p), pivotX + dx, pivotY + dy);
  return centeredAt({ ...p, rotationDegrees: normalizeDegrees(p.rotationDegrees + rotationDegrees) }, pivotX, pivotY, center);
}

/** Georreferencia equivalente a una relación modelo ↔ UTM ya conocida (para editarla). */
export function placementFromFrame(frame: ModelFrame, crsName?: string | null): UserPlacement {
  const origin = frameToUtm(frame, 0, 0);
  const rotation = (Math.atan2(frame.sin, frame.cos) * 180) / Math.PI;
  return {
    easting: origin.easting,
    northing: origin.northing,
    elevation: frame.elevation,
    rotationDegrees: Math.round(rotation * 1e6) / 1e6,
    crsName: crsFor(crsName, frame.zone).name,
    zone: frame.zone,
  };
}

const n2 = (v: number) => v.toLocaleString("es-CL", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const describePlacement = (p: UserPlacement): string =>
  `${p.crsName} · origen E ${n2(p.easting)} · N ${n2(p.northing)} · cota ${p.elevation !== null ? `${n2(p.elevation)} m` : "sobre el terreno"} · rotación ${n2(p.rotationDegrees)}°`;

/** Georreferencia definida por el usuario; se contrasta con el IfcSite como las demás fuentes. */
export function locationFromPlacement(p: UserPlacement, extent: ModelExtent | null, geo: ModelGeolocation | null): ProjectLocation {
  const notes = [describePlacement(p)];
  const site: GeoPoint | null = geo && hasSite(geo) && !isSiteOutsideChile(geo) ? { latitude: geo.siteLatitude!, longitude: geo.siteLongitude! } : null;
  const frame = placementFrame(p);
  if (extent) return buildLocation(frame, extent, "userGeoreference", site, notes, false);
  const origin = frameToUtm(frame, 0, 0);
  return { center: toGeographic(origin), footprint: null, source: "userGeoreference", utm: origin, notes, needsConfirmation: false, frame };
}

/** Estudio de cabida sin modelo: coordenadas locales en metros con origen en el punto (X al este, Y al norte). Z = 0 es el terreno. */
export function siteLocation(point: GeoPoint): ProjectLocation {
  const utm = fromGeographic(point);
  const frame = { ...placedFrame(0, 0, utm), assumed: false };
  return {
    center: point,
    footprint: null,
    source: "manual",
    utm,
    notes: ["Estudio de cabida sin modelo: coordenadas locales con origen en el punto de referencia."],
    needsConfirmation: false,
    frame,
  };
}

/** Acepta coma o punto decimal ("282905,12" o "282905.12"); el separador de miles se ignora. */
export function parseNumber(text: string | null | undefined): number | null {
  if (!text || !text.trim()) return null;
  let t = text.trim().replace(/\s/g, "");
  const lastComma = t.lastIndexOf(",");
  const lastDot = t.lastIndexOf(".");
  if (lastComma >= 0 && lastDot >= 0) t = lastComma > lastDot ? t.replace(/\./g, "").replace(",", ".") : t.replace(/,/g, "");
  else if (lastComma >= 0) t = t.replace(",", ".");
  const value = Number(t);
  return Number.isFinite(value) ? value : null;
}

export const formatNumber = (value: number, decimals = 4): string =>
  (Math.round(value * 10 ** decimals) / 10 ** decimals).toLocaleString("es-CL", { maximumFractionDigits: decimals });
