"use client";

import { Alertas, type Alerta } from "./Alerta";

export interface LogLine {
  level: "info" | "warn" | "error";
  message: string;
  at: number;
}

interface Props {
  alerts: Alerta[];
  logs: LogLine[];
  project: { id: string | null; nombre: string; saving: boolean };
  onNombre(nombre: string): void;
  onSave(): void;
}

/** Pestaña Proyecto: nombre, guardado en la nube y registro. Los modelos IFC viven en el panel izquierdo. */
export default function ProyectoPanel({ alerts, logs, project, onNombre, onSave }: Props) {
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
      <p className="muted small">Se guardan el nombre, los modelos (nombre y huella SHA-256), la ubicación, el predio y la última revisión. El archivo IFC no sale de su equipo.</p>
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
