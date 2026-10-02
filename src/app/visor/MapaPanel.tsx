"use client";

// Ventana «Ver mapa» del escritorio, sobre el visor: capas del PRC, ubicación, huella, predio, porciones de ciudad e
// «Indicar ubicación en el mapa». Leaflet solo existe en el cliente: este módulo se carga con dynamic(..., { ssr: false }).
import { useEffect, useRef, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import "leaflet/dist/leaflet.css";
import "./mapa.css";
import type { GeoPoint } from "@/lib/territorio/utm";
import { MapaTerritorial, type ProyectoMapa } from "@/lib/mapa/mapa";

interface Props {
  supabase: SupabaseClient;
  project: ProyectoMapa;
  /** Al abrir en modo «indicar ubicación» (p. ej. estudio de cabida) con esta pista. */
  pickHint: string | null;
  onPick(point: GeoPoint): void;
  onClose(): void;
  onError(message: string): void;
}

export default function MapaPanel({ supabase, project, pickHint, onPick, onClose, onError }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const mapa = useRef<MapaTerritorial | null>(null);
  const [picking, setPicking] = useState(false);
  const callbacks = useRef({ onPick, onError });
  useEffect(() => {
    callbacks.current = { onPick, onError };
  });

  useEffect(() => {
    const container = host.current;
    if (!container) return;
    const instance = new MapaTerritorial(container, supabase, {
      onPick: (p) => callbacks.current.onPick(p),
      onPickingChanged: setPicking,
      onError: (m) => callbacks.current.onError(m),
    });
    mapa.current = instance;
    if (process.env.NODE_ENV !== "production") Object.assign(window, { __bncMapa: instance });
    instance.invalidate();
    if (pickHint) instance.setPicking(true);
    return () => {
      instance.dispose();
      mapa.current = null;
    };
    // Una sola instancia por apertura de la ventana; el proyecto se actualiza con setProject en el efecto siguiente.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase]);

  useEffect(() => {
    mapa.current?.setProject(project);
  }, [project]);

  return (
    <div className="mapa-ventana" role="dialog" aria-label="Mapa territorial">
      <div className="mapa-barra">
        <strong>Territorio — Plan Regulador Comunal</strong>
        <span className="muted small">Capas referenciales: lo oficial es la Ordenanza Local.</span>
        <span className="spacer" />
        <button className={`btn small${picking ? " btn-primary" : ""}`} onClick={() => mapa.current?.setPicking(!picking)} title="Trasladar el proyecto al punto donde haga clic">
          {picking ? "Haga clic en el mapa…" : "Indicar ubicación en el mapa"}
        </button>
        <button className="btn small" onClick={onClose} aria-label="Cerrar el mapa">
          ✕ Cerrar
        </button>
      </div>
      <div className="mapa-cuerpo">
        <div ref={host} className="mapa-lienzo" />
        <div className="mapa-resumen">
          <div className="title">Territorio</div>
          {project.summary.length === 0 && <div className="muted">Sin ubicación: use «Indicar ubicación en el mapa».</div>}
          {project.summary.map((line) => (
            <div key={line} className={line.startsWith("⚠") ? "warn" : ""}>
              {line}
            </div>
          ))}
          {picking && <div className="muted" style={{ marginTop: 6 }}>{pickHint ?? "Haga clic en el mapa sobre el predio del proyecto."}</div>}
        </div>
      </div>
    </div>
  );
}
