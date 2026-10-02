// Arma la escena territorial 3D alrededor del proyecto desde las teselas: terreno, edificios, vías, agua, áreas verdes,
// árboles y zonas del PRC con su altura máxima verificada, en coordenadas del modelo. Porte de CityContextBuilder.cs.
// Es contexto de referencia: las alturas de edificios y el terreno no sirven para verificar normas.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { TerritoryScene } from "@/viewer/protocol";
import { frameGeoToModel, frameToUtm, type ModelExtent, type ModelFrame, type ProjectLocation } from "@/lib/territorio/location";
import { toGeographic, type GeoPoint } from "@/lib/territorio/utm";
import { zonasEnArea } from "@/lib/territorio/consulta";
import { zoneKey } from "@/lib/reglas/normas";
import type { Parcel } from "@/lib/reglas/tipos";
import { ciudadPara, coordenadas, indiceCiudad, terrenoEn, teselasEn, type Tesela } from "./teselas";

export const MARGIN_METERS = 300;
const MAX_HALF_SIZE = 1000;
const MAX_TERRAIN_VERTICES = 160;
const FLOOR_HEIGHT = 3.0;
const UNKNOWN_HEIGHT = 3.0;

export interface ZonaCiudad {
  code: string;
  name: string;
  /** Anillos en lon/lat (el primero exterior). */
  rings: GeoPoint[][];
  maxHeight: number | null;
  source: string | null;
}

interface AlturasJson {
  documento: string;
  alcance: string;
  zonas: { zona: string; altura_m: number | null; pisos: number | null; texto: string; pagina: number; seccion: string }[];
}

/** Zonas del PRC que tocan el área (polígono GeoJSON lon/lat) con la altura máxima de la ficha de alturas de la comuna. */
export async function zonasParaCiudad(supabase: SupabaseClient, carpeta: string, areaJson: string): Promise<{ zonas: ZonaCiudad[]; alturas: AlturasJson | null }> {
  const [rows, alturas] = await Promise.all([
    zonasEnArea(supabase, carpeta, areaJson),
    fetch(`/normas/${carpeta}/alturas_maximas.json`, { cache: "no-cache" }).then((r) => (r.ok ? (r.json() as Promise<AlturasJson>) : null)).catch(() => null),
  ]);
  const byZone = new Map<string, AlturasJson["zonas"][number]>();
  for (const z of alturas?.zonas ?? []) byZone.set(zoneKey(z.zona), z);
  const zonas: ZonaCiudad[] = [];
  for (const r of rows) {
    if (!(r.rol === "zonas" || r.rol === "subzonas") || !r.codigo) continue;
    let geometry: { type: string; coordinates: unknown } | null = null;
    try {
      geometry = JSON.parse(r.interseccion_geojson) as { type: string; coordinates: unknown };
    } catch {
      continue;
    }
    const polygons = geometry?.type === "Polygon" ? [geometry.coordinates as number[][][]] : geometry?.type === "MultiPolygon" ? (geometry.coordinates as number[][][][]) : [];
    const limit = byZone.get(zoneKey(r.codigo));
    for (const polygon of polygons) {
      zonas.push({
        code: r.codigo,
        name: r.nombre ?? r.codigo,
        rings: polygon.map((ring) => ring.map(([lon, lat]) => ({ longitude: lon, latitude: lat }))),
        maxHeight: limit?.altura_m ?? null,
        source: limit && alturas ? `${alturas.documento}, ${limit.seccion}, p. ${limit.pagina}: «${limit.texto}»` : null,
      });
    }
  }
  return { zonas, alturas };
}

const r2 = (v: number) => Math.round(v * 100) / 100;

