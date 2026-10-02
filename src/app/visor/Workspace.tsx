"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import type { WebViewer, LoadedModel, WebViewerEvents } from "@/viewer/web";
import type { ElementInfo, Georeference } from "@/viewer/protocol";
import { createClient } from "@/lib/supabase/client";
import { analizarTerritorio, type TerritorialAnalysis } from "@/lib/territorio/consulta";
import {
  describeGeolocation,
  extentCenter,
  frameGeoToModel,
  frameToUtm,
  manualLocation as manualLocationAt,
  resolveLocation,
  type ModelExtent,
  type ModelGeolocation,
  type ProjectLocation,
} from "@/lib/territorio/location";
import { fromGeographic, toGeographic, type GeoPoint } from "@/lib/territorio/utm";
import { centeredAt, crsFor, locationFromPlacement, parseNumber, placementFromFrame, siteLocation, type UserPlacement } from "@/lib/territorio/colocacion";
import { importParcelGeoJson, parcelArea as parcelAreaOf, parcelFromVertices, rectangleParcel } from "@/lib/reglas/predio";
import { fireRatingKey, RULE_STATE_LABELS, type ModelGeometry, type Parcel, type RuleResult, type RuleState } from "@/lib/reglas/tipos";
import { construirContexto, parcelCenter } from "@/lib/revision/contexto";
import { envelopeGrid, rasanteScene } from "@/lib/revision/escena";
import { evaluarCabidaEnWorker, evaluarReglasEnWorker, RevisionCancelada, type EjecucionRevision } from "@/lib/revision/motorCliente";
import { extraerGeometria } from "@/viewer/geometry";
import { cargarProyecto, guardarProyecto, type ModeloGuardado } from "@/lib/proyecto/guardar";
import { alturaTerreno, areaDeCiudad, calleMasCercana, CiudadNoDisponible, escenaCiudad, zonasParaCiudad, type CalleCercana } from "@/lib/ciudad/escena";
import { ciudadPara, indiceCiudad } from "@/lib/ciudad/teselas";
import type { ProyectoMapa } from "@/lib/mapa/mapa";
import { SOURCE_LABELS } from "@/lib/territorio/location";
import { alerta, type Alerta } from "./Alerta";
import ProyectoPanel, { type LogLine } from "./ProyectoPanel";
import ModelosPanel from "./ModelosPanel";
import UbicacionPanel, { type Territorio } from "./UbicacionPanel";
import CoordenadasPanel from "./CoordenadasPanel";
import PredioPanel from "./PredioPanel";
import RevisionPanel, { type Revision } from "./RevisionPanel";
import ElementoPanel from "./ElementoPanel";

const Viewer = dynamic(() => import("@/components/Viewer"), { ssr: false });
const MapaPanel = dynamic(() => import("./MapaPanel"), { ssr: false });

// Panel izquierdo: todo lo del IFC (modelos y elemento). Panel derecho: proyecto, territorio, predio y revisión.
type IfcTab = "modelos" | "elemento";
type Tab = "proyecto" | "ubicacion" | "coordenadas" | "predio" | "revision";
const IFC_TABS: { id: IfcTab; label: string }[] = [
  { id: "modelos", label: "Modelos IFC" },
  { id: "elemento", label: "Elemento" },
];
const TABS: { id: Tab; label: string }[] = [
  { id: "proyecto", label: "Proyecto" },
  { id: "ubicacion", label: "Ubicación" },
  { id: "coordenadas", label: "Coordenadas" },
  { id: "predio", label: "Predio" },
  { id: "revision", label: "Revisión" },
];

const MAX_IFC_BYTES = 100 * 1024 * 1024;
const SOURCE_ORDER = ["mapConversion", "modelUtmCoordinates", "ifcSite", "manual", "userGeoreference"];
const n = (v: number, d = 2) => v.toLocaleString("es-CL", { minimumFractionDigits: 0, maximumFractionDigits: d });

interface Reference {
  location: ProjectLocation | null;
  extent: ModelExtent | null;
  geo: ModelGeolocation | null;
}

/** Modelo de referencia: el que mejor se ubica (su sistema de coordenadas es el de la escena). Porte de RecomputeTerritory. */
function pickReference(models: LoadedModel[]): Reference {
  const candidates = models
    .filter((m) => m.meta)
    .map((m) => ({ extent: m.extent, geo: m.meta!.geolocation, location: resolveLocation(m.meta!.geolocation, m.extent) }))
    .filter((c) => c.location)
    .sort((a, b) => SOURCE_ORDER.indexOf(a.location!.source) - SOURCE_ORDER.indexOf(b.location!.source));
  const best = candidates[0];
  return {
    location: best?.location ?? null,
    extent: best?.extent ?? models.find((m) => m.extent)?.extent ?? null,
    geo: best?.geo ?? models.find((m) => m.meta)?.meta?.geolocation ?? null,
  };
}

