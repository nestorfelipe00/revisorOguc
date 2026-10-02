"use client";

import type { ElementInfo } from "@/viewer/protocol";

export function FragmentRow({ name, value }: { name: string; value: string }) {
  return (
    <>
      <dt title={name}>{name}</dt>
      <dd>{value}</dd>
    </>
  );
}

interface Props {
  selection: { count: number; element: ElementInfo | null };
  search: string;
  onSearch(text: string): void;
  onLocate(): void;
}

/** Pestaña Elemento: localizar por identificador y propiedades del elemento seleccionado (índice de Fragments). */
export default function ElementoPanel({ selection, search, onSearch, onLocate }: Props) {
  const e = selection.element;
  return (
    <div className="panel">
      <h2>Localizar elemento</h2>
      <form
        style={{ display: "flex", gap: 6 }}
        onSubmit={(ev) => {
          ev.preventDefault();
          onLocate();
        }}
      >
        <input className="input mono" placeholder="#ExpressID o GlobalId" value={search} onChange={(ev) => onSearch(ev.target.value)} aria-label="Buscar elemento" />
        <button className="btn" type="submit" disabled={!search.trim()}>
          Localizar
        </button>
      </form>
      <h2>Elemento seleccionado</h2>
      {!e && <p className="muted small">Haga clic en un elemento del visor 3D o localícelo por su identificador para ver su clase, nivel, tipo, propiedades y cantidades.</p>}
      {e && (
        <>
          {selection.count > 1 && <span className="badge">{selection.count} elementos seleccionados · se muestra el primero</span>}
          <div>
            <strong style={{ color: "var(--accent)", fontSize: 16 }}>{e.ifcClass}</strong>
            <div>{e.name ?? "(sin nombre)"}</div>
            <div className="muted small mono">
              #{e.expressId}
              {e.globalId ? ` · ${e.globalId}` : ""}
            </div>
            {e.typeName && <div className="small">Tipo: {e.typeName}</div>}
          </div>
          <details className="pset" open>
            <summary>Atributos</summary>
            <dl className="kv">
              {e.attributes.map((a) => (
                <FragmentRow key={a.name} name={a.name} value={a.value} />
              ))}
            </dl>
          </details>
          <details className="pset" open>
            <summary>Propiedades y cantidades</summary>
            {e.propertySets.length === 0 && <p className="muted small">Sin conjuntos de propiedades.</p>}
            {e.propertySets.map((p, i) => (
              <details key={`${p.name}-${i}`} className="pset" open={i < 3}>
                <summary>{p.name || "(sin nombre)"}</summary>
                <dl className="kv">
                  {p.properties.map((q, j) => (
                    <FragmentRow key={`${q.name}-${j}`} name={q.name} value={q.value} />
                  ))}
                </dl>
              </details>
            ))}
          </details>
        </>
      )}
    </div>
  );
}
