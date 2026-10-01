"use client";

import { useState } from "react";
import type { LoadedModel } from "@/viewer/web";
import { SOURCE_LABELS } from "@/lib/territorio/location";
import type { Territory } from "./Workspace";

interface Props {
  territory: Territory | null;
  models: LoadedModel[];
  onRelocate: (point: { latitude: number; longitude: number }) => void;
  onUseIfc: () => void;
}

const fmt = (v: number, d = 5) => v.toLocaleString("es-CL", { minimumFractionDigits: d, maximumFractionDigits: d });

export default function TerritoryPanel({ territory, models, onRelocate, onUseIfc }: Props) {
  const [manual, setManual] = useState({ lat: "", lon: "" });
  if (models.length === 0) {
    return (
      <div className="panel">
        <p className="muted">Abra un IFC: el territorio se determina con su georreferencia (IfcMapConversion), sus coordenadas UTM o el IfcSite.</p>
      </div>
    );
  }
  if (!territory) return <div className="panel muted">Leyendo la georreferencia…</div>;
  const { location, analysis } = territory;
  const model = models.find((m) => m.modelId === territory.modelId);

  return (
    <div className="panel">
      <div className="muted small">Modelo: {model?.name}</div>
      <h2>Georreferencia del IFC</h2>
      {territory.geolocationLines.map((line) => (
        <div key={line} className={`small ${line.startsWith("⚠") ? "alert alert-warn" : ""}`}>
          {line}
        </div>
      ))}

      <h2>Ubicación del proyecto</h2>
      {!location && (
        <div className="alert alert-warn small">
          No se pudo determinar la ubicación: el IFC no trae georreferencia, coordenadas UTM ni un IfcSite en Chile. Indíquela abajo.
        </div>
      )}
      {location && (
        <dl className="kv">
          <dt>Fuente</dt>
          <dd>{SOURCE_LABELS[location.source]}</dd>
          <dt>Centro</dt>
          <dd>
            {fmt(location.center.latitude)}, {fmt(location.center.longitude)}
          </dd>
          {location.utm && (
            <>
              <dt>UTM</dt>
              <dd>
                {location.utm.zone}
                {location.utm.south ? "S" : "N"} · E {fmt(location.utm.easting, 1)} · N {fmt(location.utm.northing, 1)}
              </dd>
            </>
          )}
        </dl>
      )}
      {location?.notes.map((n) => (
        <div key={n} className={`small ${n.startsWith("⚠") ? "alert alert-warn" : "muted"}`}>
          {n}
        </div>
      ))}
      {location?.needsConfirmation && <div className="alert alert-warn small">Confirme la ubicación: la fuente es un supuesto o una aproximación.</div>}

      <h2>Plan regulador</h2>
      {territory.loading && <div className="muted small">Consultando la normativa…</div>}
      {territory.error && <div className="alert alert-danger small">{territory.error}</div>}
      {analysis && (
        <>
          <div>
            <strong>{analysis.coverage}</strong>
            {analysis.comuna && (
              <div className="muted small">
                Comuna {analysis.comuna.nombre} · Región {analysis.comuna.region}
              </div>
            )}
          </div>
          {analysis.zones.length > 0 && (
            <div className="model-list">
              {analysis.zones.map((z) => (
                <div className="row" key={`${z.layer}-${z.code}`}>
                  <div className="name" style={{ whiteSpace: "normal" }}>
                    <strong>{z.code}</strong> {z.name !== z.code && <span>{z.name}</span>}
                    <div className="muted small">{z.layer}</div>
                  </div>
                  <span className="badge">{z.sharePercent} %</span>
                  {z.sheetUrl && (
                    <a className="btn small" href={z.sheetUrl} target="_blank" rel="noreferrer noopener">
                      Ficha
                    </a>
                  )}
                </div>
              ))}
            </div>
          )}
          {analysis.specialAreas.length > 0 && (
            <>
              <h2>Áreas especiales</h2>
              {analysis.specialAreas.map((a, i) => (
                <div key={i} className="small">
                  {a.name} <span className="muted">· {a.layer}</span>
                  {a.sheetUrl && (
                    <>
                      {" "}
                      <a href={a.sheetUrl} target="_blank" rel="noreferrer noopener">
                        ficha
                      </a>
                    </>
                  )}
                </div>
              ))}
            </>
          )}
          {analysis.roads.length > 0 && (
            <>
              <h2>Fajas viales cercanas</h2>
              {analysis.roads.map((r) => (
                <div key={r.kind} className="alert alert-warn small">
                  Faja de {r.kind.toLowerCase()} a {r.distanceMeters} m: posible afectación a utilidad pública, verifíquelo en el CIP.
                </div>
              ))}
            </>
          )}
          {analysis.notes.map((n) => (
            <div key={n} className="alert small">
              {n}
            </div>
          ))}
          <div className="muted small">{analysis.disclaimer}</div>
          <div className="small">
            {analysis.ordinanceUrl && (
              <a href={analysis.ordinanceUrl} target="_blank" rel="noreferrer noopener">
                Ordenanza Local
              </a>
            )}
            {analysis.ordinanceUrl && " · "}
            <span className="muted">Fuente: {analysis.source}</span>
          </div>
          {analysis.instrument && !analysis.hasNorms && (
            <div className="alert alert-warn small">Esta comuna tiene zonificación pero aún no tiene las cifras de su Ordenanza verificadas: la revisión geométrica no podrá aplicar sus normas.</div>
          )}
        </>
      )}

      <h2>Indicar ubicación</h2>
      <div className="small muted">Si el IFC no está georreferenciado o la ubicación es errónea, indique latitud y longitud (grados decimales).</div>
      <div style={{ display: "flex", gap: 6 }}>
        <input className="input" placeholder="Latitud, p. ej. -29.9027" value={manual.lat} onChange={(e) => setManual({ ...manual, lat: e.target.value })} />
        <input className="input" placeholder="Longitud, p. ej. -71.2519" value={manual.lon} onChange={(e) => setManual({ ...manual, lon: e.target.value })} />
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <button
          className="btn"
          onClick={() => {
            const lat = Number(manual.lat.replace(",", "."));
            const lon = Number(manual.lon.replace(",", "."));
            if (Number.isFinite(lat) && Number.isFinite(lon) && lat <= -17 && lat >= -56 && lon <= -66 && lon >= -110) onRelocate({ latitude: lat, longitude: lon });
          }}
        >
          Usar esta ubicación
        </button>
        {location?.source === "manual" && (
          <button className="btn" onClick={onUseIfc}>
            Usar la ubicación del IFC
          </button>
        )}
      </div>
    </div>
  );
}
