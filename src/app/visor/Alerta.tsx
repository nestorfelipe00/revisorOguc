"use client";

/** Alerta tipada de una pestaña (mismo criterio que la app de escritorio: cada pestaña muestra solo las suyas). */
export type Severidad = "info" | "warn" | "danger" | "ok";

export interface Alerta {
  text: string;
  severity: Severidad;
  url?: string | null;
}

export const alerta = (text: string, severity: Severidad = "warn", url: string | null = null): Alerta => ({ text, severity, url });

/** Advertencias del escritorio vienen con «⚠» delante: se quita y se vuelve severidad. */
export const alertaDeTexto = (text: string, topicInfo = false): Alerta =>
  text.startsWith("⚠") ? alerta(text.replace(/^⚠\s*/, ""), "warn") : alerta(text, topicInfo ? "info" : "info");

export function Alertas({ items }: { items: Alerta[] }) {
  if (items.length === 0) return null;
  return (
    <div className="alertas">
      {items.map((a, i) => (
        <div key={`${i}-${a.text}`} className={`alert alert-${a.severity} small`}>
          <span>{a.text}</span>
          {a.url && (
            <>
              {" "}
              <a href={a.url} target="_blank" rel="noreferrer noopener">
                Ver fuente oficial ↗
              </a>
            </>
          )}
        </div>
      ))}
    </div>
  );
}
