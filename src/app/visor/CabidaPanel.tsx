"use client";

import { useState } from "react";
import { RULE_STATE_LABELS, citation, type CabidaPreliminar, type ItemCabida, type NormSource, type PasoDesarrollo, type RestriccionCabida, type RuleState } from "@/lib/reglas/tipos";
import type { ZoneNorms } from "@/lib/reglas/normas";
import type { AjustesCabida, OrigenNorma } from "@/lib/reglas/cabidaPreliminar";
import { formatNumber } from "@/lib/territorio/colocacion";
import { Alertas, alerta, type Alerta } from "./Alerta";
import CabidaLaminas, { type Lamina } from "./CabidaLaminas";
import type { FormatoInforme } from "./RevisionPanel";

interface Props {
  alerts: Alerta[];
  ajustes: AjustesCabida;
  onAjustes(next: AjustesCabida): void;
  floorHeight: string;
  onFloorHeight(value: string): void;
  /** Ficha de la zona principal del predio (cifras «PRC (automático)»); null si no hay. */
  zona: ZoneNorms | null;
  preliminar: CabidaPreliminar | null;
  laminas: Lamina[];
  reviewing: boolean;
  progress: string | null;
  exporting: boolean;
  onCalcular(): void;
  onCancel(): void;
  onExport(format: FormatoInforme): void;
}

const CHIP: Record<RuleState, string> = {
  Cumple: "var(--accent)",
  NoCumple: "var(--danger)",
  RevisionRequerida: "var(--warn)",
  NoVerificable: "var(--info)",
  NoAplica: "var(--muted)",
  Informativo: "var(--accent-2)",
};

const f = (v: number | null | undefined, d = 2) => (v === null || v === undefined ? "—" : formatNumber(v, d));

