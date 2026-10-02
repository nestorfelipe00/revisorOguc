"use client";

import { useRef } from "react";
import type { LoadedModel } from "@/viewer/web";
import { describeGeolocation } from "@/lib/territorio/location";
import type { ModeloGuardado } from "@/lib/proyecto/guardar";
import { Alertas, type Alerta } from "./Alerta";
import { FragmentRow } from "./ElementoPanel";

interface Props {
  models: LoadedModel[];
  alerts: Alerta[];
  ready: boolean;
  /** Modelos que el proyecto guardado espera (nombre y huella), para avisar cuáles faltan por abrir. */
  expected: ModeloGuardado[];
  onOpen(files: FileList): void;
  onVisible(modelId: string, visible: boolean): void;
  onUnload(modelId: string): void;
}

/** Panel izquierdo «IFC»: los modelos abiertos, sus clases, su huella y su georreferencia declarada. */
export default function ModelosPanel({ models, alerts, ready, expected, onOpen, onVisible, onUnload }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const missing = expected.filter((m) => !models.some((x) => x.sha256 === m.sha256));
  return (
    <div className="panel">
      <h2>Modelos IFC ({models.length})</h2>
      <Alertas items={alerts} />
      {missing.length > 0 && (
        <div className="alert alert-warn small">
          Abra los IFC de este proyecto desde su equipo: {missing.map((m) => m.nombre_archivo).join(", ")}. Se reconocen por su huella SHA-256.
        </div>
      )}
      <input ref={input} type="file" accept=".ifc" multiple hidden disabled={!ready} onChange={(e) => e.target.files && (onOpen(e.target.files), (e.target.value = ""))} />
      {models.length === 0 && <p className="muted small">Abra uno o más archivos IFC (hasta 100 MB cada uno). Los modelos se federan en el mismo visor y no salen de su navegador.</p>}
      <div className="model-list">
        {models.map((m) => (
          <div className="row" key={m.modelId}>
            <input type="checkbox" defaultChecked title="Visible" onChange={(e) => onVisible(m.modelId, e.target.checked)} />
            <span className="name" title={m.name}>
              {m.name}
            </span>
            <span className="badge">{m.elementCount.toLocaleString("es-CL")}</span>
            <button className="btn small" title="Cerrar modelo" onClick={() => onUnload(m.modelId)}>
              ✕
            </button>
          </div>
        ))}
      </div>
      <button className="btn" disabled={!ready} onClick={() => input.current?.click()}>
        + Agregar IFC
      </button>
      {models.map((m) => (
        <details key={`${m.modelId}-detalles`} className="pset">
          <summary>
            {m.name} · {m.meta?.schema ?? "?"} · {(m.bytes / 1048576).toFixed(1)} MB
          </summary>
          <dl className="kv">
            <dt>SHA-256</dt>
            <dd className="small mono" style={{ wordBreak: "break-all" }}>
              {m.sha256}
            </dd>
            <dt>Elementos</dt>
            <dd>{m.elementCount.toLocaleString("es-CL")}</dd>
          </dl>
          <div className="small muted" style={{ margin: "6px 0 2px" }}>
            Georreferencia declarada
          </div>
          {(m.meta ? describeGeolocation(m.meta.geolocation) : ["⚠ No se pudieron leer los metadatos del IFC."]).map((l) => (
            <div key={l} className={`small ${l.startsWith("⚠") ? "alert alert-warn" : "muted"}`}>
              {l.replace(/^⚠\s*/, "")}
            </div>
          ))}
          <div className="small muted" style={{ margin: "6px 0 2px" }}>
            Clases IFC
          </div>
          <dl className="kv">
            {m.classes.slice(0, 60).map((c) => (
              <FragmentRow key={c.ifcClass} name={c.ifcClass} value={c.count.toLocaleString("es-CL")} />
            ))}
          </dl>
        </details>
      ))}
    </div>
  );
}
