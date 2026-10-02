// Lado del hilo principal del worker de reglas: una evaluación a la vez, cancelable.
import type { CabidaEvaluation, RuleEvaluation } from "@/lib/reglas/tipos";
import type { RevisionRequest, RevisionResponse } from "./revisionWorker";

export class RevisionCancelada extends Error {
  constructor() {
    super("Revisión cancelada.");
  }
}

export interface EjecucionRevision<T> {
  result: Promise<T>;
  cancel(): void;
}

function ejecutar<T extends RuleEvaluation>(request: RevisionRequest): EjecucionRevision<T> {
  const worker = new Worker(new URL("./revisionWorker.ts", import.meta.url), { type: "module" });
  // Los puntos se copian (no se transfieren): la geometría en caché se vuelve a usar en la siguiente revisión.
  let rejectRun: (reason: Error) => void = () => {};
  const result = new Promise<T>((resolve, reject) => {
    rejectRun = reject;
    worker.onmessage = (event: MessageEvent<RevisionResponse>) => {
      worker.terminate();
      if (event.data.type === "done") resolve(event.data.evaluation as T);
      else reject(new Error(event.data.message));
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message || "No se pudo iniciar el motor de reglas en segundo plano."));
    };
    worker.postMessage(request);
  });
  return {
    result,
    cancel: () => {
      worker.terminate();
      rejectRun(new RevisionCancelada());
    },
  };
}

export const evaluarReglasEnWorker = (request: Extract<RevisionRequest, { type: "reglas" }>) => ejecutar<RuleEvaluation>(request);

export const evaluarCabidaEnWorker = (request: Extract<RevisionRequest, { type: "cabida" }>) => ejecutar<CabidaEvaluation>(request);