/** Pestaña Cabida: estudio preliminar de un edificio de departamentos con su desarrollo, tabla por piso, restricciones y láminas. */
export default function CabidaPanel(props: Props) {
  const { alerts, ajustes, onAjustes, floorHeight, onFloorHeight, zona, preliminar, laminas, reviewing, progress, exporting, onCalcular, onCancel, onExport } = props;
  const set = (patch: Partial<AjustesCabida>) => onAjustes({ ...ajustes, ...patch });
  const prc = (value: number | null | undefined, unit = "") => (value === null || value === undefined ? "sin dato en la ficha" : `${formatNumber(value, 4)}${unit}`);

  return (
    <div className="panel">
      <h2>Cabida preliminar</h2>
      <Alertas items={alerts} />
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <button
          className="btn btn-primary"
          disabled={reviewing}
          onClick={onCalcular}
          title="Volumen teórico 3D (altura, rasantes, distanciamientos y antejardín): acota pisos y departamentos y se dibuja en el visor"
        >
          Calcular cabida
        </button>
        {reviewing && (
          <button className="btn" onClick={onCancel}>
            Cancelar
          </button>
        )}
      </div>
      {progress && <div className="muted small">{progress}</div>}
      {preliminar && (
        <div className="small" style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          <span className="muted">Informe de cabida</span>
          <button className="btn small" disabled={exporting} onClick={() => onExport("pdf")} title="Abre el diálogo de impresión: elija «Guardar como PDF». Incluye el desarrollo, las láminas y la isométrica del visor">
            PDF
          </button>
          <button className="btn small" disabled={exporting} onClick={() => onExport("xlsx")} title="Libro Excel con la hoja «Cabida»: entradas, desarrollo y tabla por piso">
            Excel
          </button>
          <button className="btn small" disabled={exporting} onClick={() => onExport("json")} title="JSON bnc-report/1 con la clave cabidaPreliminar">
            JSON
          </button>
          {exporting && <span className="muted">Preparando…</span>}
        </div>
      )}

      <details className="pset" open>
        <summary>Normas de la zona{zona ? ` ${zona.zone}` : ""}</summary>
        <div className="cabida-grid small">
          <Norma
            label="Ocupación de suelo"
            origen={ajustes.ocupacion.origen}
            prc={prc(zona?.landCoverage)}
            valor={ajustes.ocupacion.valor}
            onOrigen={(origen) => set({ ocupacion: { ...ajustes.ocupacion, origen } })}
            onValor={(valor) => set({ ocupacion: { ...ajustes.ocupacion, valor } })}
          />
          <Norma
            label="Constructibilidad"
            origen={ajustes.constructibilidad.origen}
            prc={prc(zona?.floorAreaRatio)}
            valor={ajustes.constructibilidad.valor}
            onOrigen={(origen) => set({ constructibilidad: { ...ajustes.constructibilidad, origen } })}
            onValor={(valor) => set({ constructibilidad: { ...ajustes.constructibilidad, valor } })}
          />
          <Norma
            label="Altura máxima (m)"
            origen={ajustes.altura.origen}
            prc={zona?.heightFree && zona.maxHeight === null ? "sin tope (rasantes)" : prc(zona?.maxHeight, " m")}
            valor={ajustes.altura.metros}
            onOrigen={(origen) => set({ altura: { ...ajustes.altura, origen } })}
            onValor={(metros) => set({ altura: { ...ajustes.altura, metros } })}
          />
          <span className="muted">Pisos máximos</span>
          <span className="muted">{ajustes.altura.origen === "PRC" ? "según la ficha" : "CIP"}</span>
          {ajustes.altura.origen === "PRC" ? (
            <input className="input" disabled value={prc(zona?.maxFloors, " pisos")} aria-label="Pisos máximos (PRC)" />
          ) : (
            <input className="input" value={ajustes.altura.pisos} placeholder="opcional" onChange={(e) => set({ altura: { ...ajustes.altura, pisos: e.target.value } })} aria-label="Pisos máximos (CIP)" />
          )}
          <span className="muted">Densidad (hab/ha)</span>
          <select className="input" value={ajustes.densidad.origen} onChange={(e) => set({ densidad: { ...ajustes.densidad, origen: e.target.value as AjustesCabida["densidad"]["origen"] } })} aria-label="Origen de la densidad">
            <option value="PRC">PRC (automático)</option>
            <option value="CIP">CIP</option>
            <option value="Libre">Libre (según CIP)</option>
          </select>
          {ajustes.densidad.origen === "CIP" ? (
            <input className="input" value={ajustes.densidad.valor} placeholder="valor del CIP" onChange={(e) => set({ densidad: { ...ajustes.densidad, valor: e.target.value } })} aria-label="Densidad (CIP)" />
          ) : (
            <input className="input" disabled value={ajustes.densidad.origen === "Libre" ? "sin tope" : "sin dato en la base"} aria-label="Densidad (PRC)" />
          )}
          <span className="muted">Estacionamientos por depto.</span>
          <span className="muted">CIP</span>
          <input className="input" value={ajustes.razonEstacionamientos} placeholder="dato del CIP" onChange={(e) => set({ razonEstacionamientos: e.target.value })} aria-label="Estacionamientos por departamento" />
        </div>
      </details>

      <details className="pset" open>
        <summary>Supuestos de diseño (editables)</summary>
        <div className="cabida-grid cabida-grid-2 small">
          <Campo label="Piso a piso (m)" value={floorHeight} onChange={onFloorHeight} />
          <Campo label="m² útiles promedio por depto." value={ajustes.m2Departamento} onChange={(m2Departamento) => set({ m2Departamento })} />
          <span className="muted">Mezcla 1D / 2D / 3D (%)</span>
          <span style={{ display: "flex", gap: 4 }}>
            {ajustes.mezcla.map((m, i) => (
              <input
                key={i}
                className="input"
                value={m}
                onChange={(e) => set({ mezcla: ajustes.mezcla.map((x, j) => (j === i ? e.target.value : x)) as AjustesCabida["mezcla"] })}
                aria-label={`Mezcla ${i + 1}D (%)`}
              />
            ))}
          </span>
          <Campo label="Circulaciones y muros (%)" value={ajustes.circulaciones} onChange={(circulaciones) => set({ circulaciones })} />
          <Campo label="Habitantes por vivienda" value={ajustes.habPorVivienda} onChange={(habPorVivienda) => set({ habPorVivienda })} />
          <Campo label="m² por estacionamiento" value={ajustes.m2Estacionamiento} onChange={(m2Estacionamiento) => set({ m2Estacionamiento })} />
        </div>
      </details>

      {preliminar && (
        <>
          <div className="chips">
            <span className="chip" style={{ background: "var(--accent-2)" }}>{f(preliminar.construible, 1)} m² construibles</span>
            <span className="chip" style={{ background: "var(--accent-2)" }}>{preliminar.departamentos ?? "—"} deptos.</span>
            <span className="chip" style={{ background: "var(--accent-2)" }}>{preliminar.numeroPisos ?? "—"} pisos</span>
            <span className="chip" style={{ background: "var(--accent-2)" }}>{preliminar.estacionamientos ?? "—"} estac.</span>
          </div>
          {preliminar.items.map((item) => (
            <Item key={item.id} item={item} />
          ))}
          {preliminar.pisos.length > 0 && (
            <details className="pset" open>
              <summary>Tabla por piso</summary>
              <table className="cabida-tabla small">
                <thead>
                  <tr>
                    <th>Piso</th>
                    <th>m²</th>
                    <th>Útil</th>
                    <th>Dptos.</th>
                    <th>1D/2D/3D</th>
                  </tr>
                </thead>
                <tbody>
                  {preliminar.pisos.map((p) => (
                    <tr key={p.numero}>
                      <td>
                        {p.numero} <span className="muted">+{f(p.top)}</span>
                      </td>
                      <td>{f(p.superficie, 1)}</td>
                      <td>{f(p.util, 1)}</td>
                      <td>{p.departamentos}</td>
                      <td>{p.mezcla.join(" / ")}</td>
                    </tr>
                  ))}
                  <tr className="total">
                    <td>Total</td>
                    <td>{f(preliminar.pisos.reduce((s, p) => s + p.superficie, 0), 1)}</td>
                    <td>{f(preliminar.pisos.reduce((s, p) => s + p.util, 0), 1)}</td>
                    <td>{preliminar.pisos.reduce((s, p) => s + p.departamentos, 0)}</td>
                    <td>{[0, 1, 2].map((t) => preliminar.pisos.reduce((s, p) => s + p.mezcla[t], 0)).join(" / ")}</td>
                  </tr>
                </tbody>
              </table>
            </details>
          )}
          <h2>Restricciones adicionales</h2>
          {preliminar.restricciones.map((r) => (
            <Restriccion key={r.id} r={r} />
          ))}
          <h2>Láminas</h2>
          <CabidaLaminas laminas={laminas} />
        </>
      )}
    </div>
  );
}

