"use client";

import { useRef } from "react";
import type { LoadedModel } from "@/viewer/web";
import type { ModeloGuardado } from "@/lib/proyecto/guardar";
import { Alertas, type Alerta } from "./Alerta";
import { FragmentRow } from "./ElementoPanel";

export interface LogLine {
  level: "info" | "warn" | "error";
  message: string;
  at: number;
}

interface Props {
  models: LoadedModel[];
  alerts: Alerta[];
  logs: LogLine[];
  ready: boolean;
  project: { id: string | null; nombre: string; saving: boolean; expected: ModeloGuardado[] };
  onNombre(nombre: string): void;
  onSave(): void;
  onOpen(files: FileList): void;
  onVisible(modelId: string, visible: boolean): void;
  onUnload(modelId: string): void;
}

/** Pestaña Proyecto: nombre y guardado en la nube, modelos IFC federados, clases y registro. */
export default function ProyectoPanel({ models, alerts, logs, ready, project, onNombre, onSave, onOpen, onVisible, onUnload }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const missing = project.expected.filter((m) => !models.some((x) => x.sha256 === m.sha256));
  return (
    <div className="panel">
      <h2>Proyecto</h2>
      <Alertas items={alerts} />
      <div style={{ display: "flex", gap: 6 }}>
        <input className="input" placeholder="Nombre del proyecto" value={project.nombre} onChange={(e) => onNombre(e.target.value)} aria-label="Nombre del proyecto" />
        <button className="btn btn-primary" disabled={project.saving || !project.nombre.trim()} onClick={onSave} title="Guarda el proyecto, los modelos (nombre y huella), el predio y la última revisión en su cuenta. El IFC no se sube.">
          {project.saving ? "Guardando…" : project.id ? "Guardar" : "Guardar proyecto"}
        </button>
      </div>
      {missing.length > 0 && (
        <div className="alert alert-warn small">
          Abra los IFC de este proyecto desde su equipo: {missing.map((m) => m.nombre_archivo).join(", ")}. Se reconocen por su huella SHA-256.
        </div>
      )}
      <h2>Modelos IFC ({models.length})</h2>
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
            {m.classes.slice(0, 40).map((c) => (
              <FragmentRow key={c.ifcClass} name={c.ifcClass} value={c.count.toLocaleString("es-CL")} />
            ))}
          </dl>
        </details>
      ))}
      {logs.length > 0 && (
        <>
          <h2>Registro</h2>
          {logs
            .slice()
            .reverse()
            .map((l) => (
              <div key={l.at + l.message} className={`small ${l.level === "error" ? "alert alert-danger" : l.level === "warn" ? "alert alert-warn" : "muted"}`}>
                {l.message}
              </div>
            ))}
        </>
      )}
    </div>
  );
}