function bbox(points: { x: number; y: number }[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

const intersects = (a: ReturnType<typeof bbox>, b: ReturnType<typeof bbox>) => a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;

export interface EscenaOpciones {
  location: ProjectLocation;
  extent: ModelExtent | null;
  parcel: Parcel | null;
  zonas: ZonaCiudad[];
  alturasDocumento: { documento: string; alcance: string } | null;
}

/** Envolvente lon/lat del área cuadrada alrededor del modelo (misma que usa la escena), como polígono GeoJSON. */
export function areaDeCiudad(location: ProjectLocation, extent: ModelExtent | null): { geojson: string; env: { minLon: number; minLat: number; maxLon: number; maxLat: number } } | null {
  const frame = location.frame;
  if (!frame) return null;
  const { cx, cy, hx, hy } = areaModelo(location, frame, extent);
  const corners = cornersGeo(frame, cx, cy, hx, hy);
  const lons = corners.map((c) => c.longitude);
  const lats = corners.map((c) => c.latitude);
  const coords = corners.map((c) => [c.longitude, c.latitude]);
  coords.push(coords[0]);
  return {
    geojson: JSON.stringify({ type: "Polygon", coordinates: [coords] }),
    env: { minLon: Math.min(...lons), minLat: Math.min(...lats), maxLon: Math.max(...lons), maxLat: Math.max(...lats) },
  };
}

function areaModelo(location: ProjectLocation, frame: ModelFrame, extent: ModelExtent | null) {
  if (extent && extent.maxX - extent.minX < 2 * MAX_HALF_SIZE && extent.maxY - extent.minY < 2 * MAX_HALF_SIZE) {
    return {
      cx: (extent.minX + extent.maxX) / 2,
      cy: (extent.minY + extent.maxY) / 2,
      hx: Math.min((extent.maxX - extent.minX) / 2 + MARGIN_METERS, MAX_HALF_SIZE),
      hy: Math.min((extent.maxY - extent.minY) / 2 + MARGIN_METERS, MAX_HALF_SIZE),
    };
  }
  const c = frameGeoToModel(frame, location.center);
  return { cx: c.x, cy: c.y, hx: MARGIN_METERS, hy: MARGIN_METERS };
}

const toGeo = (frame: ModelFrame, x: number, y: number): GeoPoint => toGeographic(frameToUtm(frame, x, y));

const cornersGeo = (frame: ModelFrame, cx: number, cy: number, hx: number, hy: number): GeoPoint[] =>
  [
    [cx - hx, cy - hy], [cx + hx, cy - hy], [cx + hx, cy + hy], [cx - hx, cy + hy],
  ].map(([x, y]) => toGeo(frame, x, y));

export class CiudadNoDisponible extends Error {}

/** Escena alrededor del modelo con las teselas de la porción de ciudad disponible. Lanza CiudadNoDisponible con el motivo. */
export async function escenaCiudad(options: EscenaOpciones): Promise<TerritoryScene> {
  const { location, extent, parcel } = options;
  const frame = location.frame;
  if (!frame) throw new CiudadNoDisponible("Primero hay que ubicar el proyecto: indique la ubicación en la pestaña Coordenadas.");
  const ciudad = await ciudadPara(location.center);
  const punto = `${location.center.latitude.toFixed(5)},${location.center.longitude.toFixed(5)}`;
  if (!ciudad) throw new CiudadNoDisponible(`No hay porción de ciudad 3D generada para esta ubicación. Genérela en el escritorio con: python tools/gis/teselas_ciudad.py <comuna> <carpeta _ciudad> ${punto} 1500`);
  const index = await indiceCiudad(ciudad);
  if (!index) throw new CiudadNoDisponible(`No se pudo leer el índice de la ciudad ${ciudad}.`);

  const { cx, cy, hx, hy } = areaModelo(location, frame, extent);
  const corners = cornersGeo(frame, cx, cy, hx, hy);
  const env = {
    minLon: Math.min(...corners.map((c) => c.longitude)) - 0.002,
    minLat: Math.min(...corners.map((c) => c.latitude)) - 0.002,
    maxLon: Math.max(...corners.map((c) => c.longitude)) + 0.002,
    maxLat: Math.max(...corners.map((c) => c.latitude)) + 0.002,
  };
  const tiles = await teselasEn(index, env);
  if (tiles.length === 0) throw new CiudadNoDisponible(`La ubicación queda fuera de las porciones de ciudad 3D generadas. Genere una con: python tools/gis/teselas_ciudad.py ${ciudad} <carpeta _ciudad> ${punto} 1500`);

  const ground = (x: number, y: number): number => {
    const g = toGeo(frame, x, y);
    return terrenoEn(tiles, g.longitude, g.latitude) ?? NaN;
  };
  const centerGround = ground(cx, cy);
  if (Number.isNaN(centerGround)) throw new CiudadNoDisponible("La ubicación está fuera del terreno de la porción de ciudad.");

  const notes: string[] = [];
  let offset: number;
  if (frame.elevation !== null) {
    offset = -frame.elevation;
    notes.push(`Cotas: Z del modelo = altitud − ${r2(frame.elevation).toLocaleString("es-CL")} m (OrthogonalHeight del IfcMapConversion).`);
  } else if (extent && extent.minZ > 20 && Math.abs(extent.minZ - centerGround) < 25) {
    offset = 0;
    notes.push("Las cotas Z del modelo coinciden con la altitud del terreno: se usan como cotas absolutas.");
  } else {
    offset = -centerGround;
    notes.push(`Supuesto: Z = 0 del modelo = terreno natural en el centro del proyecto (≈ ${Math.round(centerGround)} m s. n. m. según el modelo de superficie).`);
  }
  const groundZ = (x: number, y: number) => ground(x, y) + offset;

  const step = Math.max(Math.max(2 * hx, 2 * hy) / MAX_TERRAIN_VERTICES, 5);
  const columns = Math.ceil((2 * hx) / step) + 1;
  const rows = Math.ceil((2 * hy) / step) + 1;
  const z: number[] = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < columns; i++) {
      const value = groundZ(cx - hx + i * step, cy - hy + j * step);
      z.push(r2(Number.isNaN(value) ? offset + centerGround : value));
    }
  }
  const area = { minX: cx - hx, minY: cy - hy, maxX: cx + hx, maxY: cy + hy };
  const footprint = extent && extent.maxX - extent.minX < 2 * MAX_HALF_SIZE ? { minX: extent.minX, minY: extent.minY, maxX: extent.maxX, maxY: extent.maxY } : null;
  const inside = (b: ReturnType<typeof bbox> | null, x: number, y: number) => !!b && x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY;

  const toModelRing = (t: Tesela, values: number[]): { x: number; y: number }[] => coordenadas(t, values).map((g) => frameGeoToModel(frame, g));
  const flat = (points: { x: number; y: number }[]): number[] => points.flatMap((p) => [r2(p.x - cx), r2(p.y - cy)]);

  const buildings: TerritoryScene["buildings"] = [];
  const seen = new Set<number>();
  const bySource: Record<string, number> = { dato: 0, pisos: 0, estimada: 0 };
  let excluded = 0;
  for (const t of tiles) {
    for (const b of t.edificios) {
      if (seen.has(b.id)) continue;
      seen.add(b.id);
      const rings = b.r.map((ring) => toModelRing(t, ring));
      const outer = rings[0];
      if (!outer || outer.length < 4) continue;
      const mx = outer.reduce((s, p) => s + p.x, 0) / outer.length;
      const my = outer.reduce((s, p) => s + p.y, 0) / outer.length;
      if (!inside(area, mx, my)) continue;
      if (inside(footprint, mx, my)) {
        excluded++;
        continue;
      }
      let base = Infinity;
      for (const p of outer) base = Math.min(base, groundZ(p.x, p.y));
      if (!Number.isFinite(base)) continue;
      const [height, source]: [number, "dato" | "pisos" | "estimada"] = b.h && b.h > 0 ? [b.h, "dato"] : b.p && b.p > 0 ? [b.p * FLOOR_HEIGHT, "pisos"] : [UNKNOWN_HEIGHT, "estimada"];
      bySource[source]++;
      buildings.push({ rings: rings.map(flat), base: r2(base), height: r2(height), heightSource: source });
    }
  }

  const near = { minX: area.minX - 50, minY: area.minY - 50, maxX: area.maxX + 50, maxY: area.maxY + 50 };
  const roads: TerritoryScene["roads"] = [];
  const water: TerritoryScene["water"] = [];
  const green: TerritoryScene["green"] = [];
  const trees: number[] = [];
  for (const t of tiles) {
    for (const v of t.vias) {
      const points = toModelRing(t, v.c);
      if (!intersects(bbox(points), near)) continue;
      roads.push({ points: flat(points), kind: v.k, width: roadWidth(v.k) });
    }
    for (const [target, rings] of [[water, t.agua], [green, t.verdes]] as const) {
      for (const polygon of rings) {
        const converted = polygon.map((ring) => toModelRing(t, ring));
        if (!intersects(bbox(converted[0]), near)) continue;
        target.push({ rings: converted.map(flat) });
      }
    }
    for (const p of coordenadas(t, t.arboles)) {
      const m = frameGeoToModel(frame, p);
      if (!inside(area, m.x, m.y)) continue;
      const zt = groundZ(m.x, m.y);
      if (Number.isNaN(zt)) continue;
      trees.push(r2(m.x - cx), r2(m.y - cy), r2(zt));
    }
  }

  const zones: TerritoryScene["zones"] = options.zonas.map((zona) => ({
    code: zona.code,
    name: zona.name,
    maxHeight: zona.maxHeight,
    source: zona.source,
    rings: zona.rings.map((ring) => flat(ring.map((g) => frameGeoToModel(frame, g)))),
  }));

  const project = footprint
    ? flat([
        { x: footprint.minX, y: footprint.minY }, { x: footprint.maxX, y: footprint.minY }, { x: footprint.maxX, y: footprint.maxY },
        { x: footprint.minX, y: footprint.maxY }, { x: footprint.minX, y: footprint.minY },
      ])
    : null;

  if (buildings.length > 0) {
    notes.push(`${buildings.length} edificios: ${bySource.dato} con altura de la fuente, ${bySource.pisos} estimados por pisos (× ${FLOOR_HEIGHT} m) y ${bySource.estimada} sin dato (se muestran con ${UNKNOWN_HEIGHT} m).`);
  }
  if (excluded > 0) notes.push(`${excluded} edificios existentes dentro de la huella del modelo no se muestran.`);
  if (frame.assumed) notes.push("Supuesto: el modelo se ubica por su centro, con el eje Y hacia el norte (no trae georreferencia).");
  notes.push(`Terreno: ${index.terreno.fuente} (~${index.terreno.celda_m} m), sin edificios ni árboles por apertura morfológica. Referencial: no sirve para medir rasantes.`);
  if (options.alturasDocumento && zones.some((zn) => zn.maxHeight !== null)) notes.push(`Alturas máximas: ${options.alturasDocumento.documento}. ${options.alturasDocumento.alcance}`);
  notes.push("Porción de ciudad precalculada alrededor del proyecto: solo se descargan las teselas de ~250 m que rodean el modelo.");

  const attribution = index.fuentes.map((s) => `${s.capa}: ${s.fuente} (${s.licencia})`).join(" · ");
  const modelToWorld = [frame.originX, frame.originY, frame.easting, frame.northing, frame.cos, frame.sin, frame.factor, offset];
  const parcelRing = parcel ? parcel.vertices.flatMap((v) => {
    const m = frameGeoToModel(frame, v);
    return [Math.round((m.x - cx) * 1000) / 1000, Math.round((m.y - cy) * 1000) / 1000];
  }) : null;
  return {
    origin: [cx, cy],
    terrain: { x0: -hx, y0: -hy, step, columns, rows, z },
    buildings,
    roads,
    water,
    green,
    trees,
    zones,
    project,
    notes,
    attribution,
    modelToWorld,
    parcel: parcelRing,
    parcelKinds: parcel ? parcel.edges.map((e) => e.kind) : null,
  };
}

