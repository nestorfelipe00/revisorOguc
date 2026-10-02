"use client";

import { useState } from "react";
import { RULE_STATE_LABELS, citation, type CabidaEvaluation, type RuleEvaluation, type RuleResult, type RuleState } from "@/lib/reglas/tipos";
import { rasanteSections } from "@/lib/revision/escena";
import { Alertas, alerta, type Alerta } from "./Alerta";

export interface Revision {
  tipo: "revision" | "cabida";
  evaluation: RuleEvaluation | CabidaEvaluation;
  /** Primera línea del estado (zona, predio, conteos); las advertencias van como alertas. */
  statusLine: string;
}

interface Props {
  revision: Revision | null;
  reviewing: boolean;
  progress: string | null;
  alerts: Alerta[];
  isSiteStudy: boolean;
  floorHeight: string;
  onFloorHeight(value: string): void;
  onRun(): void;
  onCancel(): void;
  onShowElements(result: RuleResult): void;
  /** Informe de la última revisión: PDF (impresión del navegador), Excel o JSON `bnc-report/1`. */
  onExport(format: FormatoInforme): void;
}

export type FormatoInforme = "pdf" | "xlsx" | "json";

const CHIP: Record<RuleState, string> = {
  Cumple: "var(--accent)",
  NoCumple: "var(--danger)",
  RevisionRequerida: "var(--warn)",
  NoVerificable: "var(--info)",
  NoAplica: "var(--muted)",
  Informativo: "var(--accent-2)",
};

/** Pestaña Revisión: resumen, reglas R-01…R-11 (o C-… de la cabida) con estado, exigido, medido, fuentes y elementos. */
export default function RevisionPanel({ revision, reviewing, progress, alerts, isSiteStudy, floorHeight, onFloorHeight, onRun, onCancel, onShowElements, onExport }: Props) {
  const results = revision?.evaluation.results ?? [];
  const count = (s: RuleState) => results.filter((r) => r.state === s).length;
  const others = results.length - count("Cumple") - count("NoCumple") - count("RevisionRequerida");
  const sections = rasanteSections(revision?.evaluation.rasantes);
  return (
    <div className="panel">
      <h2>Revisión normativa</h2>
      {results.length > 0 && (
        <div className="chips">
          <span className="chip" style={{ background: CHIP.Cumple }}>{count("Cumple")} cumple</span>
          <span className="chip" style={{ background: CHIP.NoCumple }}>{count("NoCumple")} no cumple</span>
          <span className="chip" style={{ background: CHIP.RevisionRequerida }}>{count("RevisionRequerida")} revisión requerida</span>
          {others > 0 && (
            <span className="chip" style={{ background: "var(--muted)" }} title="No verificable, no aplica e informativo">
              {others} otras
            </span>
          )}
        </div>
      )}
      <Alertas items={alerts} />
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <button className="btn btn-primary" disabled={reviewing} onClick={onRun} title="Altura, rasantes, distanciamientos, adosamiento, antejardín, coeficientes y volumen teórico (OGUC + Ordenanza Local)">
          {isSiteStudy ? "Calcular cabida" : "Revisar normativa geométrica"}
        </button>
        {reviewing && (
          <button className="btn" onClick={onCancel}>
            Cancelar revisión
          </button>
        )}
      </div>
      {results.length > 0 && !reviewing && (
        <div className="small" style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          <span className="muted">Informe</span>
          <button className="btn small" onClick={() => onExport("pdf")} title="Abre el diálogo de impresión del navegador: elija «Guardar como PDF»">
            PDF
          </button>
          <button className="btn small" onClick={() => onExport("xlsx")} title="Libro Excel: Resumen, Reglas, Fuentes, Elementos, Predio y Modelos">
            Excel
          </button>
          <button className="btn small" onClick={() => onExport("json")} title="JSON bnc-report/1 para otros programas">
            JSON
          </button>
        </div>
      )}
      {isSiteStudy && (
        <div className="small" style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span className="muted">Piso a piso (m)</span>
          <input className="input" style={{ width: 70 }} value={floorHeight} onChange={(e) => onFloorHeight(e.target.value)} aria-label="Piso a piso" title="Supuesto de diseño para repartir la cabida en pisos (no es una norma)" />
          <span className="muted">supuesto de diseño</span>
        </div>
      )}
      {progress && <div className="muted small">{progress}</div>}
      {revision?.statusLine && <div className="muted small">{revision.statusLine}</div>}
      {!revision && !reviewing && <p className="muted small">Sin revisión ejecutada. Con el predio definido, pulse «Revisar normativa geométrica» (con modelo) o «Calcular cabida» (sin modelo).</p>}
      {revision && "floors" in revision.evaluation && revision.evaluation.floors.length > 0 && (
        <details className="pset" open>
          <summary>Pisos de la cabida</summary>
          <dl className="kv">
            {revision.evaluation.floors.map((f) => (
              <FloorRow key={f.number} n={f.number} base={f.base} top={f.top} area={f.area} />
            ))}
          </dl>
        </details>
      )}
      {results.map((r) => (
        <Regla key={r.id} result={r} onShowElements={onShowElements} sections={r.id === "R-02" ? sections : []} />
      ))}
    </div>
  );
}

