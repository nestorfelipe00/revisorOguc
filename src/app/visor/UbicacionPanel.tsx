"use client";

import type { TerritorialAnalysis } from "@/lib/territorio/consulta";
import type { ProjectLocation } from "@/lib/territorio/location";
import { Alertas, type Alerta } from "./Alerta";

export interface Territorio {
  location: ProjectLocation | null;
  analysis: TerritorialAnalysis | null;
  error: string | null;
  loading: boolean;
}

interface Props {
  territory: Territorio | null;
  alerts: Alerta[];
  hasModels: boolean;
}

/** Pestaña Ubicación: comuna, región, instrumento, zonas del PRC con su ficha y fuentes. Solo sus alertas. */
export default function UbicacionPanel({ territory, alerts, hasModels }: Props) {
  const analysis = territory?.analysis ?? null;
  return (
    <div className="panel">
      <h2>Ubicación y plan regulador</h2>
      <Alertas items={alerts} />
      {!territory?.location && (
        <p className="muted small">
          {hasModels
            ? "Leyendo la georreferencia del modelo…"
            : "La comuna y la zona del PRC aparecen al abrir un IFC (georreferencia, coordenadas UTM o IfcSite) o al indicar la ubicación en la pestaña Coordenadas."}
        </p>
      )}
      {territory?.loading && <div className="muted small">Consultando la normativa…</div>}
      {analysis && (
        <dl className="kv">
          {analysis.comuna && (
            <>
              <dt>Comuna</dt>
              <dd>{analysis.comuna.nombre}</dd>
              <dt>Región</dt>
              <dd>{analysis.comuna.region}</dd>
            </>
          )}
          {analysis.instrument && (
            <>
              <dt>Instrumento</dt>
              <dd>{analysis.coverage}</dd>
            </>
          )}
        </dl>
      )}
      {analysis && analysis.zones.length > 0 && (
        <>
          <h2>Zona del plan regulador</h2>
          <div className="model-list">
            {analysis.zones.map((z) => (
              <div className="row" key={`${z.layer}-${z.code}`}>
                <div className="name" style={{ whiteSpace: "normal" }}>
                  <strong>{z.code}</strong> {z.name !== z.code && <span>{z.name}</span>}
                  <div className="muted small">{z.layer}</div>
                </div>
                {z.sharePercent < 100 && <span className="badge">{z.sharePercent.toLocaleString("es-CL")} %</span>}
                {z.sheetUrl && (
                  <a className="btn small" href={z.sheetUrl} target="_blank" rel="noreferrer noopener">
                    Ficha
                  </a>
                )}
              </div>
            ))}
          </div>
        </>
      )}
      {analysis && analysis.plans.length > 0 && (
        <div className="muted small">
          También rige: {analysis.plans.map((p) => p.instrumento ?? p.nombre).join(", ")}.
        </div>
      )}
      {analysis && (
        <div className="small muted">
          {analysis.disclaimer}
          {analysis.ordinanceUrl && (
            <>
              {" · "}
              <a href={analysis.ordinanceUrl} target="_blank" rel="noreferrer noopener">
                Ordenanza Local ↗
              </a>
            </>
          )}
          {" · "}Fuente: {analysis.source}
        </div>
      )}
    </div>
  );
}
