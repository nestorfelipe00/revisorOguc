// Cruce de la ubicación del proyecto con la normativa en Supabase (PostGIS): comuna, instrumento, zonas, áreas especiales y vialidad.
// Reemplaza a Infrastructure/Gis/TerritorialLayers.Analyze y CommuneCatalog del escritorio.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { GeoPoint } from "./utm";
import type { ProjectLocation } from "./location";

export interface Comuna {
  cut: string;
  nombre: string;
  region: string;
  carpeta: string | null;
}

export interface Instrumento {
  carpeta: string;
  nombre: string;
  cut: string | null;
  region: string | null;
  tipo: "comunal" | "intercomunal";
  instrumento: string | null;
  fuente: string | null;
  caracter: string | null;
  ordenanza_url: string | null;
  fichas_url: string | null;
  manifest: Record<string, unknown>;
}

export interface ZoneHit {
  layer: string;
  code: string;
  name: string;
  sheetUrl: string | null;
  sharePercent: number;
}

export interface SpecialAreaHit {
  layer: string;
  name: string;
  sheetUrl: string | null;
}

export interface RoadHit {
  kind: string;
  distanceMeters: number;
}

export interface TerritorialAnalysis {
  comuna: Comuna | null;
  instrument: Instrumento | null;
  /** Planes intercomunales (PRMS) que también cubren el punto. */
  plans: Instrumento[];
  coverage: string;
  insideCoverage: boolean;
  zones: ZoneHit[];
  specialAreas: SpecialAreaHit[];
  roads: RoadHit[];
  notes: string[];
  disclaimer: string;
  ordinanceUrl: string | null;
  source: string;
  /** La comuna tiene fichas de zona verificadas (normas_zonas). */
  hasNorms: boolean;
}

interface ZoneRow {
  capa_id: number;
  rol: string;
  nombre_capa: string;
  codigo: string | null;
  nombre: string | null;
  ficha_url: string | null;
  atributos: Record<string, unknown>;
  interseccion_geojson: string;
  porcentaje: number | null;
}

/** Polígono GeoJSON del área del proyecto: la huella si existe, o un cuadrado de 2 m alrededor del centro. */
export function areaGeoJson(location: ProjectLocation): string {
  const ring: GeoPoint[] =
    location.footprint && location.footprint.length >= 4
      ? location.footprint
      : (() => {
          const d = 0.00001;
          const { latitude: lat, longitude: lon } = location.center;
          return [
            { latitude: lat - d, longitude: lon - d }, { latitude: lat - d, longitude: lon + d }, { latitude: lat + d, longitude: lon + d },
            { latitude: lat + d, longitude: lon - d }, { latitude: lat - d, longitude: lon - d },
          ];
        })();
  const coords = ring.map((p) => [p.longitude, p.latitude]);
  if (coords[0][0] !== coords.at(-1)![0] || coords[0][1] !== coords.at(-1)![1]) coords.push(coords[0]);
  return JSON.stringify({ type: "Polygon", coordinates: [coords] });
}

export function polygonGeoJson(ring: GeoPoint[]): string {
  const coords = ring.map((p) => [p.longitude, p.latitude]);
  coords.push(coords[0]);
  return JSON.stringify({ type: "Polygon", coordinates: [coords] });
}

async function rpc<T>(supabase: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data as T;
}

export async function comunaEnPunto(supabase: SupabaseClient, point: GeoPoint): Promise<Comuna | null> {
  const rows = await rpc<Comuna[]>(supabase, "comuna_en_punto", { lon: point.longitude, lat: point.latitude });
  return rows[0] ?? null;
}

export async function instrumentosEnPunto(supabase: SupabaseClient, point: GeoPoint): Promise<Instrumento[]> {
  return rpc<Instrumento[]>(supabase, "instrumentos_en_punto", { lon: point.longitude, lat: point.latitude });
}

/** Zonas, áreas y vialidad de un instrumento que intersectan el área (polígono GeoJSON lon/lat). */
export async function zonasEnArea(supabase: SupabaseClient, carpeta: string, areaJson: string): Promise<ZoneRow[]> {
  return rpc<ZoneRow[]>(supabase, "zonas_en_predio", { carpeta_prc: carpeta, predio_geojson: areaJson });
}

export async function vialidadCercana(supabase: SupabaseClient, carpeta: string, areaJson: string): Promise<RoadHit[]> {
  const rows = await rpc<{ nombre_capa: string; nombre: string | null; atributos: Record<string, unknown>; distancia_m: number }[]>(
    supabase, "vialidad_cercana", { carpeta_prc: carpeta, predio_geojson: areaJson },
  );
  const nearest = new Map<string, number>();
  for (const r of rows) {
    const kind = String(r.atributos?.Descrip ?? "");
    if (!/apertura|ensanche/i.test(kind)) continue;
    const best = nearest.get(kind);
    if (best === undefined || r.distancia_m < best) nearest.set(kind, r.distancia_m);
  }
  return [...nearest].map(([kind, d]) => ({ kind, distanceMeters: Math.round(d * 10) / 10 }));
}

