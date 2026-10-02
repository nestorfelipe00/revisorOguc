"use client";

import { useEffect, useRef } from "react";
import type { WebViewer, WebViewerEvents } from "@/viewer/web";
import "@/viewer/style.css";

interface Props {
  events: WebViewerEvents;
  onReady: (api: WebViewer) => void;
  onError: (message: string) => void;
}

/** Contenedor del visor That Open. Se carga solo en el cliente (three.js y web-ifc necesitan window). */
export default function Viewer({ events, onReady, onError }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const eventsRef = useRef(events);
  const readyRef = useRef(onReady);
  const errorRef = useRef(onError);
  // Se actualizan después de cada render (no durante): así el visor usa siempre los manejadores vigentes sin reiniciarse.
  useEffect(() => {
    eventsRef.current = events;
    readyRef.current = onReady;
    errorRef.current = onError;
  });

  useEffect(() => {
    const container = host.current;
    if (!container) return;
    let api: WebViewer | null = null;
    let cancelled = false;
    // Los manejadores se leen en cada llamada, así React puede cambiarlos sin reiniciar el visor.
    const proxy: WebViewerEvents = {
      onProgress: (...a) => eventsRef.current.onProgress(...a),
      onModelsChanged: (...a) => eventsRef.current.onModelsChanged(...a),
      onSelectionChanged: (...a) => eventsRef.current.onSelectionChanged(...a),
      onLog: (...a) => eventsRef.current.onLog(...a),
      onPointPicked: (...a) => eventsRef.current.onPointPicked(...a),
      onParcelDrawn: (...a) => eventsRef.current.onParcelDrawn(...a),
      onCityRequested: () => eventsRef.current.onCityRequested(),
    };
    (async () => {
      const { WebViewer } = await import("@/viewer/web");
      if (cancelled) return;
      api = new WebViewer(proxy);
      try {
        await api.init(container);
        if (!cancelled) readyRef.current(api);
      } catch (error) {
        errorRef.current(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => {
      cancelled = true;
      api?.dispose();
      container.replaceChildren();
    };
  }, []);

  return <div ref={host} id="viewer" className="viewer-host" style={{ position: "absolute", inset: 0 }} />;
}