const placementGeoreference = (p: UserPlacement): Georeference => ({
  crsName: p.crsName,
  eastings: p.easting,
  northings: p.northing,
  height: p.elevation ?? 0,
  xAxisAbscissa: Math.cos((p.rotationDegrees * Math.PI) / 180),
  xAxisOrdinate: Math.sin((p.rotationDegrees * Math.PI) / 180),
  scale: 1,
  lengthScale: 1,
});

function countStates(results: RuleResult[]): string {
  const order: RuleState[] = ["Cumple", "NoCumple", "RevisionRequerida", "NoVerificable", "NoAplica", "Informativo"];
  return order
    .map((s) => [s, results.filter((r) => r.state === s).length] as const)
    .filter(([, c]) => c > 0)
    .map(([s, c]) => `${c} ${RULE_STATE_LABELS[s].toLowerCase()}`)
    .join(" · ");
}

export default function Workspace({ userEmail, proyectoId }: { userEmail: string; proyectoId: string | null }) {
  const api = useRef<WebViewer | null>(null);
  const supabase = useMemo(() => createClient(), []);
  const [ready, setReady] = useState(false);
  const [models, setModels] = useState<LoadedModel[]>([]);
  const [progress, setProgress] = useState<{ stage: string; value: number } | null>(null);
  const [selection, setSelection] = useState<{ count: number; element: ElementInfo | null }>({ count: 0, element: null });
  const [search, setSearch] = useState("");
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [tab, setTab] = useState<Tab>("proyecto");
  const [ifcTab, setIfcTab] = useState<IfcTab>("modelos");
  const [dragging, setDragging] = useState(false);
  const [placement, setPlacement] = useState<UserPlacement | null>(null);
  const [manualLocation, setManualLocation] = useState<GeoPoint | null>(null);
  const [parcel, setParcelState] = useState<Parcel | null>(null);
  const [editRequest, setEditRequest] = useState(0);
  const [drawing, setDrawing] = useState(false);
  const [analysisResult, setAnalysisResult] = useState<{ location: ProjectLocation; analysis: TerritorialAnalysis | null; error: string | null } | null>(null);
  const [revision, setRevision] = useState<Revision | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [reviewProgress, setReviewProgress] = useState<string | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [floorHeight, setFloorHeight] = useState("2,7");
  const [lastPicked, setLastPicked] = useState<{ x: number; y: number; z: number } | null>(null);
  const [cityShown, setCityShown] = useState(false);
  const [mapOpen, setMapOpen] = useState<{ pickHint: string | null } | null>(null);
  const [cityPortions, setCityPortions] = useState<GeoPoint[][]>([]);
  const [street, setStreet] = useState<CalleCercana | null>(null);
  const citySeq = useRef(0);
  const [project, setProject] = useState<{ id: string | null; nombre: string; tramite: string | null; saving: boolean; expected: ModeloGuardado[] }>({
    id: null,
    nombre: "",
    tramite: null,
    saving: false,
    expected: [],
  });
  const geometryCache = useRef(new Map<string, ModelGeometry>());
  const running = useRef<EjecucionRevision<unknown> | null>(null);
  const placementBeforeEditing = useRef<UserPlacement | null>(null);
  const analysisSeq = useRef(0);

  const log = useCallback((level: LogLine["level"], message: string) => {
    setLogs((l) => [...l.slice(-49), { level, message, at: Date.now() }]);
  }, []);

  // --- Ubicación del proyecto (porte de RecomputeTerritory) ---------------------------------------------------------
  const reference = useMemo(() => pickReference(models), [models]);
  const isSiteStudy = models.length === 0 && manualLocation !== null;
  const location = useMemo<ProjectLocation | null>(() => {
    if (models.length === 0 && manualLocation === null && placement === null) return null;
    if (placement) return locationFromPlacement(placement, reference.extent, reference.geo);
    if (manualLocation) return models.length === 0 ? siteLocation(manualLocation) : manualLocationAt(manualLocation, reference.extent);
    return reference.location;
  }, [models.length, manualLocation, placement, reference]);
  const frame = location?.frame ?? null;
  const pivot = reference.extent ? extentCenter(reference.extent) : null;
  const editorInitial = useMemo<UserPlacement | null>(() => {
    if (!reference.extent) return null;
    if (placement) return placement;
    return frame ? placementFromFrame(frame, reference.geo?.mapConversion?.crsName) : null;
  }, [placement, frame, reference]);

  useEffect(() => {
    const seq = ++analysisSeq.current;
    if (!location) return;
    analizarTerritorio(supabase, location)
      .then((analysis) => seq === analysisSeq.current && setAnalysisResult({ location, analysis, error: null }))
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        if (seq === analysisSeq.current) setAnalysisResult({ location, analysis: null, error: message });
        log("error", `Territorio: ${message}`);
      });
  }, [location, supabase, log]);
  // Mientras llega el análisis de una ubicación nueva, la pestaña muestra «consultando»; no se mezclan resultados de otra ubicación.
  const territory = useMemo<Territorio | null>(() => {
    if (!location) return null;
    if (analysisResult && analysisResult.location === location) return { location, analysis: analysisResult.analysis, error: analysisResult.error, loading: false };
    return { location, analysis: null, error: null, loading: true };
  }, [location, analysisResult]);

  // La georreferencia que muestra el visor en las coordenadas: la del usuario si existe, si no la del IFC.
  useEffect(() => {
    if (!api.current) return;
    for (const m of models) api.current.tools.setGeoreference(m.modelId, placement ? placementGeoreference(placement) : (m.meta?.geolocation.mapConversion ?? null));
  }, [placement, models]);

  const setParcel = useCallback((next: Parcel | null) => {
    setParcelState(next);
    setRevision(null);
    setReviewError(null);
    api.current?.setEnvelope(null);
    api.current?.setRasantes(null);
  }, []);

  // --- Visor -----------------------------------------------------------------------------------------------------------
  const frameRef = useRef(frame);
  const modelsCountRef = useRef(models.length);
  const cityRequest = useRef<() => void>(() => {});
  useEffect(() => {
    frameRef.current = frame;
    modelsCountRef.current = models.length;
  });
  const events = useMemo<WebViewerEvents>(
    () => ({
      onProgress: (stage, value) => setProgress(stage ? { stage, value } : null),
      onModelsChanged: (list) => {
        setModels(list);
        const last = list.at(-1);
        if (last) {
          log("info", `${last.name}: ${last.elementCount.toLocaleString("es-CL")} elementos en ${(last.loadMs / 1000).toFixed(1)} s (${last.meta?.schema ?? "esquema desconocido"}).`);
          for (const w of last.meta?.warnings ?? []) log("warn", w);
          if (last.meta) setTab("ubicacion");
        }
      },
      onSelectionChanged: (count, element) => {
        setSelection({ count, element });
        if (element) setIfcTab("elemento");
      },
      onLog: log,
      onPointPicked: (point) => setLastPicked(point),
      onCityRequested: () => cityRequest.current(),
      onParcelDrawn: (points) => {
        setDrawing(false);
        const f = frameRef.current;
        if (!f || points.length < 6) return;
        const vertices: GeoPoint[] = [];
        for (let i = 0; i < points.length / 2; i++) vertices.push(toGeographic(frameToUtm(f, points[2 * i], points[2 * i + 1])));
        const drawn = parcelFromVertices(vertices, "Dibujado en el visor");
        // Dibujado sobre el modelo ya ubicado: sigue siendo un trazado a mano. Sin modelo (cabida) no hay posición que verificar.
        setParcel({ ...drawn, positionConfirmed: modelsCountRef.current === 0 });
        log("info", `Predio dibujado: ${n(parcelAreaOf(drawn))} m², ${drawn.vertices.length} deslindes.`);
        setEditRequest((r) => r + 1);
        setTab("predio");
      },
    }),
    [log, setParcel],
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
          log("error", `${file.name}: supera los 100 MB y no se puede abrir en la versión web. Use la versión de escritorio.`);
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

  // --- Proyecto guardado ----------------------------------------------------------------------------------------------
  useEffect(() => {
    if (!proyectoId) return;
    cargarProyecto(supabase, proyectoId)
      .then((p) => {
        setProject({ id: p.id, nombre: p.nombre, tramite: p.tramite, saving: false, expected: p.modelos });
        setPlacement(p.campos.georef ?? null);
        setManualLocation(p.campos.ubicacion_manual ?? null);
        if (p.campos.piso_a_piso) setFloorHeight(p.campos.piso_a_piso);
        if (p.predio) setParcelState(p.predio);
        if (p.revision) {
          setRevision({
            tipo: p.revision.tipo,
            evaluation: { results: p.revision.resultados, volume: null, lotArea: 0, rasantes: null },
            statusLine: `Revisión guardada el ${new Date(p.revision.creado_en).toLocaleString("es-CL")} (zona ${p.revision.zona ?? "sin PRC"}). Vuelva a revisar para ver el volumen y las rasantes en el visor.`,
          });
        }
        log("info", `Proyecto abierto: ${p.nombre}.${p.modelos.length ? ` Abra sus IFC: ${p.modelos.map((m) => m.nombre_archivo).join(", ")}.` : ""}`);
      })
      .catch((error: unknown) => log("error", error instanceof Error ? error.message : String(error)));
  }, [proyectoId, supabase, log]);

  const modelosGuardados = (): ModeloGuardado[] =>
    models.map((m) => ({ nombre_archivo: m.name, disciplina: "Arquitectura", condicion: "Proyectado", sha256: m.sha256, bytes: m.bytes, esquema: m.meta?.schema ?? null, elementos: m.elementCount }));

  const saveProject = async () => {
    setProject((p) => ({ ...p, saving: true }));
    try {
      const id = await guardarProyecto(supabase, {
        id: project.id,
        nombre: project.nombre,
        tramite: project.tramite,
        campos: { georef: placement, ubicacion_manual: manualLocation, piso_a_piso: floorHeight },
        ubicacion: location?.center ?? null,
        ubicacion_fuente: location?.source ?? null,
        modelos: modelosGuardados(),
        predio: parcel,
        revision:
          revision && revision.evaluation.lotArea > 0
            ? { tipo: revision.tipo, comuna: territory?.analysis?.comuna?.nombre ?? null, zona: territory?.analysis?.zones[0]?.code ?? null, versionNormas: "normas-2026-10", evaluation: revision.evaluation }
            : null,
      });
      setProject((p) => ({ ...p, id, saving: false, expected: modelosGuardados() }));
      log("info", `Proyecto guardado: ${project.nombre}.`);
    } catch (error) {
      setProject((p) => ({ ...p, saving: false }));
      log("error", error instanceof Error ? error.message : String(error));
    }
  };

  // --- Ciudad 3D (porción precalculada alrededor del proyecto) --------------------------------------------------------
  const carpetaInstrumento = territory?.analysis?.instrument?.carpeta ?? null;
  const cityActive = cityShown && (models.length > 0 || manualLocation !== null);
  const showCity = useCallback(
    async (keepView: boolean) => {
      if (!api.current || !location) {
        api.current?.cityUnavailable(models.length === 0 && !manualLocation ? "Abra un modelo IFC o indique una ubicación para ver la ciudad 3D." : "Primero hay que ubicar el proyecto (pestaña Coordenadas).");
        return;
      }
      const seq = ++citySeq.current;
      // Se marca activa desde el inicio: si la comuna (y sus zonas) llega mientras se descargan las teselas, se rehace.
      setCityShown(true);
      try {
        const area = areaDeCiudad(location, reference.extent);
        const carpeta = carpetaInstrumento;
        const { zonas, alturas } = area && carpeta ? await zonasParaCiudad(supabase, carpeta, area.geojson) : { zonas: [], alturas: null };
        const scene = await escenaCiudad({ location, extent: reference.extent, parcel, zonas, alturasDocumento: alturas ? { documento: alturas.documento, alcance: alturas.alcance } : null });
        if (seq !== citySeq.current || !api.current) return;
        api.current.setTerritory(scene, keepView);
        log("info", `Ciudad 3D: ${scene.buildings.length} edificios, ${scene.roads.length} tramos de calle y ${scene.zones.length} zonas del PRC (porción precalculada).`);
      } catch (error) {
        const message = error instanceof CiudadNoDisponible ? error.message : `No se pudo armar la ciudad 3D: ${error instanceof Error ? error.message : String(error)}`;
        if (seq === citySeq.current) setCityShown(false);
        api.current?.cityUnavailable(message);
        log("warn", `Ciudad 3D: ${message}`);
      }
    },
    [location, reference.extent, parcel, carpetaInstrumento, supabase, models.length, manualLocation, log],
  );
  useEffect(() => {
    cityRequest.current = () => void showCity(false);
  }, [showCity]);
  // Si la ciudad ya se mostró, se rehace con la nueva ubicación o el nuevo predio, con la cámara quieta sobre ella.
  const cityActiveRef = useRef(false);
  const showCityRef = useRef(showCity);
  // Al indicar una ubicación (mapa o lat/lon) la ciudad 3D se carga en ese punto, como en el escritorio.
  const cityPendingRef = useRef(false);
  useEffect(() => {
    cityActiveRef.current = cityActive;
    showCityRef.current = showCity;
  });
  useEffect(() => {
    if (cityPendingRef.current) {
      const wasActive = cityActiveRef.current;
      cityPendingRef.current = false;
      void showCityRef.current(wasActive);
    } else if (cityActiveRef.current) {
      void showCityRef.current(true);
    }
    // carpetaInstrumento llega después de la ubicación (consulta a Supabase): con él se agregan las zonas del PRC.
  }, [location, parcel, carpetaInstrumento]);

  // Calle más cercana a la ubicación (para orientar el predio rectangular).
  useEffect(() => {
    let cancelled = false;
    const center = parcel ? parcelCenter(parcel) : location?.center;
    Promise.resolve(center ? calleMasCercana(center) : null)
      .then((s) => !cancelled && setStreet(s))
      .catch(() => !cancelled && setStreet(null));
    return () => {
      cancelled = true;
    };
  }, [location?.center, parcel]);

  /** Cota del nivel 0 del modelo según el terreno bajo su centro (0 si las cotas Z ya son absolutas), como el escritorio. */
  const groundElevation = async (): Promise<number | null> => {
    if (!frame || !reference.extent) return null;
    const c = extentCenter(reference.extent);
    const g = await alturaTerreno(toGeographic(frameToUtm(frame, c.x, c.y)));
    if (g === null) return null;
    return reference.extent.minZ > 20 && Math.abs(reference.extent.minZ - g) < 25 ? 0 : g;
  };

  // --- Mapa territorial (ventana «Ver mapa») ---------------------------------------------------------------------------
  useEffect(() => {
    if (!mapOpen) return;
    let cancelled = false;
    const center = location?.center;
    Promise.resolve(center ? ciudadPara(center) : null)
      .then((c) => (c ? indiceCiudad(c) : null))
      .then((index) => {
        if (cancelled) return;
        const portions = (index as { porciones?: { bounds: [number, number, number, number] }[] } | null)?.porciones ?? [];
        setCityPortions(portions.map(({ bounds: [a, b, c, d] }) => [
          { latitude: b, longitude: a }, { latitude: b, longitude: c }, { latitude: d, longitude: c }, { latitude: d, longitude: a },
        ]));
      })
      .catch(() => !cancelled && setCityPortions([]));
    return () => {
      cancelled = true;
    };
  }, [mapOpen, location?.center]);
  const mapProject = useMemo<ProyectoMapa>(() => {
    const summary: string[] = [];
    if (location) {
      const utm = location.utm ? ` · UTM ${location.utm.zone}${location.utm.south ? "S" : "N"} E ${n(location.utm.easting, 0)} N ${n(location.utm.northing, 0)}` : "";
      summary.push(`Ubicación · ${SOURCE_LABELS[location.source]}: ${n(location.center.latitude, 6)}, ${n(location.center.longitude, 6)}${utm}`);
      for (const note of location.notes) summary.push(note);
    }
    for (const z of territory?.analysis?.zones ?? []) summary.push(`Zona ${z.code}${z.name !== z.code ? ` - ${z.name}` : ""}${z.sharePercent < 100 ? ` · ${n(z.sharePercent, 1)} % del proyecto` : ""}`);
    for (const a of territory?.analysis?.specialAreas ?? []) summary.push(`⚠ Dentro de: ${a.name} (${a.layer})`);
    for (const t of territory?.analysis?.notes ?? []) summary.push(`⚠ ${t}`);
    if (territory?.analysis?.instrument) summary.push(`Fuente: ${territory.analysis.coverage} — ${territory.analysis.disclaimer}`);
    const area = location && cityActive ? areaDeCiudad(location, reference.extent) : null;
    const cityArea = area ? [
      { latitude: area.env.minLat, longitude: area.env.minLon }, { latitude: area.env.minLat, longitude: area.env.maxLon },
      { latitude: area.env.maxLat, longitude: area.env.maxLon }, { latitude: area.env.maxLat, longitude: area.env.minLon },
    ] : null;
    return {
      center: location?.center ?? null,
      footprint: location?.footprint ?? null,
      label: project.nombre || models[0]?.name || "Proyecto",
      summary,
      cityArea,
      cityPortions,
      parcel: parcel?.vertices ?? null,
    };
  }, [location, territory, cityActive, reference.extent, project.nombre, models, parcel, cityPortions]);

  // --- Ubicación manual y georreferencia -----------------------------------------------------------------------------
  const relocate = (point: GeoPoint) => {
    if (reference.extent) {
      const zone = fromGeographic(point).zone;
      const basis: UserPlacement =
        placement ??
        (frame && !frame.assumed
          ? placementFromFrame(frame, reference.geo?.mapConversion?.crsName)
          : { easting: 0, northing: 0, elevation: null, rotationDegrees: 0, crsName: crsFor(null, zone).name, zone });
      const c = extentCenter(reference.extent);
      setManualLocation(null);
      setPlacement(centeredAt(basis, c.x, c.y, fromGeographic(point, basis.zone)));
    } else {
      setManualLocation(point);
    }
    cityPendingRef.current = true;
    log("info", `Ubicación del proyecto indicada: ${n(point.latitude, 6)}, ${n(point.longitude, 6)}. La ciudad 3D se carga en ese punto.`);
  };

  const useIfc = () => {
    setManualLocation(null);
    setPlacement(null);
    log("info", "Ubicación y georreferencia manual descartadas: se usa la que declaran los modelos IFC.");
  };

  // --- Predio ---------------------------------------------------------------------------------------------------------
  const importParcel = async (file: File) => {
    try {
      const imported = importParcelGeoJson(await file.text(), file.name);
      // La georreferencia declarada en el IFC es un dato documentado; una ubicación indicada a mano no.
      setParcel({ ...imported, positionConfirmed: location?.source === "mapConversion" });
      log("info", `Predio importado: ${imported.source} · ${n(parcelAreaOf(imported))} m², ${imported.vertices.length} deslindes.`);
      setEditRequest((r) => r + 1);
    } catch (error) {
      log("error", `No se pudo importar el predio: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const rectangle = (front: number, depth: number, bearing: number | null) => {
    if (!location) return;
    const center = parcel ? parcelCenter(parcel) : isSiteStudy && manualLocation ? manualLocation : location.center;
    // Frente hacia la calle más cercana: la dirección desde el punto hacia la calle, en grados desde el norte.
    const towardStreet = street ? ((Math.atan2(street.directionX, street.directionY) * 180) / Math.PI + 360) % 360 : null;
    const { parcel: created, orientation } = rectangleParcel(center, front, depth, bearing ?? towardStreet);
    setParcel({ ...created, positionConfirmed: models.length === 0 });
    log("info", `Predio rectangular de ${n(front)} × ${n(depth)} m: ${bearing === null && street ? `frente hacia la calle ${street.name ?? "sin nombre"} (${orientation})` : orientation}.`);
    setEditRequest((r) => r + 1);
  };

  const draw = () => {
    if (!frame || !api.current) {
      log("warn", "Para dibujar el predio, ubique primero el proyecto.");
      return;
    }
    const current = parcel?.vertices.flatMap((v) => {
      const p = frameGeoToModel(frame, v);
      return [p.x, p.y];
    });
    setDrawing(true);
    api.current.startParcelDrawing(current ?? null);
  };

  // --- Revisión (porte de ReviewGeometry / RunCabidaStudyAsync) ------------------------------------------------------
  const cancelReview = () => running.current?.cancel();

  const cabida = async () => {
    if (!api.current) return;
    setReviewError(null);
    const height = parseNumber(floorHeight);
    const missing = !parcel
      ? "Defina el predio: «Predio rectangular…», «Dibujar predio» o «Importar predio…»."
      : !frame
        ? "Indique la ubicación del predio en la pestaña Coordenadas."
        : height === null || height <= 0
          ? "La altura de piso a piso debe ser un número positivo (m)."
          : null;
    if (missing) {
      setReviewError(missing);
      return;
    }
    setReviewing(true);
    try {
      setReviewProgress("Calculando la cabida…");
      const contexto = await construirContexto(supabase, parcel!, frame!, [], { permitName: project.tramite });
      const run = evaluarCabidaEnWorker({ type: "cabida", oguc: contexto.oguc, local: contexto.local, input: contexto.input, floorHeight: height! });
      running.current = run;
      const study = await run.result;
      const statusLine = `Estudio de cabida · zona ${contexto.zoneCode ?? "sin PRC"} · predio ${n(study.lotArea)} m² · hasta ${n(study.buildableArea, 1)} m² en ${study.floors.length} piso${study.floors.length === 1 ? "" : "s"}${contexto.zoneNote ? ` · ${contexto.zoneNote}` : ""}`;
      setRevision({ tipo: "cabida", evaluation: study, statusLine });
      api.current.setEnvelope(envelopeGrid(study.volume));
      api.current.setRasantes(rasanteScene(study.rasantes));
      log("info", `${statusLine}.`);
      setTab("revision");
    } catch (error) {
      const message = error instanceof RevisionCancelada ? "Revisión cancelada." : `No se pudo calcular la cabida: ${error instanceof Error ? error.message : String(error)}`;
      setReviewError(message);
      log(error instanceof RevisionCancelada ? "warn" : "error", message);
    } finally {
      running.current = null;
      setReviewing(false);
      setReviewProgress(null);
    }
  };

  const review = async () => {
    if (!api.current) return;
    if (isSiteStudy) return cabida();
    setReviewError(null);
    const missing =
      models.length === 0
        ? "Abra un modelo IFC, o indique una ubicación sin modelo para un estudio de cabida."
        : !parcel
          ? "Defina el predio en la pestaña Predio."
          : !frame
            ? "Ubique el modelo en su predio (pestaña Coordenadas: ubicación o georreferencia)."
            : null;
    if (missing) {
      setReviewError(missing);
      return;
    }
    setReviewing(true);
    try {
      const geometries: ModelGeometry[] = [];
      const fireRatings: Record<string, string> = {};
      for (const m of models) {
        let geometry = geometryCache.current.get(m.sha256);
        if (!geometry) {
          setReviewProgress(`Geometría de ${m.name}…`);
          const bytes = new Uint8Array(await m.file.arrayBuffer());
          geometry = await extraerGeometria(bytes, m.modelId, m.sha256, (stage, p) => setReviewProgress(`Geometría de ${m.name}: ${stage}${p != null && p > 0 ? ` ${Math.round(p * 100)} %` : ""}`));
          geometryCache.current.set(m.sha256, geometry);
          log("info", `${m.name}: geometría extraída para la revisión normativa (${geometry.elements.length} elementos).`);
        }
        const withId = { ...geometry, modelId: m.modelId };
        geometries.push(withId);
        const walls = withId.elements.filter((e) => e.ifcClass.startsWith("IfcWall") || e.ifcClass === "IfcCurtainWall").map((e) => e.expressId);
        for (const [id, rating] of await api.current.fireRatings(m.modelId, walls)) fireRatings[fireRatingKey(m.modelId, id)] = rating;
      }
      setReviewProgress("Zonas del PRC y normativa…");
      const contexto = await construirContexto(supabase, parcel!, frame!, geometries, { fireRatings, permitName: project.tramite });
      setReviewProgress("Evaluando reglas…");
      const run = evaluarReglasEnWorker({ type: "reglas", oguc: contexto.oguc, local: contexto.local, input: contexto.input });
      running.current = run;
      const evaluation = await run.result;
      const statusLine = `Zona ${contexto.zoneCode ?? "sin PRC"} · predio ${n(evaluation.lotArea)} m² · ${countStates(evaluation.results)}${contexto.zoneNote ? ` · ${contexto.zoneNote}` : ""}`;
      setRevision({ tipo: "revision", evaluation, statusLine });
      api.current.setEnvelope(envelopeGrid(evaluation.volume));
      api.current.setRasantes(rasanteScene(evaluation.rasantes));
      log("info", `Revisión geométrica: ${statusLine}.`);
      setTab("revision");
    } catch (error) {
      if (error instanceof RevisionCancelada) {
        setReviewError("Revisión cancelada.");
        log("warn", "Revisión cancelada.");
      } else {
        const message = `No se pudo completar la revisión: ${error instanceof Error ? error.message : String(error)}`;
        setReviewError(message);
        log("error", message);
      }
    } finally {
      running.current = null;
      setReviewing(false);
      setReviewProgress(null);
    }
  };

  const showElements = (result: RuleResult) => {
    const ids = [...new Set(result.elements.map((e) => e.globalId).filter((g): g is string => !!g))];
    if (ids.length > 0) void api.current?.selectElements({ globalIds: ids }, true);
  };

  const locate = () => {
    const text = search.trim();
    const expressId = /^#(\d+)$/.exec(text);
    if (expressId) void api.current?.selectElements({ expressIds: [Number(expressId[1])] }, true);
    else if (/^[0-9A-Za-z_$]{22}$/.test(text)) void api.current?.selectElements({ globalIds: [text] }, true);
    else log("warn", "Identificador no reconocido: use #ExpressID (ej. #63) o un GlobalId de 22 caracteres.");
  };

  // --- Alertas por pestaña (como en el escritorio) -------------------------------------------------------------------
  const geoLines = useMemo(
    () => models.map((m) => ({ name: m.name, lines: m.meta ? describeGeolocation(m.meta.geolocation) : ["⚠ No se pudieron leer los metadatos del IFC."] })),
    [models],
  );
  const projectAlerts: Alerta[] = [
    ...geoLines.flatMap((g) => g.lines.filter((l) => l.startsWith("⚠") && !/fuera de Chile/i.test(l)).map((l) => alerta(`${g.name}: ${l.replace(/^⚠\s*/, "")}`))),
    ...models.flatMap((m) => (m.meta?.warnings ?? []).map((w) => alerta(`${m.name}: ${w}`, "info"))),
  ];
  const analysis = territory?.analysis ?? null;
  const locationAlerts: Alerta[] = [
    ...geoLines.flatMap((g) => g.lines.filter((l) => /fuera de Chile/i.test(l)).map((l) => alerta(`${g.name}: ${l.replace(/^⚠\s*/, "")}`))),
    ...(territory?.error ? [alerta(territory.error, "danger")] : []),
    ...(analysis?.notes.map((t) => alerta(t)) ?? []),
    ...(analysis?.specialAreas.map((a) => alerta(`Dentro de: ${a.name} (${a.layer})`, "warn", a.sheetUrl)) ?? []),
    ...(analysis?.roads.map((r) => alerta(`Faja de vialidad PRC (${r.kind}) a ${n(r.distanceMeters, 1)} m: posible afectación a utilidad pública. Verifíquelo en el CIP.`)) ?? []),
    ...(analysis?.instrument && !analysis.hasNorms ? [alerta("Esta comuna tiene zonificación pero aún no tiene las cifras de su Ordenanza verificadas: la revisión geométrica no podrá aplicar sus normas.")] : []),
  ];
  const coordinateAlerts: Alerta[] = [
    ...(!location && models.some((m) => m.meta) ? [alerta("Los modelos no traen una ubicación confiable. Indíquela abajo con latitud y longitud y luego ajuste el origen con «Georreferenciar».")] : []),
    ...(location?.notes.filter((t) => t.startsWith("⚠") || t.startsWith("Supuesto")).map((t) => alerta(t.replace(/^⚠\s*/, ""))) ?? []),
    ...(location?.needsConfirmation && !location.notes.some((t) => t.startsWith("⚠") || t.startsWith("Supuesto")) ? [alerta("Confirme la ubicación: la fuente es un supuesto o una aproximación.")] : []),
    ...(placement || manualLocation ? [alerta("Ubicación o georreferencia definida a mano: sustituye a la que declaran los IFC. Se guarda con el proyecto.", "info")] : []),
  ];
  const parcelAlerts: Alerta[] = !parcel
    ? [alerta("Sin predio. Impórtelo (GeoJSON), dibújelo en la planta del visor o cree uno rectangular, según la inscripción del CBR y el CIP.", "info")]
    : [
        ...(parcel.edges.some((e) => e.kind === "Frente" && e.officialLinesWidth === null) ? [alerta("Falta el ancho entre líneas oficiales de un frente (dato del CIP). Indíquelo en «Deslindes…».")] : []),
        ...(!parcel.groundConfirmed ? [alerta(`Suelo natural supuesto en Z = ${n(parcel.naturalGroundZ)} m: confírmelo en «Deslindes…».`)] : []),
        ...(!parcel.positionConfirmed ? [alerta("Posición del modelo en el predio sin verificar: confírmela en «Deslindes…».")] : []),
      ];
  const reviewAlerts: Alerta[] = [
    ...(reviewError ? [alerta(reviewError, reviewError.startsWith("No se pudo") ? "danger" : "warn")] : []),
    ...(!revision && !reviewing && !reviewError
      ? models.length === 0 && !isSiteStudy
        ? [alerta("Abra un modelo IFC o indique una ubicación sin modelo (pestaña Coordenadas) para un estudio de cabida.", "info")]
        : !parcel
          ? [alerta("Defina el predio en la pestaña Predio antes de revisar.", "info")]
          : !frame
            ? [alerta("Ubique el modelo en su predio desde la pestaña Coordenadas.")]
            : []
      : []),
    ...(parcel && (!parcel.groundConfirmed || !parcel.positionConfirmed)
      ? [alerta("Supuestos sin confirmar (suelo natural o posición del modelo): las reglas que dependen de ellos quedan en «Revisión requerida», nunca en «Cumple». Confírmelos en «Deslindes…».")]
      : []),
  ];

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
        {mapOpen && (
          <MapaPanel
            supabase={supabase}
            project={mapProject}
            pickHint={mapOpen.pickHint}
            onPick={(p) => relocate(p)}
            onClose={() => setMapOpen(null)}
            onError={(m) => log("error", `Mapa: ${m}`)}
          />
        )}
        {models.length === 0 && !progress && (
          <div className="drop-hint">
            <div className="box">
              <strong>{ready ? "Sin modelo cargado" : "Iniciando el visor…"}</strong>
              <span className="small">Arrastre un archivo IFC aquí o use «Abrir IFC».</span>
              <span className="small muted">Máximo 100 MB por archivo en la versión web.</span>
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

      <aside className="side side-left">
        <div className="tabs" role="tablist" aria-label="IFC">
          {IFC_TABS.map((t) => (
            <button key={t.id} role="tab" aria-selected={ifcTab === t.id} onClick={() => setIfcTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
        {ifcTab === "modelos" && (
          <ModelosPanel
            models={models}
            alerts={projectAlerts}
            ready={ready}
            expected={project.expected}
            onOpen={openFiles}
            onVisible={(id, visible) => void api.current?.setVisible(id, visible)}
            onUnload={(id) => void api.current?.unload(id)}
          />
        )}
        {ifcTab === "elemento" && <ElementoPanel selection={selection} search={search} onSearch={setSearch} onLocate={locate} />}
      </aside>

      <aside className="side">
        <div className="tabs" role="tablist" aria-label="Proyecto">
          {TABS.map((t) => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
        {tab === "proyecto" && (
          <ProyectoPanel alerts={[]} logs={logs} project={project} onNombre={(nombre) => setProject((p) => ({ ...p, nombre }))} onSave={() => void saveProject()} />
        )}
        {tab === "ubicacion" && <UbicacionPanel territory={territory} alerts={locationAlerts} hasModels={models.length > 0} onShowMap={() => setMapOpen({ pickHint: null })} />}
        {tab === "coordenadas" && (
          <CoordenadasPanel
            territory={territory}
            alerts={coordinateAlerts}
            models={models}
            hasManual={placement !== null || manualLocation !== null}
            onRelocate={relocate}
            onUseIfc={useIfc}
            editorInitial={editorInitial}
            pivot={pivot}
            lastPicked={lastPicked}
            onEditStart={() => {
              placementBeforeEditing.current = placement;
            }}
            onShowCity={() => void showCity(cityActive)}
            onShowMap={() => setMapOpen({ pickHint: null })}
            cityShown={cityActive}
            groundElevation={groundElevation}
            onPreview={(p) => setPlacement(p)}
            onAccept={(p) => {
              setPlacement(p);
              log("info", `Georreferencia aplicada: E ${n(p.easting)} · N ${n(p.northing)} · rotación ${n(p.rotationDegrees)}°.`);
            }}
            onCancel={() => setPlacement(placementBeforeEditing.current)}
          />
        )}
        {tab === "predio" && (
          <PredioPanel
            parcel={parcel}
            alerts={parcelAlerts}
            canPlace={frame !== null}
            drawing={drawing}
            onImport={(f) => void importParcel(f)}
            onRectangle={rectangle}
            onDraw={draw}
            onApply={(p) => setParcel(p)}
            onClear={() => {
              setParcel(null);
              log("info", "Predio quitado.");
            }}
            editRequest={editRequest}
            street={street ? { name: street.name, distance: street.distance } : null}
          />
        )}
        {tab === "revision" && (
          <RevisionPanel
            revision={revision}
            reviewing={reviewing}
            progress={reviewProgress}
            alerts={reviewAlerts}
            isSiteStudy={isSiteStudy}
            floorHeight={floorHeight}
            onFloorHeight={setFloorHeight}
            onRun={() => void review()}
            onCancel={cancelReview}
            onShowElements={showElements}
          />
        )}
      </aside>
    </div>
  );
}
