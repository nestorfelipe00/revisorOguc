"use client";

import { useState } from "react";
import type { LoadedModel } from "@/viewer/web";
import { SOURCE_LABELS, describeGeolocation } from "@/lib/territorio/location";
import { formatNumber, type UserPlacement } from "@/lib/territorio/colocacion";
import type { GeoPoint } from "@/lib/territorio/utm";
import { Alertas, type Alerta } from "./Alerta";
import type { Territorio } from "./UbicacionPanel";
import { CRS_OPTIONS, useGeoreferencia } from "./useGeoreferencia";

const fmt = (v: number, d = 5) => v.toLocaleString("es-CL", { minimumFractionDigits: d, maximumFractionDigits: d });

interface Props {
  territory: Territorio | null;
  alerts: Alerta[];
  models: LoadedModel[];
  hasManual: boolean;
  onRelocate(point: GeoPoint): void;
  onUseIfc(): void;
  /** Georreferencia de partida para el editor (la del usuario o la deducida del IFC); null si no hay modelo ubicado. */
  editorInitial: UserPlacement | null;
  pivot: { x: number; y: number } | null;
  lastPicked: { x: number; y: number; z: number } | null;
  onEditStart(): void;
  /** Pide abrir el editor de georreferencia (p. ej. «Más opciones…» desde el visor). */
  openEditorRequest: number;
  /** Cota del terreno bajo el centro del modelo (porción de ciudad); null si no hay. */
  groundElevation(): Promise<number | null>;
  onPreview(p: UserPlacement): void;
  onAccept(p: UserPlacement): void;
  onCancel(): void;
}

/** Pestaña Coordenadas: fuente de la ubicación, centro, UTM, origen del modelo, ubicación manual y georreferenciación. */
export default function CoordenadasPanel(props: Props) {
  const { territory, alerts, models, hasManual, onRelocate, onUseIfc, editorInitial, pivot } = props;
  const [manual, setManual] = useState({ lat: "", lon: "" });
  const [editing, setEditing] = useState(false);
  const [lastOpenRequest, setLastOpenRequest] = useState(0);
  if (props.openEditorRequest !== lastOpenRequest) {
    setLastOpenRequest(props.openEditorRequest);
    if (props.openEditorRequest > 0 && editorInitial && pivot) {
      props.onEditStart();
      setEditing(true);
    }
  }
  const location = territory?.location ?? null;
  const frame = location?.frame ?? null;
  const origin = frame ? { e: frame.easting + 0, n: frame.northing + 0 } : null;
  const rotation = frame ? (Math.atan2(frame.sin, frame.cos) * 180) / Math.PI : 0;

  return (
    <div className="panel">
      <h2>Coordenadas y georreferencia</h2>
      <Alertas items={alerts} />
      {!location && (
        <p className="muted small">
          Las coordenadas del proyecto aparecen al abrir un IFC. Si el modelo no está georreferenciado, indique la ubicación abajo y luego ajuste el origen con «Georreferenciar».
        </p>
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
                {location.utm.south ? "S" : "N"} · E {fmt(location.utm.easting, 0)} · N {fmt(location.utm.northing, 0)}
              </dd>
            </>
          )}
          {frame && origin && (
            <>
              <dt>Origen del modelo</dt>
              <dd>
                E {fmt(origin.e, 2)} · N {fmt(origin.n, 2)} · cota {frame.elevation !== null ? `${fmt(frame.elevation, 2)} m` : "sobre el terreno"} · rotación {fmt(rotation, 2)}°{frame.assumed ? " (supuesto)" : ""}
              </dd>
            </>
          )}
          {location.notes
            .filter((n) => !n.startsWith("⚠") && !n.startsWith("Supuesto"))
            .map((n) => (
              <FragmentNote key={n} text={n} />
            ))}
        </dl>
      )}

      {models.length > 0 && (
        <details className="pset">
          <summary>Georreferencia declarada en cada IFC</summary>
          {models.map((m) => (
            <div key={m.modelId} className="small" style={{ marginTop: 6 }}>
              <strong>{m.name}</strong>
              {(m.meta ? describeGeolocation(m.meta.geolocation) : ["⚠ No se pudieron leer los metadatos del IFC."])
                .filter((l) => !l.startsWith("⚠"))
                .map((l) => (
                  <div key={l} className="muted">
                    {l}
                  </div>
                ))}
            </div>
          ))}
        </details>
      )}

      <h2>Indicar ubicación</h2>
      <div className="small muted">Si el IFC no está georreferenciado o la ubicación es errónea, indique latitud y longitud (grados decimales). Sin modelo, es el punto de referencia del estudio de cabida.</div>
      <div style={{ display: "flex", gap: 6 }}>
        <input className="input" placeholder="Latitud, p. ej. -29.9027" value={manual.lat} onChange={(e) => setManual({ ...manual, lat: e.target.value })} aria-label="Latitud" />
        <input className="input" placeholder="Longitud, p. ej. -71.2519" value={manual.lon} onChange={(e) => setManual({ ...manual, lon: e.target.value })} aria-label="Longitud" />
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
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
        {hasManual && (
          <button className="btn" onClick={onUseIfc}>
            Descartar ubicación manual y usar la del IFC
          </button>
        )}
        {editorInitial && pivot && !editing && (
          <button
            className="btn"
            onClick={() => {
              props.onEditStart();
              setEditing(true);
            }}
          >
            Georreferenciar…
          </button>
        )}
      </div>
      {editing && editorInitial && pivot && (
        <EditorGeoreferencia
          initial={editorInitial}
          pivot={pivot}
          lastPicked={props.lastPicked}
          groundElevation={props.groundElevation}
          onPreview={props.onPreview}
          onAccept={(p) => {
            setEditing(false);
            props.onAccept(p);
          }}
          onCancel={() => {
            setEditing(false);
            props.onCancel();
          }}
        />
      )}
      <div className="muted small">El mapa y la ciudad 3D están en la pestaña Ubicación; la colocación rápida y el ajuste fino, en la barra del visor. Guardar una copia IFC georreferenciada está disponible solo en la versión de escritorio.</div>
    </div>
  );
}

