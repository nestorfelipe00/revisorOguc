"use client";

import { useRef, useState } from "react";
import type { BoundaryKind, Parcel, ParcelEdge } from "@/lib/reglas/tipos";
import { edgeLength, orientation, parcelArea } from "@/lib/reglas/predio";
import { formatNumber, parseNumber } from "@/lib/territorio/colocacion";
import { Alertas, type Alerta } from "./Alerta";

const KINDS: { kind: BoundaryKind; label: string }[] = [
  { kind: "Vecino", label: "Vecino (otro predio)" },
  { kind: "Frente", label: "Frente a espacio público" },
  { kind: "AreaVerde", label: "Área verde pública" },
];

interface Props {
  parcel: Parcel | null;
  alerts: Alerta[];
  /** Hay una ubicación con marco de coordenadas: se puede dibujar o crear un predio rectangular. */
  canPlace: boolean;
  drawing: boolean;
  onImport(file: File): void;
  onRectangle(front: number, depth: number, bearing: number | null): void;
  /** Calle más cercana al centro (porción de ciudad), para orientar el frente. */
  street: { name: string | null; distance: number } | null;
  onDraw(): void;
  onApply(parcel: Parcel): void;
  onClear(): void;
  /** Se abre el editor de deslindes al crear o importar un predio (como en el escritorio). */
  editRequest: number;
}

/** Pestaña Predio: resumen, importar / rectangular / dibujar, deslindes y quitar. Solo sus alertas. */
export default function PredioPanel({ parcel, alerts, canPlace, drawing, onImport, onRectangle, onDraw, onApply, onClear, editRequest, street }: Props) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [rect, setRect] = useState<{ open: boolean; front: string; depth: string; bearing: string; auto: boolean }>({ open: false, front: "12", depth: "25", bearing: "180", auto: true });
  const [lastEdit, setLastEdit] = useState(0);
  const [editing, setEditing] = useState(false);
  if (editRequest !== lastEdit) {
    setLastEdit(editRequest);
    setEditing(editRequest > 0 && parcel !== null);
  }
  const fronts = parcel ? parcel.edges.filter((e) => e.kind === "Frente").length : 0;

  return (
    <div className="panel">
      <h2>Predio</h2>
      <Alertas items={alerts} />
      {parcel && (
        <dl className="kv">
          <dt>Superficie</dt>
          <dd>{formatNumber(parcelArea(parcel), 2)} m²</dd>
          <dt>Deslindes</dt>
          <dd>
            {parcel.vertices.length} ({fronts} frente{fronts === 1 ? "" : "s"})
          </dd>
          <dt>Origen</dt>
          <dd>{parcel.source}</dd>
          <dt>Suelo natural</dt>
          <dd>
            Z = {formatNumber(parcel.naturalGroundZ, 2)} m ({parcel.groundConfirmed ? "confirmado" : "supuesto"})
          </dd>
          <dt>Posición del modelo</dt>
          <dd>{parcel.positionConfirmed ? "verificada" : "sin verificar"}</dd>
        </dl>
      )}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <input ref={fileInput} type="file" accept=".geojson,.json" hidden onChange={(e) => e.target.files?.[0] && (onImport(e.target.files[0]), (e.target.value = ""))} />
        <button className="btn" onClick={() => fileInput.current?.click()} title="Polígono del predio en GeoJSON (lon/lat)">
          Importar predio…
        </button>
        <button className="btn" disabled={!canPlace} onClick={() => setRect({ ...rect, open: !rect.open })} title="Predio rectangular con centro en la ubicación: frente, fondo y orientación del frente">
          Predio rectangular…
        </button>
        <button className="btn" disabled={!canPlace || drawing} onClick={onDraw} title="Dibujar el predio en la planta del visor: clic en cada vértice, largo por teclado, Enter cierra">
          {drawing ? "Dibujando…" : "Dibujar predio"}
        </button>
        {parcel && (
          <button className="btn btn-primary" onClick={() => setEditing(true)} title="Tipo de cada deslinde, ancho entre líneas oficiales y suelo natural">
            Deslindes…
          </button>
        )}
        {parcel && (
          <button className="btn" onClick={onClear}>
            Quitar
          </button>
        )}
      </div>
      {rect.open && (
        <div className="card" style={{ display: "grid", gap: 6 }}>
          <strong>Predio rectangular</strong>
          <div className="muted small">
            Centrado en la ubicación del proyecto.{" "}
            {street ? `Calle más cercana: ${street.name ?? "sin nombre"}, a ${formatNumber(street.distance, 0)} m del punto.` : "No hay calles de la porción de ciudad a menos de 100 m: indique la orientación del frente."}
          </div>
          <label className="small">
            <input type="radio" name="orientacion" checked={rect.auto && !!street} disabled={!street} onChange={() => setRect({ ...rect, auto: true })} /> Frente hacia la calle más cercana
          </label>
          <label className="small">
            <input type="radio" name="orientacion" checked={!rect.auto || !street} onChange={() => setRect({ ...rect, auto: false })} /> Frente hacia una orientación (grados desde el norte; 180 = sur)
          </label>
          <dl className="kv">
            <dt>Frente (m)</dt>
            <dd>
              <input className="input" value={rect.front} onChange={(e) => setRect({ ...rect, front: e.target.value })} aria-label="Frente" />
            </dd>
            <dt>Fondo (m)</dt>
            <dd>
              <input className="input" value={rect.depth} onChange={(e) => setRect({ ...rect, depth: e.target.value })} aria-label="Fondo" />
            </dd>
            <dt>Orientación (°)</dt>
            <dd>
              <input className="input" value={rect.bearing} onChange={(e) => setRect({ ...rect, bearing: e.target.value })} aria-label="Orientación del frente" />
            </dd>
          </dl>
          <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
            <button className="btn" onClick={() => setRect({ ...rect, open: false })}>
              Cancelar
            </button>
            <button
              className="btn btn-primary"
              onClick={() => {
                const front = parseNumber(rect.front);
                const depth = parseNumber(rect.depth);
                const bearing = parseNumber(rect.bearing);
                const auto = rect.auto && !!street;
                if (front === null || front < 3 || front > 500 || depth === null || depth < 3 || depth > 500 || (!auto && (bearing === null || bearing < 0 || bearing >= 360))) return;
                setRect({ ...rect, open: false });
                onRectangle(front, depth, auto ? null : bearing);
              }}
            >
              Crear
            </button>
          </div>
        </div>
      )}
      {editing && parcel && (
        <EditorDeslindes
          parcel={parcel}
          onCancel={() => setEditing(false)}
          onApply={(p) => {
            setEditing(false);
            onApply(p);
          }}
        />
      )}
    </div>
  );
}

