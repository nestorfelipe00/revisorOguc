// Arma la entrada del motor de reglas: predio en coordenadas del modelo, normas de la comuna, zonas del PRC sobre el predio
// y afectaciones. Porte de RuleContextAsync / TerritoryForRules / ZoneOfParcel (MainViewModel.Rules.cs) con PostGIS en vez de GeoJSON local.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Comuna } from "@/lib/territorio/consulta";
import { comunaEnPunto, instrumentosEnPunto, polygonGeoJson, zonasEnArea } from "@/lib/territorio/consulta";
import { frameGeoToModel, type ModelFrame } from "@/lib/territorio/location";
import type { GeoPoint } from "@/lib/territorio/utm";
import { toModel } from "@/lib/reglas/transformacion";
import type { Area2D, Geometry2D, ModelGeometry, Parcel, PublicUseArea, RuleInput, ZonePart } from "@/lib/reglas/tipos";

export interface ContextoRevision {
  /** JSON de la OGUC y de la Ordenanza Local (null si la comuna no tiene fichas): se entregan al worker. */
  oguc: unknown;
  local: unknown | null;
  input: RuleInput;
  zoneCode: string | null;
  zoneNote: string | null;
  comuna: Comuna | null;
  /** Carpeta del instrumento (p. ej. "la-serena") o null si no hay PRC cargado. */
  carpeta: string | null;
}

interface ZonaFila {
  rol: string;
  nombre_capa: string;
  codigo: string | null;
  nombre: string | null;
  interseccion_geojson: string;
  porcentaje: number | null;
}

export const parcelCenter = (parcel: Parcel): GeoPoint => ({
  latitude: parcel.vertices.reduce((s, v) => s + v.latitude, 0) / parcel.vertices.length,
  longitude: parcel.vertices.reduce((s, v) => s + v.longitude, 0) / parcel.vertices.length,
});

async function fetchJson(url: string): Promise<unknown | null> {
  const response = await fetch(url, { cache: "force-cache" });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`No se pudo leer ${url} (HTTP ${response.status}).`);
  return response.json();
}

/** Normativa como JSON crudo: OGUC siempre; Ordenanza Local solo si la comuna tiene fichas verificadas. */
export async function cargarNormasJson(carpeta: string | null): Promise<{ oguc: unknown; local: unknown | null }> {
  const [oguc, local] = await Promise.all([fetchJson("/normas/oguc/geometria.json"), carpeta ? fetchJson(`/normas/${carpeta}/normas_zonas.json`) : Promise.resolve(null)]);
  if (!oguc) throw new Error("No se encontró la normativa OGUC (normas/oguc/geometria.json).");
  return { oguc, local };
}

function parseGeometry(text: string): Geometry2D | null {
  try {
    const g = JSON.parse(text) as { type?: string };
    return g && typeof g.type === "string" && ["Polygon", "MultiPolygon", "LineString", "MultiLineString"].includes(g.type) ? (g as Geometry2D) : null;
  } catch {
    return null;
  }
}

/** Une varias áreas de una misma zona en un MultiPolygon (las partes vienen ya intersectadas con el predio desde PostGIS). */
function mergeAreas(areas: Area2D[]): Area2D {
  if (areas.length === 1) return areas[0];
  const polygons: number[][][][] = [];
  for (const a of areas) {
    if (a.type === "Polygon") polygons.push(a.coordinates);
    else polygons.push(...a.coordinates);
  }
  return { type: "MultiPolygon", coordinates: polygons };
}

/** Zona del PRC donde cae la mayor parte del predio; si abarca varias, se informa (mismo texto que el escritorio). */
export function zonaDelPredio(rows: ZonaFila[], hayInstrumento: boolean, avisoVigencia: string | null): { code: string | null; note: string | null } {
  const zones = rows.filter((r) => (r.rol === "zonas" || r.rol === "subzonas") && r.codigo && r.codigo !== "(sin código)");
  const former = rows.some((r) => r.rol === "anterior");
  if (zones.length === 0) {
    if (!hayInstrumento) return { code: null, note: "predio fuera del PRC cargado" };
    return { code: null, note: former && avisoVigencia ? "la zonificación vigente del PRC no está cargada: determine la zona en el plano oficial" : "el predio no cae en una zona del PRC" };
  }
  const byCode = new Map<string, number>();
  for (const z of zones) byCode.set(z.codigo!, (byCode.get(z.codigo!) ?? 0) + (z.porcentaje ?? 0));
  const sorted = [...byCode].sort((a, b) => b[1] - a[1]);
  const [code, share] = sorted[0];
  const pct = (Math.round(share * 10) / 10).toLocaleString("es-CL", { maximumFractionDigits: 1 });
  return { code, note: sorted.length > 1 ? `el predio abarca ${sorted.length} zonas; se usó ${code} (${pct} %)` : null };
}