function FragmentNote({ text }: { text: string }) {
  return (
    <>
      <dt>Nota</dt>
      <dd>{text}</dd>
    </>
  );
}

const STEPS = [0.01, 0.1, 1, 10];

interface EditorProps {
  initial: UserPlacement;
  pivot: { x: number; y: number };
  lastPicked: { x: number; y: number; z: number } | null;
  groundElevation(): Promise<number | null>;
  onPreview(p: UserPlacement): void;
  onAccept(p: UserPlacement): void;
  onCancel(): void;
}

/** Ventana «Georreferenciar» del escritorio: valores exactos, ajuste fino y puntos conocidos, con vista previa en vivo. */
function EditorGeoreferencia({ initial, pivot, lastPicked, groundElevation, onPreview, onAccept, onCancel }: EditorProps) {
  const g = useGeoreferencia(initial, pivot, onPreview);
  const [groundNote, setGroundNote] = useState<string | null>(null);
  const apoyar = async () => {
    const h = await groundElevation();
    if (h === null) setGroundNote("No hay porción de ciudad 3D en esta ubicación para estimar la cota.");
    else {
      g.setField("elevation", formatNumber(Math.round(h * 100) / 100));
      setGroundNote(null);
    }
  };
  const field = (label: string, name: "easting" | "northing" | "elevation" | "rotation", placeholder = "") => (
    <>
      <dt>{label}</dt>
      <dd>
        <input className="input" value={g[name]} placeholder={placeholder} onChange={(e) => g.setField(name, e.target.value)} aria-label={label} />
      </dd>
    </>
  );
  const punto = (which: 1 | 2) => {
    const p = which === 1 ? g.point1 : g.point2;
    return (
      <div className="pset">
        <div className="small">
          <strong>Punto {which}</strong> · modelo: {p.model ? `X ${formatNumber(p.model.x)} · Y ${formatNumber(p.model.y)} · Z ${formatNumber(p.model.z)}` : "sin marcar"}{" "}
          <button className="btn small" disabled={!lastPicked} onClick={() => lastPicked && g.usePicked(which, lastPicked)} title="Usa el último punto marcado con un clic en el visor">
            → Punto {which}
          </button>
        </div>
        <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
          <input className="input" placeholder="Este real (m)" value={p.realEasting} onChange={(e) => g.setReal(which, "realEasting", e.target.value)} />
          <input className="input" placeholder="Norte real (m)" value={p.realNorthing} onChange={(e) => g.setReal(which, "realNorthing", e.target.value)} />
          <input className="input" placeholder="Cota (m)" value={p.realHeight} onChange={(e) => g.setReal(which, "realHeight", e.target.value)} />
        </div>
      </div>
    );
  };
  return (
    <div className="card" style={{ display: "grid", gap: 8 }}>
      <strong>Georreferenciar</strong>
      <div className="muted small">El origen (0, 0, 0) del modelo queda en Este/Norte; la rotación gira alrededor del centro del modelo. Vista previa en vivo en las coordenadas del visor; el IFC no cambia.</div>
      <dl className="kv">
        <dt>Sistema</dt>
        <dd>
          <select className="input" value={g.crsName} onChange={(e) => g.setCrs(e.target.value)} aria-label="Sistema de referencia">
            {CRS_OPTIONS.map((c) => (
              <option key={c.name} value={c.name}>
                {c.description} ({c.name})
              </option>
            ))}
          </select>
        </dd>
        {field("Este (m)", "easting")}
        {field("Norte (m)", "northing")}
        {field("Cota Z=0 (m)", "elevation", "automática")}
        {field("Rotación (°)", "rotation")}
      </dl>
      <div className="small">{g.centerText}</div>
      {g.error && <div className="alert alert-danger small">{g.error}</div>}
      {groundNote && <div className="alert alert-warn small">{groundNote}</div>}
      <div className="small muted">Paso (m / °)</div>
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
        {STEPS.map((s) => (
          <button key={s} className={`btn small${g.step === s ? " selected" : ""}`} onClick={() => g.setStep(s)}>
            {s.toLocaleString("es-CL")}
          </button>
        ))}
      </div>
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
        <span className="small muted" style={{ alignSelf: "center" }}>Mapa</span>
        <button className="btn small" onClick={() => g.move("N")}>↑ N</button>
        <button className="btn small" onClick={() => g.move("S")}>↓ S</button>
        <button className="btn small" onClick={() => g.move("E")}>→ E</button>
        <button className="btn small" onClick={() => g.move("O")}>← O</button>
        <span className="small muted" style={{ alignSelf: "center" }}>Modelo</span>
        <button className="btn small" onClick={() => g.move("+Y")}>+Y</button>
        <button className="btn small" onClick={() => g.move("-Y")}>−Y</button>
        <button className="btn small" onClick={() => g.move("+X")}>+X</button>
        <button className="btn small" onClick={() => g.move("-X")}>−X</button>
      </div>
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
        <button className="btn small" onClick={() => g.raise("+")}>▲ Subir</button>
        <button className="btn small" onClick={() => g.raise("-")}>▼ Bajar</button>
        <button className="btn small" onClick={() => void apoyar()} title="Nivel 0 del modelo sobre el terreno de la porción de ciudad">Apoyar en terreno</button>
        <button className="btn small" onClick={() => g.rotate("+")}>↺ Girar</button>
        <button className="btn small" onClick={() => g.rotate("-")}>↻ Girar</button>
        <button className="btn small" onClick={() => g.turn(90)}>⟲ 90°</button>
        <button className="btn small" onClick={() => g.turn(-90)}>⟳ 90°</button>
        <button className="btn small" onClick={() => g.turn(180)}>180°</button>
        <button className="btn small" disabled={!g.canUndo} onClick={g.undo}>Deshacer</button>
      </div>
      <details className="pset">
        <summary>Puntos conocidos</summary>
        <div className="small muted">Marque un punto del modelo con un clic en el visor (una esquina, por ejemplo) y escriba su coordenada real. Un punto fija la posición y la cota; dos puntos fijan además la rotación.</div>
        {punto(1)}
        {punto(2)}
        <button className="btn small" onClick={g.applyPoints} style={{ marginTop: 6 }}>
          Aplicar puntos
        </button>
        {g.pointsResult && <div className="small" style={{ marginTop: 4 }}>{g.pointsResult}</div>}
      </details>
      <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
        <button className="btn" onClick={onCancel}>
          Cancelar
        </button>
        <button className="btn btn-primary" disabled={!g.current} onClick={() => g.current && onAccept(g.current)}>
          Aceptar
        </button>
      </div>
    </div>
  );
}
