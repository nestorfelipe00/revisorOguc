/**
 * Carga la normativa del repo de escritorio (data/territorio, data/gis, data/normas) en Supabase.
 *
 *   SUPABASE_CARGA_TOKEN=… BNC_DATA_DIR="../REVISOR OGUC/data" npx tsx scripts/cargar-normativa.ts [carpeta…]
 *
 * Usa la clave pública más un token de carga de un solo uso (ver supabase/migrations/*_carga_normativa.sql):
 * nunca la clave service_role. Sin argumentos carga todo; con carpetas (p. ej. la-serena prms) solo esas.
 */
import { createClient } from "@supabase/supabase-js";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const token = process.env.SUPABASE_CARGA_TOKEN;
const dataDir = resolve(process.env.BNC_DATA_DIR ?? "../REVISOR OGUC/data");
if (!url || !key || !token) {
  console.error("Faltan NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY o SUPABASE_CARGA_TOKEN.");
  process.exit(1);
}
const only = new Set(process.argv.slice(2));
const supabase = createClient(url, key, { auth: { persistSession: false } });

/** Tamaño de cada lote enviado a la base (bytes de JSON). */
const BATCH_BYTES = 1_000_000;

type Feature = { type: string; properties?: Record<string, unknown> | null; geometry?: unknown };

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data as T;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function text(props: Record<string, unknown> | null | undefined, name: string): string | null {
  const v = props?.[name];
  return v === null || v === undefined || String(v).length === 0 ? null : String(v);
}

/** Envía las features por lotes para no superar el tamaño de petición. */
async function sendBatches(fn: string, base: Record<string, unknown>, features: Feature[]): Promise<number> {
  let total = 0;
  let batch: Feature[] = [];
  let size = 0;
  // El rol anónimo tiene 3 s por consulta: si un lote se pasa, se reintenta partido en dos.
  const send = async (items: Feature[]): Promise<number> => {
    try {
      return await rpc<number>(fn, { ...base, features: items });
    } catch (error) {
      if (items.length > 1 && /timeout/i.test(String(error))) {
        const half = Math.ceil(items.length / 2);
        return (await send(items.slice(0, half))) + (await send(items.slice(half)));
      }
      throw error;
    }
  };
  const flush = async () => {
    if (batch.length === 0) return;
    total += await send(batch);
    batch = [];
    size = 0;
  };
  for (const f of features) {
    const bytes = JSON.stringify(f).length;
    if (size + bytes > BATCH_BYTES && batch.length > 0) await flush();
    batch.push(f);
    size += bytes;
  }
  await flush();
  return total;
}

async function loadCommunes(): Promise<void> {
  const path = join(dataDir, "territorio", "comunas.geojson");
  if (!existsSync(path)) {
    console.warn("Sin data/territorio/comunas.geojson: se omiten los límites comunales.");
    return;
  }
  const collection = readJson<{ features: Feature[] }>(path);
  const n = await sendBatches("cargar_comunas", { token }, collection.features);
  console.log(`comunas: ${n} límites comunales`);
}

async function loadInstrument(folder: string): Promise<void> {
  const gisFolder = join(dataDir, "gis", folder);
  const manifestPath = join(gisFolder, "manifest.json");
  if (!existsSync(manifestPath)) return;
  const manifest = readJson<Record<string, unknown> & { capas: { archivo: string; nombre: string; rol: string; origen?: string; elementos?: number }[] }>(manifestPath);
  await rpc("cargar_instrumento", { token, carpeta_prc: folder, manifest });
  const fichas = typeof manifest.fichas_url === "string" ? manifest.fichas_url : null;

  for (const capa of manifest.capas ?? []) {
    const file = join(gisFolder, capa.archivo);
    if (!existsSync(file)) {
      console.warn(`  ${folder}/${capa.archivo}: no existe`);
      continue;
    }
    const collection = readJson<{ features: Feature[] }>(file);
    const features = collection.features
      .filter((f) => f.geometry)
      .map((f) => {
        const props = f.properties ?? {};
        // Misma lógica que TerritorialLayers.Code/Name/SheetUrl del escritorio.
        const codigo = text(props, "Zonas") ?? text(props, "Zona") ?? text(props, "Label") ?? "(sin código)";
        const nombre = text(props, "Nombre") ?? codigo;
        const ficha = text(props, "Ficha");
        const fichaUrl = ficha && fichas ? fichas.replace("{Ficha}", encodeURIComponent(ficha)) : null;
        return { type: "Feature", properties: { ...props, __codigo: codigo, __nombre: nombre, __ficha: fichaUrl }, geometry: f.geometry };
      });
    const capaId = await rpc<number>("cargar_capa_meta", {
      token, carpeta_prc: folder, archivo: capa.archivo, nombre: capa.nombre, rol: capa.rol, origen: capa.origen ?? null, elementos: features.length,
    });
    const n = await sendBatches("cargar_capa", { token, capa: capaId }, features);
    console.log(`  ${folder}/${capa.archivo} (${capa.rol}): ${n} elementos`);
  }

  const normsFolder = join(dataDir, "normas", folder);
  for (const clave of ["normas_zonas", "alturas_maximas"]) {
    const file = join(normsFolder, `${clave}.json`);
    if (!existsSync(file)) continue;
    const contenido = readJson<Record<string, unknown>>(file);
    const version = typeof contenido.version === "string" ? contenido.version : typeof contenido.documento === "string" ? contenido.documento : "sin versión";
    const n = await rpc<number>("cargar_normas", { token, carpeta_prc: folder, clave, contenido, version });
    console.log(`  ${folder}/normas/${clave}.json${clave === "normas_zonas" ? `: ${n} zonas` : ""}`);
  }
}

async function loadOguc(): Promise<void> {
  const file = join(dataDir, "normas", "oguc", "geometria.json");
  if (!existsSync(file)) return;
  const contenido = readJson<Record<string, unknown>>(file);
  await rpc("cargar_oguc", { token, clave: "geometria", contenido, version: String(contenido.version ?? "sin versión") });
  console.log("oguc/geometria.json");
}

async function main(): Promise<void> {
  console.log(`Datos: ${dataDir}`);
  if (only.size === 0) {
    await loadCommunes();
    await loadOguc();
  }
  const folders = readdirSync(join(dataDir, "gis"), { withFileTypes: true })
    .filter((d) => d.isDirectory() && (only.size === 0 || only.has(d.name)))
    .map((d) => d.name)
    .sort();
  for (const folder of folders) {
    console.log(folder);
    await loadInstrument(folder);
  }
  if (process.env.SUPABASE_CARGA_FIN === "1") {
    await rpc("cargar_fin", { token });
    console.log("Token de carga eliminado.");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