function FloorRow({ n, base, top, area }: { n: number; base: number; top: number; area: number }) {
  const f = (v: number) => v.toLocaleString("es-CL", { maximumFractionDigits: 1 });
  return (
    <>
      <dt>Piso {n}</dt>
      <dd>
        {f(base)}–{f(top)} m · hasta {f(area)} m²
      </dd>
    </>
  );
}

function Regla({ result, onShowElements, sections }: { result: RuleResult; onShowElements(r: RuleResult): void; sections: ReturnType<typeof rasanteSections> }) {
  const [open, setOpen] = useState(false);
  const r = result;
  const elementsText =
    r.elements.length === 0
      ? ""
      : r.elements
          .slice(0, 12)
          .map((e) => `#${e.expressId} ${e.ifcClass}${e.name ? ` «${e.name}»` : ""}: ${e.detail}`)
          .join("\n") + (r.elements.length > 12 ? `\n… y ${r.elements.length - 12} más` : "");
  const noteAlerts: Alerta[] = r.notes.map((n) => (n.startsWith("⚠") ? alerta(n.replace(/^⚠\s*/, ""), "warn") : alerta(n, "info")));
  return (
    <div className="regla">
      <button className="regla-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="chip" style={{ background: CHIP[r.state] }}>{RULE_STATE_LABELS[r.state]}</span>
        <span>
          <strong>
            {r.id} {r.title}
          </strong>
          <div className="muted small">{r.summary}</div>
        </span>
      </button>
      {open && (
        <div className="regla-body small">
          {r.required && (
            <div>
              <span className="muted">Exigido: </span>
              {r.required}
            </div>
          )}
          {r.measured && (
            <div>
              <span className="muted">Medido: </span>
              {r.measured}
            </div>
          )}
          {sections.map((s) => (
            <div key={s.title} className="pset">
              <strong>{s.title}</strong>
              <div className="muted">{s.caption}</div>
            </div>
          ))}
          {r.sources.map((s, i) => (
            <div key={i} style={{ marginTop: 4 }}>
              <strong>{citation(s)}</strong>
              <div className="muted" style={{ fontStyle: "italic" }}>
                {s.quote}
              </div>
              {s.version && <div className="muted">{s.version}</div>}
              {s.url && (
                <a href={s.url} target="_blank" rel="noreferrer noopener">
                  Ver fuente oficial ↗
                </a>
              )}
            </div>
          ))}
          <Alertas items={noteAlerts} />
          {elementsText && <pre className="mono small" style={{ whiteSpace: "pre-wrap", margin: "4px 0" }}>{elementsText}</pre>}
          {r.elements.length > 0 && (
            <button className="btn small" onClick={() => onShowElements(r)}>
              Ver en modelo ({r.elements.length})
            </button>
          )}
        </div>
      )}
    </div>
  );
}