export interface OpcionesContexto {
  /** Nombre del trámite (p. ej. «Permiso de edificación de ampliación»): decide si rige el Art. 5º de adosamientos. */
  permitName?: string | null;
  fireRatings?: Record<string, string> | null;
}

export async function construirContexto(
  supabase: SupabaseClient,
  parcel: Parcel,
  frame: ModelFrame,
  models: ModelGeometry[],
  options: OpcionesContexto = {},
): Promise<ContextoRevision> {
  const lotRing = parcel.vertices.map((v) => frameGeoToModel(frame, v));
  const center = parcelCenter(parcel);
  const [comuna, instruments] = await Promise.all([comunaEnPunto(supabase, center), instrumentosEnPunto(supabase, center)]);
  const communal = instruments.filter((i) => i.tipo === "comunal");
  const instrument = communal.find((i) => comuna?.carpeta && i.carpeta === comuna.carpeta) ?? communal[0] ?? null;
  const carpeta = instrument?.carpeta ?? null;
  const normas = await cargarNormasJson(carpeta);

  let zoneParts: ZonePart[] | null = null;
  let publicUse: PublicUseArea[] | null = null;
  let publicUseLayers: string | null = null;
  let zone: { code: string | null; note: string | null } = { code: null, note: "predio fuera del PRC cargado" };
  if (carpeta) {
    const rows = (await zonasEnArea(supabase, carpeta, polygonGeoJson(parcel.vertices))) as unknown as ZonaFila[];
    const manifest = (instrument?.manifest ?? {}) as Record<string, unknown>;
    zone = zonaDelPredio(rows, true, typeof manifest.aviso_vigencia === "string" ? manifest.aviso_vigencia : null);

    const byCode = new Map<string, Area2D[]>();
    for (const r of rows) {
      if (!(r.rol === "zonas" || r.rol === "subzonas") || !r.codigo || r.codigo === "(sin código)") continue;
      const g = parseGeometry(r.interseccion_geojson);
      if (!g || (g.type !== "Polygon" && g.type !== "MultiPolygon")) continue;
      const area = toModel(g, frame) as Area2D;
      byCode.set(r.codigo, [...(byCode.get(r.codigo) ?? []), area]);
    }
    zoneParts = byCode.size > 0 ? [...byCode].map(([code, areas]) => ({ code, area: mergeAreas(areas) })) : null;

    const affecting = rows.filter((r) => r.rol === "especial" || r.rol === "vialidad");
    const layers = [...new Set(affecting.map((r) => r.nombre_capa))];
    if (layers.length > 0) {
      publicUseLayers = layers.join(", ");
      publicUse = affecting
        .map((r) => ({ kind: r.nombre_capa, name: r.nombre ?? r.codigo ?? r.nombre_capa, geometry: parseGeometry(r.interseccion_geojson) }))
        .filter((a): a is { kind: string; name: string; geometry: Geometry2D } => a.geometry !== null)
        .map((a) => ({ kind: a.kind, name: a.name, geometry: toModel(a.geometry, frame) }));
    }
  }

  const isExtension = /ampliaci[oó]n/i.test(options.permitName ?? "");
  const input: RuleInput = {
    lotRing,
    edges: parcel.edges,
    groundZ: parcel.naturalGroundZ,
    groundConfirmed: parcel.groundConfirmed,
    positionConfirmed: parcel.positionConfirmed,
    zoneCode: zone.code,
    region: comuna?.region ?? null,
    isExtension,
    models,
    zoneParts,
    publicUse,
    fireRatings: options.fireRatings ?? null,
    publicUseLayers,
    reviewSuspended: null,
  };
  return { oguc: normas.oguc, local: normas.local, input, zoneCode: zone.code, zoneNote: zone.note, comuna, carpeta };
}
