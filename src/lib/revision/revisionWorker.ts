// Motor de reglas en un Web Worker: la evaluación no congela la interfaz. Recibe la normativa ya descargada (JSON) y la
// entrada de la revisión; devuelve el mismo resultado que GeometricRuleEngine / CabidaStudy del escritorio.
import { NormCatalog, evaluarCabida, evaluarReglas } from "@/lib/reglas";
import type { CabidaEvaluation, RuleEvaluation, RuleInput } from "@/lib/reglas/tipos";

export type RevisionRequest =
  | { type: "reglas"; oguc: unknown; local: unknown | null; input: RuleInput }
  | { type: "cabida"; oguc: unknown; local: unknown | null; input: RuleInput; floorHeight: number };

export type RevisionResponse = { type: "done"; evaluation: RuleEvaluation | CabidaEvaluation } | { type: "error"; message: string };

const scope = self as unknown as { postMessage(message: RevisionResponse, transfer?: Transferable[]): void; onmessage: ((event: MessageEvent<RevisionRequest>) => void) | null };

scope.onmessage = (event) => {
  const request = event.data;
  try {
    const norms = new NormCatalog(request.oguc, request.local);
    const evaluation = request.type === "cabida" ? evaluarCabida(norms, request.input, request.floorHeight) : evaluarReglas(norms, request.input);
    const transfer: Transferable[] = evaluation.volume ? [evaluation.volume.heights.buffer] : [];
    scope.postMessage({ type: "done", evaluation }, transfer);
  } catch (error) {
    scope.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }
};
