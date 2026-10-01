// Porte de Core/Territory/ProjectLocation.cs y ModelGeolocation.cs: ubicación del proyecto sin suponerla.
import { distanceMeters, fromGeographic, toGeographic, zoneFor, zoneFromCrs, type GeoPoint, type UtmPoint } from "./utm";

/** Extensión del modelo en coordenadas IFC (metros): X/Y en planta, Z altura. */
export interface ModelExtent {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

export const extentCenter = (e: ModelExtent) => ({ x: (e.minX + e.maxX) / 2, y: (e.minY + e.maxY) / 2 });

/** Magnitudes típicas de coordenadas UTM en Chile (Este 160–840 km, Norte 3.700–8.100 km). */
export function looksLikeChileanUtm(e: ModelExtent): boolean {
  const { x, y } = extentCenter(e);
  return x > 160_000 && x < 840_000 && y > 3_700_000 && y < 8_100_000;
}

/** Georreferencia del IFC (IfcMapConversion), igual que viewer/protocol.ts. */
export interface Georeference {
  crsName: string | null;
  eastings: number;
  northings: number;
  height: number;
  xAxisAbscissa: number;
  xAxisOrdinate: number;
  scale: number;
  lengthScale: number;
}

export type LocationSource = "mapConversion" | "modelUtmCoordinates" | "ifcSite" | "manual" | "userGeoreference";

export const SOURCE_LABELS: Record<LocationSource, string> = {
  mapConversion: "georreferencia del IFC (IfcMapConversion)",
  modelUtmCoordinates: "coordenadas UTM del modelo",
  ifcSite: "latitud/longitud del IfcSite (aproximada)",
  manual: "indicada en el mapa",
  userGeoreference: "georreferencia definida por el usuario",
};

/** Relación entre las coordenadas del modelo (IFC, metros) y UTM: traslación, rotación y escala. */
export interface ModelFrame {
  originX: number;
  originY: number;
  easting: number;
  northing: number;
  cos: number;
  sin: number;
  factor: number;
  zone: number;
  south: boolean;
  elevation: number | null;
  assumed: boolean;
}

export function frameToUtm(f: ModelFrame, x: number, y: number): UtmPoint {
  const dx = (x - f.originX) * f.factor;
  const dy = (y - f.originY) * f.factor;
  return { easting: f.easting + dx * f.cos - dy * f.sin, northing: f.northing + dx * f.sin + dy * f.cos, zone: f.zone, south: f.south };
}

export function frameToModel(f: ModelFrame, point: UtmPoint): { x: number; y: number } {
  const de = (point.easting - f.easting) / f.factor;
  const dn = (point.northing - f.northing) / f.factor;
  return { x: f.originX + de * f.cos + dn * f.sin, y: f.originY - de * f.sin + dn * f.cos };
}

export const frameGeoToModel = (f: ModelFrame, p: GeoPoint) => frameToModel(f, fromGeographic(p, f.zone));

/** Modelo con coordenadas UTM directas (X = Este, Y = Norte). */
export const identityFrame = (zone: number, south: boolean): ModelFrame => ({
  originX: 0, originY: 0, easting: 0, northing: 0, cos: 1, sin: 0, factor: 1, zone, south, elevation: null, assumed: false,
});

/** Supuesto: el punto (x, y) del modelo está en `at` y el eje Y apunta al norte de la cuadrícula. */
export const placedFrame = (x: number, y: number, at: UtmPoint): ModelFrame => ({
  originX: x, originY: y, easting: at.easting, northing: at.northing, cos: 1, sin: 0, factor: 1, zone: at.zone, south: at.south, elevation: null, assumed: true,
});

export interface ProjectLocation {
  center: GeoPoint;
  footprint: GeoPoint[] | null;
  source: LocationSource;
  utm: UtmPoint | null;
  notes: string[];
  needsConfirmation: boolean;
  frame: ModelFrame | null;
}

/** Ubicación declarada en un IFC: georreferencia explícita y referencia aproximada del IfcSite. */
export interface ModelGeolocation {
  mapConversion: Georeference | null;
  siteLatitude: number | null;
  siteLongitude: number | null;
}

// Chile continental e insular (incluye Rapa Nui).
const inChile = (lat: number, lon: number) => lat >= -56 && lat <= -17.4 && lon >= -110 && lon <= -66.3;

export const hasSite = (g: ModelGeolocation) => g.siteLatitude !== null && g.siteLongitude !== null;

export const isSiteOutsideChile = (g: ModelGeolocation) => hasSite(g) && !inChile(g.siteLatitude!, g.siteLongitude!);

export const rotationDegrees = (g: Georeference) => (Math.atan2(g.xAxisOrdinate, g.xAxisAbscissa) * 180) / Math.PI;

const fmt = (v: number, d: number) => v.toLocaleString("es-CL", { minimumFractionDigits: d, maximumFractionDigits: d });

/** Líneas para mostrar al usuario; las advertencias empiezan con "⚠". */
export function describeGeolocation(g: ModelGeolocation): string[] {
  const lines: string[] = [];
  if (g.mapConversion) {
    const m = g.mapConversion;
    lines.push(`${m.crsName ?? "CRS sin nombre"} · E ${fmt(m.eastings, 2)} · N ${fmt(m.northings, 2)} · H ${fmt(m.height, 2)} · rotación ${fmt(rotationDegrees(m), 2)}°`);
  } else {
    lines.push("⚠ Sin georreferencia explícita (IfcMapConversion): la ubicación se deduce de las coordenadas del modelo o del IfcSite.");
  }
  if (hasSite(g)) {
    const site = `IfcSite: lat ${fmt(g.siteLatitude!, 5)}°, lon ${fmt(g.siteLongitude!, 5)}°`;
    lines.push(
      isSiteOutsideChile(g)
        ? `⚠ ${site} — fuera de Chile: probablemente es la ubicación por defecto del software (Revit usa Boston). Hay que confirmar la ubicación del proyecto.`
        : site,
    );
  } else {
    lines.push("IfcSite sin latitud/longitud.");
  }
  return lines;
}

const MAX_FOOTPRINT_METERS = 2000;
const COHERENCE_METERS = 5000;

/** Fórmula de IfcMapConversion: coordenadas del proyecto (metros del visor) → Este/Norte del mapa. */
function fromMapConversion(g: Georeference, zone: number, south: boolean): ModelFrame {
  const norm = Math.sqrt(g.xAxisAbscissa ** 2 + g.xAxisOrdinate ** 2);
  const [cos, sin] = norm > 0 ? [g.xAxisAbscissa / norm, g.xAxisOrdinate / norm] : [1, 0];
  const factor = g.scale / g.lengthScale;
  return { originX: 0, originY: 0, easting: g.eastings, northing: g.northings, cos, sin, factor, zone, south, elevation: g.height !== 0 ? g.height : null, assumed: false };
}

function build(frame: ModelFrame, extent: ModelExtent, source: LocationSource, site: GeoPoint | null, notes: string[], needsConfirmation: boolean): ProjectLocation {
  const c = extentCenter(extent);
  const centerUtm = frameToUtm(frame, c.x, c.y);
  const center = toGeographic(centerUtm);

  let footprint: GeoPoint[] | null = null;
  const width = extent.maxX - extent.minX;
  const depth = extent.maxY - extent.minY;
  if (width > 0 && width < MAX_FOOTPRINT_METERS && depth > 0 && depth < MAX_FOOTPRINT_METERS) {
    footprint = [
      [extent.minX, extent.minY], [extent.maxX, extent.minY], [extent.maxX, extent.maxY], [extent.minX, extent.maxY], [extent.minX, extent.minY],
    ].map(([x, y]) => toGeographic(frameToUtm(frame, x, y)));
  } else {
    notes.push("La extensión del modelo es muy grande (probablemente incluye elementos lejanos): se usa solo su punto central.");
  }

  if (site) {
    const distance = distanceMeters(center, site);
    if (distance > COHERENCE_METERS) {
      notes.push(`⚠ El IfcSite está a ${fmt(distance / 1000, 1)} km de la ubicación calculada: revise la georreferencia.`);
      needsConfirmation = true;
    } else {
      notes.push(`Coherente con el IfcSite (a ${fmt(distance / 1000, 1)} km).`);
    }
  }
  return { center, footprint, source, utm: centerUtm, notes, needsConfirmation, frame };
}

/**
 * Determina la ubicación de un modelo sin suponerla: usa, en orden, la georreferencia explícita, coordenadas con magnitud UTM
 * (huso según el IfcSite o 19S por defecto, marcado para confirmar) y la lat/lon del IfcSite. Si nada es confiable, null.
 */
export function resolveLocation(geo: ModelGeolocation, extent: ModelExtent | null): ProjectLocation | null {
  const notes: string[] = [];
  const site: GeoPoint | null = hasSite(geo) && !isSiteOutsideChile(geo) ? { latitude: geo.siteLatitude!, longitude: geo.siteLongitude! } : null;

  if (geo.mapConversion && extent) {
    const zone = zoneFromCrs(geo.mapConversion.crsName);
    if (zone) return build(fromMapConversion(geo.mapConversion, zone.zone, zone.south), extent, "mapConversion", site, notes, false);
    notes.push(`El CRS «${geo.mapConversion.crsName}» no se reconoce como UTM: no se usa la georreferencia del IFC.`);
  }

  if (extent && looksLikeChileanUtm(extent)) {
    const zone = site ? zoneFor(site.longitude) : 19;
    notes.push(
      site
        ? `Huso ${zone}S deducido de la lat/lon del IfcSite; el IFC no declara su sistema de referencia.`
        : "Supuesto: coordenadas UTM huso 19S (WGS 84 / SIRGAS-Chile). Confírmelo: el IFC no declara su sistema de referencia.",
    );
    return build(identityFrame(zone, true), extent, "modelUtmCoordinates", site, notes, true);
  }

  if (site) {
    notes.push("Ubicación aproximada: el IfcSite solo indica un punto de referencia; el modelo no trae coordenadas de mapa.");
    const utm = fromGeographic(site);
    const frame = extent ? placedFrame(extentCenter(extent).x, extentCenter(extent).y, utm) : null;
    return { center: site, footprint: null, source: "ifcSite", utm, notes, needsConfirmation: true, frame };
  }
  return null;
}

/** Ubicación indicada a mano; si se conoce la extensión del modelo, su centro queda en ese punto. */
export function manualLocation(point: GeoPoint, extent: ModelExtent | null): ProjectLocation {
  const utm = fromGeographic(point);
  const frame = extent ? placedFrame(extentCenter(extent).x, extentCenter(extent).y, utm) : null;
  return { center: point, footprint: null, source: "manual", utm, notes: ["Ubicación indicada por el usuario."], needsConfirmation: false, frame };
}
