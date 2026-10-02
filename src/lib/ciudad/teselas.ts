// Teselas estáticas de la base de ciudad (tools/gis/teselas_ciudad.py del escritorio): la web descarga solo las celdas
// de ~250 m alrededor del modelo. Coordenadas: enteros de 1e-7° relativos a la esquina suroeste de la tesela.
import type { GeoPoint } from "@/lib/territorio/utm";

export const CIUDAD_URL = process.env.NEXT_PUBLIC_CIUDAD_URL ?? "/_ciudad";

export interface CiudadIndice {
  ciudad: string;
  tesela: number;
  lon0: number;
  lat0: number;
  bounds: [number, number, number, number];
  teselas: number;
  terreno: { fuente: string; celda_m: number };
  fuentes: { capa: string; fuente: string; licencia: string }[];
}

export interface TerrenoTesela {
  lon0: number;
  lat0: number;
  dlon: number;
  dlat: number;
  cols: number;
  rows: number;
  z: number[];
}

export interface Tesela {
  i: number;
  j: number;
  lon0: number;
  lat0: number;
  edificios: { id: number; r: number[][]; h?: number; p?: number }[];
  vias: { c: number[]; k: string; n: string | null }[];
  agua: number[][][];
  verdes: number[][][];
  arboles: number[];
  t?: TerrenoTesela;
}

const SCALE = 1e7;

const indices = new Map<string, Promise<CiudadIndice | null>>();
const cache = new Map<string, Promise<Tesela | null>>();
let lista: Promise<{ ciudad: string; bounds: [number, number, number, number] }[]> | null = null;

async function getJson<T>(url: string): Promise<T | null> {
  const response = await fetch(url, { cache: "force-cache" });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`No se pudo leer ${url} (HTTP ${response.status}).`);
  return (await response.json()) as T;
}

/** Ciudades disponibles (ciudades.json). */
export function ciudadesDisponibles(): Promise<{ ciudad: string; bounds: [number, number, number, number] }[]> {
  lista ??= getJson<{ ciudad: string; bounds: [number, number, number, number] }[]>(`${CIUDAD_URL}/ciudades.json`).then((l) => l ?? []);
  return lista;
}

/** Ciudad cuya extensión contiene el punto; si varias, aquella en que el punto queda más lejos del borde. */
export async function ciudadPara(point: GeoPoint): Promise<string | null> {
  let best: string | null = null;
  let bestMargin = -Infinity;
  for (const c of await ciudadesDisponibles()) {
    const [minx, miny, maxx, maxy] = c.bounds;
    if (point.longitude < minx || point.longitude > maxx || point.latitude < miny || point.latitude > maxy) continue;
    const margin = Math.min(point.longitude - minx, maxx - point.longitude, point.latitude - miny, maxy - point.latitude);
    if (margin > bestMargin) {
      best = c.ciudad;
      bestMargin = margin;
    }
  }
  return best;
}

export function indiceCiudad(ciudad: string): Promise<CiudadIndice | null> {
  if (!indices.has(ciudad)) indices.set(ciudad, getJson<CiudadIndice>(`${CIUDAD_URL}/${ciudad}/index.json`));
  return indices.get(ciudad)!;
}

export function tesela(index: CiudadIndice, i: number, j: number): Promise<Tesela | null> {
  const key = `${index.ciudad}/${i}_${j}`;
  if (!cache.has(key)) {
    cache.set(
      key,
      getJson<Omit<Tesela, "i" | "j" | "lon0" | "lat0">>(`${CIUDAD_URL}/${index.ciudad}/${i}_${j}.json`).then((t) =>
        t ? { ...t, i, j, lon0: index.lon0 + i * index.tesela, lat0: index.lat0 + j * index.tesela } : null,
      ),
    );
  }
  return cache.get(key)!;
}

/** Teselas que tocan la envolvente lon/lat (las que no existen vienen como null y se omiten). */
export async function teselasEn(index: CiudadIndice, env: { minLon: number; minLat: number; maxLon: number; maxLat: number }): Promise<Tesela[]> {
  const i0 = Math.floor((env.minLon - index.lon0) / index.tesela);
  const i1 = Math.floor((env.maxLon - index.lon0) / index.tesela);
  const j0 = Math.floor((env.minLat - index.lat0) / index.tesela);
  const j1 = Math.floor((env.maxLat - index.lat0) / index.tesela);
  const wanted: Promise<Tesela | null>[] = [];
  for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) wanted.push(tesela(index, i, j));
  return (await Promise.all(wanted)).filter((t): t is Tesela => t !== null);
}

/** Convierte un anillo o línea de la tesela a pares lon/lat. */
export function coordenadas(t: Tesela, values: number[]): GeoPoint[] {
  const out: GeoPoint[] = [];
  for (let k = 0; k < values.length; k += 2) out.push({ longitude: t.lon0 + values[k] / SCALE, latitude: t.lat0 + values[k + 1] / SCALE });
  return out;
}

/** Altura del terreno (DSM con apertura) en lon/lat según la tesela que cubre el punto; null fuera de las teselas cargadas. */
export function terrenoEn(tiles: Tesela[], lon: number, lat: number): number | null {
  for (const t of tiles) {
    const g = t.t;
    if (!g) continue;
    const fx = (lon - g.lon0) / g.dlon;
    const fy = (g.lat0 - lat) / g.dlat;
    if (fx < 0 || fy < 0 || fx > g.cols - 1 || fy > g.rows - 1) continue;
    const x0 = Math.min(Math.floor(fx), g.cols - 2);
    const y0 = Math.min(Math.floor(fy), g.rows - 2);
    const tx = fx - x0;
    const ty = fy - y0;
    const at = (x: number, y: number) => g.z[y * g.cols + x];
    const top = at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx;
    const bottom = at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx;
    return top * (1 - ty) + bottom * ty;
  }
  return null;
}