/** Ancho gráfico por clase de vía (solo para dibujar; no es la faja oficial). */
function roadWidth(kind: string): number {
  switch (kind) {
    case "motorway": case "trunk": return 16;
    case "primary": return 13;
    case "secondary": return 11;
    case "tertiary": return 9;
    case "residential": case "unclassified": case "living_street": return 7;
    case "service": case "track": return 4;
    case "footway": case "path": case "steps": case "cycleway": case "pedestrian": return 2.5;
    default: return 6;
  }
}

/** Cota aproximada del terreno (DSM con apertura) en un punto, m s. n. m.; null sin porción de ciudad. */
export async function alturaTerreno(point: GeoPoint): Promise<number | null> {
  const ciudad = await ciudadPara(point);
  const index = ciudad ? await indiceCiudad(ciudad) : null;
  if (!index) return null;
  const d = 0.002;
  const tiles = await teselasEn(index, { minLon: point.longitude - d, minLat: point.latitude - d, maxLon: point.longitude + d, maxLat: point.latitude + d });
  return terrenoEn(tiles, point.longitude, point.latitude);
}

export interface CalleCercana {
  name: string | null;
  distance: number;
  /** Dirección desde el punto hacia la calle (este, norte), unitaria. */
  directionX: number;
  directionY: number;
}