function Norma({ label, origen, prc, valor, onOrigen, onValor }: { label: string; origen: OrigenNorma; prc: string; valor: string; onOrigen(o: OrigenNorma): void; onValor(v: string): void }) {
  return (
    <>
      <span className="muted">{label}</span>
      <select className="input" value={origen} onChange={(e) => onOrigen(e.target.value as OrigenNorma)} aria-label={`Origen: ${label}`}>
        <option value="PRC">PRC (automático)</option>
        <option value="CIP">CIP</option>
      </select>
      {origen === "PRC" ? (
        <input className="input" disabled value={prc} aria-label={`${label} (PRC)`} />
      ) : (
        <input className="input" value={valor} placeholder="valor del CIP" onChange={(e) => onValor(e.target.value)} aria-label={`${label} (CIP)`} />
      )}
    </>
  );
}

function Campo({ label, value, onChange }: { label: string; value: string; onChange(v: string): void }) {
  return (
    <>
      <span className="muted">{label}</span>
      <input className="input" value={value} onChange={(e) => onChange(e.target.value)} aria-label={label} />
    </>
  );
}

function Fuentes({ sources }: { sources: NormSource[] }) {
  return (
    <>
      {sources.map((s, i) => (
        <div key={i} style={{ marginTop: 4 }}>
          <strong>{citation(s)}</strong>
          <div className="muted" style={{ fontStyle: "italic" }}>
            «{s.quote}»
          </div>
          {s.url && (
            <a href={s.url} target="_blank" rel="noreferrer noopener">
              Ver fuente oficial ↗
            </a>
          )}
        </div>
      ))}
    </>
  );
}

function Paso({ paso }: { paso: PasoDesarrollo }) {
  return (
    <div className="paso">
      <div>
        <strong>{paso.concepto}</strong>
      </div>
      <div className="mono">{paso.formula}</div>
      <div className="mono">{paso.sustitucion}</div>
      <div className="mono">
        = <strong>{paso.resultado !== null ? `${formatNumber(paso.resultado, 2)} ${paso.unidad}` : "sin resultado"}</strong>
      </div>
      {paso.supuestos.map((s, i) => (
        <div key={i} className="muted">
          Supuesto: {s}
        </div>
      ))}
      {paso.fuentes.length > 0 && <div className="muted">Fuente: {paso.fuentes.map((s) => citation(s)).join(" · ")}</div>}
    </div>
  );
}

function Item({ item }: { item: ItemCabida }) {
  const [open, setOpen] = useState(false);
  const notes: Alerta[] = item.notas.map((n) => (n.startsWith("⚠") ? alerta(n.replace(/^⚠\s*/, ""), "warn") : alerta(n, n.includes("dato faltante") ? "warn" : "info")));
  return (
    <div className="regla">
      <button className="regla-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="chip" style={{ background: CHIP[item.estado] }}>{RULE_STATE_LABELS[item.estado]}</span>
        <span>
          <strong>
            {item.id} {item.titulo}
          </strong>
          <div className="muted small">{item.resumen}</div>
        </span>
      </button>
      {open && (
        <div className="regla-body small">
          {item.desarrollo.map((p, i) => (
            <Paso key={i} paso={p} />
          ))}
          <Fuentes sources={item.fuentes} />
          <Alertas items={notes} />
        </div>
      )}
    </div>
  );
}

function Restriccion({ r }: { r: RestriccionCabida }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="regla">
      <button className="regla-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="chip" style={{ background: CHIP[r.estado] }}>{RULE_STATE_LABELS[r.estado]}</span>
        <span>
          <strong>{r.titulo}</strong>
          <div className="muted small">{r.texto}</div>
        </span>
      </button>
      {open && (
        <div className="regla-body small">
          {r.fuentes.length > 0 ? <Fuentes sources={r.fuentes} /> : <div className="muted">Sin cita: la base normativa no tiene el dato.</div>}
        </div>
      )}
    </div>
  );
}