interface EditorProps {
  parcel: Parcel;
  onApply(parcel: Parcel): void;
  onCancel(): void;
}

/** Ventana «Deslindes» del escritorio: tipo de cada deslinde, ancho entre líneas oficiales, suelo natural y confirmaciones. */
function EditorDeslindes({ parcel, onApply, onCancel }: EditorProps) {
  const [edges, setEdges] = useState<{ kind: BoundaryKind; width: string; label: string | null }[]>(
    parcel.edges.map((e) => ({ kind: e.kind, width: e.officialLinesWidth !== null ? formatNumber(e.officialLinesWidth) : "", label: e.label })),
  );
  const [ground, setGround] = useState(formatNumber(parcel.naturalGroundZ));
  const [groundConfirmed, setGroundConfirmed] = useState(parcel.groundConfirmed);
  const [positionConfirmed, setPositionConfirmed] = useState(parcel.positionConfirmed);
  const [error, setError] = useState<string | null>(null);

  const validate = (): string | null => {
    if (parseNumber(ground) === null) return "La cota del suelo natural debe ser un número (m, en Z del modelo).";
    for (const [i, e] of edges.entries()) {
      if (e.kind !== "Frente" || e.width.trim() === "") continue;
      const w = parseNumber(e.width);
      if (w === null || w <= 0) return `Deslinde ${i + 1}: el ancho entre líneas oficiales debe ser un número positivo.`;
    }
    return edges.some((e) => e.kind === "Frente") ? null : "Marque al menos un deslinde como frente a espacio público (desde ahí se mide el antejardín).";
  };

  return (
    <div className="card" style={{ display: "grid", gap: 8 }}>
      <strong>Deslindes</strong>
      <div className="muted small">
        {formatNumber(parcelArea(parcel), 2)} m² · {parcel.vertices.length} deslindes · {parcel.source}. Según la inscripción del CBR y el CIP: tipo de cada deslinde y, en los frentes, el ancho entre líneas oficiales.
      </div>
      <div className="model-list">
        {edges.map((e, i) => (
          <div className="row" key={i} style={{ flexWrap: "wrap" }}>
            <span className="badge">{i + 1}</span>
            <span className="small" style={{ minWidth: 150 }}>
              {orientation(parcel, i)} · {formatNumber(edgeLength(parcel, i), 2)} m{e.label ? ` · ${e.label}` : ""}
            </span>
            <select className="input" style={{ width: "auto" }} value={e.kind} onChange={(ev) => setEdges(edges.map((x, j) => (j === i ? { ...x, kind: ev.target.value as BoundaryKind } : x)))} aria-label={`Tipo deslinde ${i + 1}`}>
              {KINDS.map((k) => (
                <option key={k.kind} value={k.kind}>
                  {k.label}
                </option>
              ))}
            </select>
            {e.kind === "Frente" && (
              <input
                className="input"
                style={{ width: 120 }}
                placeholder="Ancho L.O. (m)"
                title="Ancho entre líneas oficiales del espacio público que enfrenta (CIP)"
                value={e.width}
                onChange={(ev) => setEdges(edges.map((x, j) => (j === i ? { ...x, width: ev.target.value } : x)))}
              />
            )}
          </div>
        ))}
      </div>
      <dl className="kv">
        <dt>Suelo natural (Z)</dt>
        <dd>
          <input className="input" value={ground} onChange={(e) => setGround(e.target.value)} aria-label="Suelo natural" />
        </dd>
      </dl>
      <label className="small">
        <input type="checkbox" checked={groundConfirmed} onChange={(e) => setGroundConfirmed(e.target.checked)} /> La cota del suelo natural está verificada (levantamiento o CIP)
      </label>
      <label className="small">
        <input type="checkbox" checked={positionConfirmed} onChange={(e) => setPositionConfirmed(e.target.checked)} /> La posición del modelo en el predio está verificada
      </label>
      {error && <div className="alert alert-danger small">{error}</div>}
      <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
        <button className="btn" onClick={onCancel}>
          Cancelar
        </button>
        <button
          className="btn btn-primary"
          onClick={() => {
            const problem = validate();
            setError(problem);
            if (problem) return;
            const next: ParcelEdge[] = edges.map((e) => ({ kind: e.kind, officialLinesWidth: e.kind === "Frente" ? parseNumber(e.width) : null, label: e.label }));
            onApply({ ...parcel, edges: next, naturalGroundZ: parseNumber(ground)!, groundConfirmed, positionConfirmed });
          }}
        >
          Aceptar
        </button>
      </div>
    </div>
  );
}