/** Calle más cercana a un punto (hasta `radius` m), como ParcelImporter.NearestStreet del escritorio. */
export async function calleMasCercana(point: GeoPoint, radius = 100): Promise<CalleCercana | null> {
  const ciudad = await ciudadPara(point);
  const index = ciudad ? await indiceCiudad(ciudad) : null;
  if (!index) return null;
  const kx = 111320 * Math.cos((point.latitude * Math.PI) / 180);
  const ky = 110574;
  const tiles = await teselasEn(index, { minLon: point.longitude - radius / kx, minLat: point.latitude - radius / ky, maxLon: point.longitude + radius / kx, maxLat: point.latitude + radius / ky });
  let best: CalleCercana | null = null;
  for (const t of tiles) {
    for (const v of t.vias) {
      if (["footway", "path", "steps", "cycleway"].includes(v.k)) continue;
      const pts = coordenadas(t, v.c).map((g) => ({ x: (g.longitude - point.longitude) * kx, y: (g.latitude - point.latitude) * ky }));
      for (let k = 0; k + 1 < pts.length; k++) {
        const a = pts[k];
        const b = pts[k + 1];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len2 = dx * dx + dy * dy;
        const u = len2 > 0 ? Math.max(0, Math.min(1, (-a.x * dx - a.y * dy) / len2)) : 0;
        const nx = a.x + u * dx;
        const ny = a.y + u * dy;
        const distance = Math.hypot(nx, ny);
        if (distance > radius || distance < 0.5 || (best && distance >= best.distance)) continue;
        best = { name: v.n, distance, directionX: nx / distance, directionY: ny / distance };
      }
    }
  }
  return best;
}
