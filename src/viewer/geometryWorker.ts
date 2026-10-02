// Geometría por elemento del IFC calculada con web-ifc en un Web Worker (reemplaza al comando `geom` del motor IfcOpenShell
// del escritorio). Misma forma que ifcMetaWorker.ts: recibe los bytes y la ruta del wasm, informa el avance por etapas y
// responde con la ModelGeometry (los Float32Array de puntos se transfieren, no se copian).
import * as WebIFC from "web-ifc";
import type { ModelGeometry } from "@/lib/reglas/tipos";
import { extraer, lengthScaleOf } from "./geometryCore";

export type GeometryRequest = { bytes: Uint8Array; wasmPath: string; modelId: string };

export type GeometryResponse =
  | { type: "progress"; stage: string; progress: number | null }
  | { type: "done"; geometry: ModelGeometry }
  | { type: "error"; message: string };

const scope = self as unknown as {
  postMessage(message: GeometryResponse, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<GeometryRequest>) => void) | null;
};

scope.onmessage = async (event) => {
  const api = new WebIFC.IfcAPI();
  let modelID = -1;
  try {
    api.SetWasmPath(event.data.wasmPath, true);
    await api.Init();
    scope.postMessage({ type: "progress", stage: "Leyendo IFC", progress: null });
    modelID = api.OpenModel(event.data.bytes, { COORDINATE_TO_ORIGIN: false });
    if (modelID < 0) throw new Error("web-ifc no pudo abrir el modelo.");
    const geometry = extraer(api, modelID, event.data.modelId, lengthScaleOf(api, modelID), (stage, progress) =>
      scope.postMessage({ type: "progress", stage, progress }),
    );
    scope.postMessage({ type: "done", geometry }, geometry.elements.map((e) => e.points.buffer as ArrayBuffer));
  } catch (error) {
    scope.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) });
  } finally {
    if (modelID >= 0) api.CloseModel(modelID);
  }
};
