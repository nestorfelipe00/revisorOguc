// API del hilo principal para la geometría por elemento: la calcula en geometryWorker.ts y la guarda en IndexedDB por
// SHA-256 del archivo y versión del extractor, de modo que un IFC ya visto no se vuelve a parsear.
import { GEOMETRY_VERSION, type ElementGeometry, type ModelGeometry } from "@/lib/reglas/tipos";
import type { GeometryRequest, GeometryResponse } from "./geometryWorker";
import type { GeometryProgress } from "./geometryCore";

const DB_NAME = "bnc-geometria";
const DB_VERSION = 1;
const STORE = "geometria";

interface CacheEntry {
  key: string;
  elements: ElementGeometry[];
  savedAt: number;
}

export const cacheKey = (sha256: string): string => `${sha256}-${GEOMETRY_VERSION}`;

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "key" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function withStore<T>(db: IDBDatabase, mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, mode);
      const request = run(tx.objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      tx.onabort = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function readCache(key: string): Promise<ElementGeometry[] | null> {
  const db = await openDb();
  if (!db) return null;
  try {
    const entry = await withStore<CacheEntry | undefined>(db, "readonly", (store) => store.get(key) as IDBRequest<CacheEntry | undefined>);
    return entry && Array.isArray(entry.elements) ? entry.elements : null;
  } finally {
    db.close();
  }
}

async function writeCache(key: string, elements: ElementGeometry[]): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    const entry: CacheEntry = { key, elements, savedAt: Date.now() };
    await withStore(db, "readwrite", (store) => store.put(entry));
  } finally {
    db.close();
  }
}

function runWorker(bytes: Uint8Array, modelId: string, onProgress: GeometryProgress): Promise<ModelGeometry> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./geometryWorker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<GeometryResponse>) => {
      const data = event.data;
      if (data.type === "progress") {
        onProgress(data.stage, data.progress);
        return;
      }
      worker.terminate();
      if (data.type === "done") resolve(data.geometry);
      else reject(new Error(data.message));
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message || "No se pudo calcular la geometría del IFC en segundo plano."));
    };
    const request: GeometryRequest = { bytes, wasmPath: new URL("/wasm/", location.origin).href, modelId };
    worker.postMessage(request);
  });
}

/**
 * Geometría por elemento de un IFC (coordenadas del modelo, m). La primera vez la calcula en un Web Worker y la guarda en
 * IndexedDB con clave `${sha256}-${GEOMETRY_VERSION}`; las siguientes la lee de la caché sin volver a parsear.
 */
export async function extraerGeometria(bytes: Uint8Array, modelId: string, sha256: string, onProgress: GeometryProgress): Promise<ModelGeometry> {
  const key = cacheKey(sha256);
  const cached = await readCache(key);
  if (cached) {
    onProgress("Geometría (caché)", 1);
    return { modelId, elements: cached };
  }
  const geometry = await runWorker(bytes, modelId, onProgress);
  await writeCache(key, geometry.elements);
  return geometry;
}

/** Vacía la caché de geometría (todas las versiones). */
export async function limpiarCacheGeometria(): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    await withStore(db, "readwrite", (store) => store.clear());
  } finally {
    db.close();
  }
}