/**
 * Análisis territorial de la ubicación, con la misma lógica que TerritorialLayers.Analyze del escritorio: zonas y subzonas con su
 * porcentaje (las subzonas mandan), áreas especiales, zonificación anterior (no vigente), fajas viales a menos de 30 m y notas.
 */
export async function analizarTerritorio(supabase: SupabaseClient, location: ProjectLocation): Promise<TerritorialAnalysis> {
  const point = location.center;
  const [comuna, instruments] = await Promise.all([comunaEnPunto(supabase, point), instrumentosEnPunto(supabase, point)]);
  const notes: string[] = [];
  // Instrumento comunal: el de la comuna del punto si tiene capas; si no, el primero cuya extensión cubre el punto.
  const communal = instruments.filter((i) => i.tipo === "comunal");
  const instrument = communal.find((i) => comuna?.carpeta && i.carpeta === comuna.carpeta) ?? communal[0] ?? null;
  const plans = instruments.filter((i) => i.tipo === "intercomunal");

  if (!instrument) {
    const where = comuna ? `${comuna.nombre}, Región ${comuna.region}` : "fuera de los límites comunales de Chile";
    notes.push(
      comuna
        ? `La comuna de ${comuna.nombre} aún no tiene cargado su Plan Regulador Comunal. Se identifica la comuna y la región (${comuna.region}).`
        : "La ubicación no cae en ninguna comuna de Chile según los límites oficiales (DPA SUBDERE).",
    );
    return {
      comuna, instrument: null, plans, coverage: where, insideCoverage: false, zones: [], specialAreas: [], roads: [], notes,
      disclaimer: "Información referencial.", ordinanceUrl: null, source: "SUBDERE 2018 (DPA)", hasNorms: false,
    };
  }

  const area = areaGeoJson(location);
  const [rows, roads, norms] = await Promise.all([
    zonasEnArea(supabase, instrument.carpeta, area),
    vialidadCercana(supabase, instrument.carpeta, area),
    supabase.from("normas_zonas").select("zona", { count: "exact", head: true }).eq("carpeta", instrument.carpeta),
  ]);

  const isPoint = !location.footprint || location.footprint.length < 4;
  const zoneRows = rows.filter((r) => r.rol === "zonas" || r.rol === "subzonas");
  const subzones = zoneRows.filter((r) => r.rol === "subzonas");
  const zones: ZoneHit[] = [];
  for (const r of zoneRows) {
    const share = isPoint ? 100 : (r.porcentaje ?? 0);
    if (share < 0.5) continue;
    // Donde hay subzona, rigen las normas de la subzona: la zona que la contiene no se lista dos veces.
    if (r.rol === "zonas" && isPoint && subzones.length > 0) continue;
    zones.push({ layer: r.nombre_capa, code: r.codigo ?? "(sin código)", name: r.nombre ?? r.codigo ?? "", sheetUrl: r.ficha_url, sharePercent: Math.round(share * 10) / 10 });
  }
  const specialAreas: SpecialAreaHit[] = [];
  for (const r of rows.filter((r) => r.rol === "especial" || r.rol === "uso")) {
    specialAreas.push({ layer: r.nombre_capa, name: r.nombre ?? r.codigo ?? "", sheetUrl: r.ficha_url });
  }
  for (const r of rows.filter((r) => r.rol === "anterior")) {
    specialAreas.push({ layer: r.nombre_capa, name: `zona ${r.nombre ?? r.codigo ?? ""}, no vigente`, sheetUrl: r.ficha_url });
  }

  const manifest = instrument.manifest ?? {};
  const hasCurrentZoning = zoneRows.length > 0 || rows.some((r) => r.rol === "zonas" || r.rol === "subzonas");
  const onlyFormer = !hasCurrentZoning && rows.some((r) => r.rol === "anterior");
  if (onlyFormer) {
    notes.push(
      String(manifest.aviso_vigencia ?? "") ||
        "La zonificación cargada corresponde a un instrumento reemplazado: no se usa en la revisión. Determine la zona en el plano oficial vigente o en el Certificado de Informaciones Previas.",
    );
  } else if (zones.length === 0) {
    notes.push("La ubicación no cae en ninguna zona del PRC: puede estar fuera del límite urbano (área rural), en vialidad o espacio público. Verifíquelo en el Certificado de Informaciones Previas.");
  }
  if (new Set(zones.map((z) => z.code)).size > 1) notes.push("El proyecto abarca más de una zona: cada parte debe cumplir las normas de su zona.");
  for (const plan of plans) notes.push(`La ubicación también está dentro del ${plan.instrumento ?? plan.nombre}.`);

  return {
    comuna,
    instrument,
    plans,
    coverage: `${instrument.instrumento ?? "Plan Regulador Comunal"} · ${instrument.nombre}`,
    insideCoverage: true,
    zones: zones.sort((a, b) => b.sharePercent - a.sharePercent),
    specialAreas,
    roads,
    notes,
    disclaimer: instrument.caracter ?? "Información referencial.",
    ordinanceUrl: instrument.ordenanza_url,
    source: instrument.fuente ?? instrument.carpeta,
    hasNorms: (norms.count ?? 0) > 0,
  };
}
