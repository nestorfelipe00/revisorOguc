// Conversión IFC → fragments en un Web Worker: web-ifc es intensivo y, en el hilo principal,
// congelaba la navegación del visor mientras se procesaba un modelo grande.
import { convertIfc } from "./ifcConvert";

export type WorkerRequest = { bytes: Uint8Array; wasmPath: string };

export type WorkerResponse =
  | { type: "progress"; progress: number }
  | { type: "done"; bytes: Uint8Array }
  | { type: "error"; message: string };

const scope = self as unknown as {
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
};

scope.onmessage = async (event) => {
  try {
    const bytes = await convertIfc(event.data.bytes, event.data.wasmPath, (progress) =>
      scope.postMessage({ type: "progress", progress }),
    );
    scope.postMessage({ type: "done", bytes }, [bytes.buffer]);
  } catch (error) {
    scope.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }
};
