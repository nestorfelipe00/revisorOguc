"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import type { WebViewer, LoadedModel, WebViewerEvents } from "@/viewer/web";
import type { ElementInfo } from "@/viewer/protocol";
import { createClient } from "@/lib/supabase/client";
import { analizarTerritorio, type TerritorialAnalysis } from "@/lib/territorio/consulta";
import { describeGeolocation, manualLocation as manualLocationAt, resolveLocation, SOURCE_LABELS, type ProjectLocation } from "@/lib/territorio/location";
import TerritoryPanel from "./TerritoryPanel";

const Viewer = dynamic(() => import("@/components/Viewer"), { ssr: false });

type Tab = "modelos" | "elemento" | "territorio";

interface LogLine {
  level: "info" | "warn" | "error";
  message: string;
  at: number;
}

export interface Territory {
  modelId: string;
  geolocationLines: string[];
  location: ProjectLocation | null;
  analysis: TerritorialAnalysis | null;
  error: string | null;
  loading: boolean;
}

const MAX_IFC_BYTES = 300 * 1024 * 1024;

export default function Workspace({ userEmail }: { userEmail: string }) {
  const api = useRef<WebViewer | null>(null);
  const [ready, setReady] = useState(false);
  const [models, setModels] = useState<LoadedModel[]>([]);
  const [progress, setProgress] = useState<{ stage: string; value: number } | null>(null);
  const [selection, setSelection] = useState<{ count: number; element: ElementInfo | null }>({ count: 0, element: null });
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [tab, setTab] = useState<Tab>("modelos");
  const [territory, setTerritory] = useState<Territory | null>(null);
  const [dragging, setDragging] = useState(false);
  const supabase = useMemo(() => createClient(), []);

  const log = useCallback((level: LogLine["level"], message: string) => {
    setLogs((l) => [...l.slice(-49), { level, message, at: Date.now() }]);
  }, []);

  const analyze = useCallback(
    async (model: LoadedModel, manual?: { latitude: number; longitude: number }) => {
      const geo = model.meta?.geolocation ?? { mapConversion: null, siteLatitude: null, siteLongitude: null };
      const lines = model.meta ? describeGeolocation(geo) : ["⚠ No se pudieron leer los metadatos del IFC."];
      const location = manual ? manualLocation(manual, model) : resolveLocation(geo, model.extent);
      setTerritory({ modelId: model.modelId, geolocationLines: lines, location, analysis: null, error: null, loading: !!location });
      if (!location) return;
      try {
        const analysis = await analizarTerritorio(supabase, location);
        setTerritory((t) => (t && t.modelId === model.modelId ? { ...t, analysis, loading: false } : t));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setTerritory((t) => (t && t.modelId === model.modelId ? { ...t, error: message, loading: false } : t));
        log("error", `Territorio: ${message}`);
      }
    },
    [supabase, log],
  );

  const events = useMemo<WebViewerEvents>(
    () => ({
      onProgress: (stage, value) => setProgress(stage ? { stage, value } : null),
      onModelsChanged: (list) => {
        setModels(list);
        const last = list.at(-1);
        if (last) {
          log("info", `${last.name}: ${last.elementCount.toLocaleString("es-CL")} elementos en ${(last.loadMs / 1000).toFixed(1)} s (${last.meta?.schema ?? "esquema desconocido"}).`);
          for (const w of last.meta?.warnings ?? []) log("warn", w);
          void analyze(last);
          setTab("territorio");
        } else {
          setTerritory(null);
        }
      },
      onSelectionChanged: (count, element) => {
        setSelection({ count, element });
        if (element) setTab("elemento");
      },
      onLog: log,
      onPointPicked: () => {},
      onParcelDrawn: () => log("info", "Predio dibujado. La revisión normativa llega en la siguiente etapa."),
    }),
    [log, analyze],
  );

  const openFiles = useCallback(
    (files: FileList | File[]) => {
      if (!api.current) return;
      for (const file of files) {
        if (!/\.ifc$/i.test(file.name)) {
          log("warn", `${file.name}: solo se abren archivos .ifc.`);
          continue;
        }
        if (file.size > MAX_IFC_BYTES) {
          log("error", `${file.name}: supera los 300 MB y no se puede abrir en la versión web. Use la versión de escritorio.`);
          continue;
        }
        void api.current.loadFile(file);
      }
    },
    [log],
  );

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer?.files?.length) openFiles(e.dataTransfer.files);
  };

  useEffect(() => {
    const prevent = (e: Event) => e.preventDefault();
    window.addEventListener("dragover", prevent);
    window.addEventListener("drop", prevent);
    return () => {
      window.removeEventListener("dragover", prevent);
      window.removeEventListener("drop", prevent);
    };
  }, []);

  return (
    <div className="workspace">
      <header className="topbar">
        <Link href="/" className="brand">
          BIM Normative Checker
        </Link>
        <label className="btn btn-primary" style={{ cursor: ready ? "pointer" : "wait" }}>
          Abrir IFC
          <input type="file" accept=".ifc" multiple hidden disabled={!ready} onChange={(e) => e.target.files && openFiles(e.target.files)} />
        </label>
        <span className="muted small">El modelo se procesa en su navegador y no se sube.</span>
        <span className="spacer" />
        <span className="muted small">{userEmail}</span>
        <form action="/auth/salir" method="post">
          <button className="btn" type="submit">
            Salir
          </button>
        </form>
      </header>

      <section
        className="viewer-host-wrap"
        style={{ position: "relative", minWidth: 0, minHeight: 0 }}
        onDragEnter={() => setDragging(true)}
        onDragLeave={() => setDragging(false)}
        onDragOver={(e) => e.preventDefault()}
        onDrop={onDrop}
      >
        <Viewer events={events} onReady={(v) => ((api.current = v), setReady(true))} onError={(m) => log("error", `Visor: ${m}`)} />
        {models.length === 0 && !progress && (
          <div className="drop-hint">
            <div className="box">
              <strong>{ready ? "Sin modelo cargado" : "Iniciando el visor…"}</strong>
              <span className="small">Arrastre un archivo IFC aquí o use «Abrir IFC».</span>
              <span className="small muted">Máximo 300 MB por archivo en la versión web.</span>
            </div>
          </div>
        )}
        {dragging && <div className="drop-hint" style={{ background: "rgba(67, 209, 122, 0.12)" }} />}
        {progress && (
          <div className="progress">
            <div className="small">
              {progress.stage}… {Math.round(progress.value * 100)} %
            </div>
            <div className="track">
              <div className="bar" style={{ width: `${Math.round(progress.value * 100)}%` }} />
            </div>
          </div>
        )}
      </section>

      <aside className="side">
        <div className="tabs" role="tablist">
          {(["modelos", "elemento", "territorio"] as Tab[]).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
              {t === "modelos" ? `Modelos (${models.length})` : t === "elemento" ? "Elemento" : "Territorio"}
            </button>
          ))}
        </div>

        {tab === "modelos" && (
          <div className="panel">
            {models.length === 0 && <p className="muted">Abra uno o más archivos IFC. Los modelos se federan en el mismo visor.</p>}
            <div className="model-list">
              {models.map((m) => (
                <div className="row" key={m.modelId}>
                  <input type="checkbox" defaultChecked title="Visible" onChange={(e) => api.current?.setVisible(m.modelId, e.target.checked)} />
                  <span className="name" title={m.name}>
                    {m.name}
                  </span>
                  <span className="badge">{m.elementCount.toLocaleString("es-CL")}</span>
                  <button className="btn small" title="Cerrar modelo" onClick={() => api.current?.unload(m.modelId)}>
                    ✕
                  </button>
                </div>
              ))}
            </div>
            {models.map((m) => (
              <details key={`${m.modelId}-classes`} className="pset">
                <summary>
                  {m.name} · {m.meta?.schema ?? "?"} · {(m.bytes / 1048576).toFixed(1)} MB
                </summary>
                <dl className="kv">
                  <dt>SHA-256</dt>
                  <dd className="small" style={{ wordBreak: "break-all" }}>
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
        )}

        {tab === "elemento" && <ElementPanel selection={selection} />}

        {tab === "territorio" && (
          <TerritoryPanel
            territory={territory}
            models={models}
            onRelocate={(point) => {
              const model = models.find((m) => m.modelId === territory?.modelId) ?? models.at(-1);
              if (model) void analyze(model, point);
            }}
            onUseIfc={() => {
              const model = models.find((m) => m.modelId === territory?.modelId) ?? models.at(-1);
              if (model) void analyze(model);
            }}
          />
        )}
      </aside>
    </div>
  );
}

function manualLocation(point: { latitude: number; longitude: number }, model: LoadedModel): ProjectLocation {
  return manualLocationAt(point, model.extent);
}

function FragmentRow({ name, value }: { name: string; value: string }) {
  return (
    <>
      <dt title={name}>{name}</dt>
      <dd>{value}</dd>
    </>
  );
}

function ElementPanel({ selection }: { selection: { count: number; element: ElementInfo | null } }) {
  const e = selection.element;
  if (!e) {
    return (
      <div className="panel">
        <p className="muted">Haga clic en un elemento del modelo para ver su clase, nivel, tipo, propiedades y cantidades.</p>
      </div>
    );
  }
  return (
    <div className="panel">
      {selection.count > 1 && <span className="badge">{selection.count} elementos seleccionados · se muestra el primero</span>}
      <div>
        <strong>{e.name ?? "(sin nombre)"}</strong>
        <div className="muted small">
          {e.ifcClass} · #{e.expressId}
          {e.globalId ? ` · ${e.globalId}` : ""}
        </div>
        {e.typeName && <div className="small">Tipo: {e.typeName}</div>}
      </div>
      <h2>Atributos</h2>
      <dl className="kv">
        {e.attributes.map((a) => (
          <FragmentRow key={a.name} name={a.name} value={a.value} />
        ))}
      </dl>
      {e.propertySets.length > 0 && <h2>Propiedades y cantidades</h2>}
      {e.propertySets.map((p, i) => (
        <details key={`${p.name}-${i}`} className="pset" open={i < 3}>
          <summary>{p.name || "(sin nombre)"}</summary>
          <dl className="kv">
            {p.properties.map((q, j) => (
              <FragmentRow key={`${q.name}-${j}`} name={q.name} value={q.value} />
            ))}
          </dl>
        </details>
      ))}
    </div>
  );
}

export { SOURCE_LABELS };
