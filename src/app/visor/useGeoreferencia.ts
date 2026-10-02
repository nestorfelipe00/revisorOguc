"use client";

// Edición de la georreferencia del modelo con vista previa en vivo. Porte de GeoreferenceViewModel.cs sin las partes que
// dependen de la base de ciudad (cota del terreno) ni de la copia IFC (solo escritorio).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fromGeographic, toGeographic, type UtmPoint } from "@/lib/territorio/utm";
import { frameToUtm } from "@/lib/territorio/location";
import { MAP_CRS_CHILE, centeredAt, crsFor, formatNumber, movedAndRotated, normalizeDegrees, parseNumber, placementFrame, type UserPlacement } from "@/lib/territorio/colocacion";

export interface PuntoConocido {
  model: { x: number; y: number; z: number } | null;
  realEasting: string;
  realNorthing: string;
  realHeight: string;
}

const vacio = (): PuntoConocido => ({ model: null, realEasting: "", realNorthing: "", realHeight: "" });

export interface EditorGeoreferencia {
  crsName: string;
  easting: string;
  northing: string;
  elevation: string;
  rotation: string;
  step: number;
  error: string | null;
  centerText: string;
  canUndo: boolean;
  point1: PuntoConocido;
  point2: PuntoConocido;
  pointsResult: string | null;
  /** Georreferencia válida según los campos; null si hay un error. */
  current: UserPlacement | null;
  setField(field: "easting" | "northing" | "elevation" | "rotation", value: string): void;
  setCrs(name: string): void;
  setStep(step: number): void;
  move(direction: "N" | "S" | "E" | "O" | "+X" | "-X" | "+Y" | "-Y"): void;
  raise(sign: "+" | "-"): void;
  rotate(sign: "+" | "-"): void;
  turn(degrees: number): void;
  applyQuick(dx: number, dy: number, rotationDegrees: number): void;
  undo(): void;
  usePicked(which: 1 | 2, picked: { x: number; y: number; z: number }): void;
  setReal(which: 1 | 2, field: "realEasting" | "realNorthing" | "realHeight", value: string): void;
  applyPoints(): void;
}

interface Campos {
  crsName: string;
  easting: string;
  northing: string;
  elevation: string;
  rotation: string;
}

const camposDe = (p: UserPlacement): Campos => ({
  crsName: crsFor(p.crsName, p.zone).name,
  easting: formatNumber(p.easting),
  northing: formatNumber(p.northing),
  elevation: p.elevation !== null ? formatNumber(p.elevation) : "",
  rotation: formatNumber(p.rotationDegrees),
});

function leer(c: Campos): { placement: UserPlacement | null; error: string | null } {
  const e = parseNumber(c.easting);
  const n = parseNumber(c.northing);
  if (e === null || n === null) return { placement: null, error: "Este y Norte deben ser números (m)." };
  let h: number | null = null;
  if (c.elevation.trim() !== "") {
    h = parseNumber(c.elevation);
    if (h === null) return { placement: null, error: "La cota debe ser un número (m) o quedar vacía." };
  }
  const r = parseNumber(c.rotation);
  if (r === null) return { placement: null, error: "La rotación debe ser un número (grados)." };
  const crs = crsFor(c.crsName, 19);
  return { placement: { easting: e, northing: n, elevation: h, rotationDegrees: r, crsName: crs.name, zone: crs.zone }, error: null };
}

/**
 * @param initial georreferencia de partida
 * @param pivot centro del modelo en planta (coordenadas del modelo): pivote de todo giro
 * @param onPreview se llama con cada georreferencia válida (vista previa en vivo)
 */
export function useGeoreferencia(initial: UserPlacement, pivot: { x: number; y: number }, onPreview: (p: UserPlacement) => void): EditorGeoreferencia {
  const [campos, setCampos] = useState<Campos>(() => camposDe(initial));
  const [step, setStep] = useState(1);
  const [undoStack, setUndo] = useState<UserPlacement[]>([]);
  const [point1, setPoint1] = useState<PuntoConocido>(vacio);
  const [point2, setPoint2] = useState<PuntoConocido>(vacio);
  const [pointsResult, setPointsResult] = useState<string | null>(null);
  const preview = useRef(onPreview);
  useEffect(() => {
    preview.current = onPreview;
  });

  const { placement: current, error } = useMemo(() => leer(campos), [campos]);
  const centerText = useMemo(() => {
    if (!current) return "";
    const utm = frameToUtm(placementFrame(current), pivot.x, pivot.y);
    const geo = toGeographic(utm);
    return `Centro del modelo: E ${formatNumber(utm.easting, 2)} · N ${formatNumber(utm.northing, 2)} (${formatNumber(geo.latitude, 6)}, ${formatNumber(geo.longitude, 6)})`;
  }, [current, pivot.x, pivot.y]);
  const inChile = useMemo(() => {
    if (!current) return true;
    const geo = toGeographic(frameToUtm(placementFrame(current), pivot.x, pivot.y));
    return geo.latitude > -56 && geo.latitude < -17 && geo.longitude > -76 && geo.longitude < -66;
  }, [current, pivot.x, pivot.y]);

  const aplicar = useCallback(
    (next: Campos | ((c: Campos) => Campos)) => {
      setCampos((c) => {
        const n = typeof next === "function" ? next(c) : next;
        const { placement } = leer(n);
        if (placement) queueMicrotask(() => preview.current(placement));
        return n;
      });
    },
    [],
  );
  const pushUndo = useCallback(() => {
    if (current) setUndo((s) => [...s, current].slice(-50));
  }, [current]);

  const setField: EditorGeoreferencia["setField"] = (field, value) => {
    if (field === "rotation") {
      // IfcMapConversion gira alrededor del origen del modelo: se corrigen Este y Norte para girar alrededor del centro.
      aplicar((c) => {
        const before = parseNumber(c.rotation);
        const after = parseNumber(value);
        const e = parseNumber(c.easting);
        const n = parseNumber(c.northing);
        if (before === null || after === null || e === null || n === null) return { ...c, rotation: value };
        const crs = crsFor(c.crsName, 19);
        const previous: UserPlacement = { easting: e, northing: n, elevation: null, rotationDegrees: before, crsName: crs.name, zone: crs.zone };
        const center = frameToUtm(placementFrame(previous), pivot.x, pivot.y);
        const rotated = centeredAt({ ...previous, rotationDegrees: after }, pivot.x, pivot.y, center);
        return { ...c, rotation: value, easting: formatNumber(rotated.easting), northing: formatNumber(rotated.northing) };
      });
      return;
    }
    aplicar((c) => ({ ...c, [field]: value }));
  };

  const setCrs = (name: string) => {
    aplicar((c) => {
      const from = crsFor(c.crsName, 19);
      const to = crsFor(name, 19);
      const e = parseNumber(c.easting);
      const n = parseNumber(c.northing);
      if (from.zone === to.zone || e === null || n === null) return { ...c, crsName: to.name };
      const point: UtmPoint = { easting: e, northing: n, zone: from.zone, south: true };
      const moved = fromGeographic(toGeographic(point), to.zone);
      return { ...c, crsName: to.name, easting: formatNumber(moved.easting), northing: formatNumber(moved.northing) };
    });
  };

  const move: EditorGeoreferencia["move"] = (direction) => {
    if (!current) return;
    pushUndo();
    const r = (current.rotationDegrees * Math.PI) / 180;
    const [cos, sin] = [Math.cos(r), Math.sin(r)];
    const delta: Record<typeof direction, [number, number]> = {
      N: [0, step], S: [0, -step], E: [step, 0], O: [-step, 0],
      "+X": [step * cos, step * sin], "-X": [-step * cos, -step * sin], "+Y": [-step * sin, step * cos], "-Y": [step * sin, -step * cos],
    };
    const [de, dn] = delta[direction];
    aplicar((c) => ({ ...c, easting: formatNumber(current.easting + de), northing: formatNumber(current.northing + dn) }));
  };

  const raise: EditorGeoreferencia["raise"] = (sign) => {
    pushUndo();
    const base = parseNumber(campos.elevation) ?? 0;
    aplicar((c) => ({ ...c, elevation: formatNumber(base + (sign === "+" ? step : -step)) }));
  };

  const rotate: EditorGeoreferencia["rotate"] = (sign) => {
    const r = parseNumber(campos.rotation);
    if (r === null) return;
    pushUndo();
    setField("rotation", formatNumber(r + (sign === "+" ? step : -step)));
  };

  const turn = (degrees: number) => {
    const r = parseNumber(campos.rotation);
    if (r === null) return;
    pushUndo();
    setField("rotation", formatNumber(normalizeDegrees(r + degrees)));
  };

  const applyQuick: EditorGeoreferencia["applyQuick"] = (dx, dy, rotationDegrees) => {
    if (!current) return;
    pushUndo();
    aplicar(camposDe(movedAndRotated(current, pivot.x, pivot.y, dx, dy, rotationDegrees)));
  };

  const undo = () => {
    setUndo((s) => {
      const previous = s[s.length - 1];
      if (previous) aplicar(camposDe(previous));
      return s.slice(0, -1);
    });
  };

  const usePicked: EditorGeoreferencia["usePicked"] = (which, picked) => (which === 1 ? setPoint1 : setPoint2)((p) => ({ ...p, model: picked }));

  const setReal: EditorGeoreferencia["setReal"] = (which, field, value) => (which === 1 ? setPoint1 : setPoint2)((p) => ({ ...p, [field]: value }));

  /** Un punto fija posición y cota; dos puntos fijan además la rotación (como coordenadas en un punto + norte del proyecto en Revit). */
  const applyPoints = () => {
    const m1 = point1.model;
    const e1 = parseNumber(point1.realEasting);
    const n1 = parseNumber(point1.realNorthing);
    if (!m1 || e1 === null || n1 === null) {
      setPointsResult("Complete el punto 1: márquelo en el visor («→ Punto 1») y escriba su Este y Norte reales.");
      return;
    }
    let rotation = parseNumber(campos.rotation);
    if (rotation === null) return;
    pushUndo();
    const notes: string[] = [];
    const m2 = point2.model;
    const e2 = parseNumber(point2.realEasting);
    const n2 = parseNumber(point2.realNorthing);
    if (m2 && e2 !== null && n2 !== null) {
      const modelAngle = Math.atan2(m2.y - m1.y, m2.x - m1.x);
      const realAngle = Math.atan2(n2 - n1, e2 - e1);
      rotation = normalizeDegrees(((realAngle - modelAngle) * 180) / Math.PI);
      const modelDistance = Math.hypot(m2.x - m1.x, m2.y - m1.y);
      const realDistance = Math.hypot(e2 - e1, n2 - n1);
      notes.push(`Rotación calculada con dos puntos: ${formatNumber(rotation)}°.`);
      notes.push(`Distancia entre los puntos: modelo ${formatNumber(modelDistance, 3)} m, real ${formatNumber(realDistance, 3)} m (diferencia ${formatNumber(realDistance - modelDistance, 3)} m; el modelo no se escala).`);
    } else {
      notes.push("Con un punto se conserva la rotación actual; agregue el punto 2 para calcularla.");
    }
    const crs = crsFor(campos.crsName, 19);
    const placed = centeredAt({ easting: 0, northing: 0, elevation: null, rotationDegrees: rotation, crsName: crs.name, zone: crs.zone }, m1.x, m1.y, { easting: e1, northing: n1, zone: crs.zone, south: true });
    const h = parseNumber(point1.realHeight);
    const elevation = h !== null ? formatNumber(h - m1.z, 3) : campos.elevation;
    if (h !== null) notes.push(`Cota: el punto 1 (Z del modelo ${formatNumber(m1.z)}) queda a ${formatNumber(h)} m s. n. m.`);
    aplicar((c) => ({ ...c, rotation: formatNumber(rotation!, 6), easting: formatNumber(placed.easting), northing: formatNumber(placed.northing), elevation }));
    setPointsResult(notes.join(" "));
  };

  return {
    ...campos,
    step,
    error: error ?? (inChile ? null : "Con estos valores el modelo queda fuera de Chile: revise Este y Norte."),
    centerText,
    canUndo: undoStack.length > 0,
    point1,
    point2,
    pointsResult,
    current: inChile ? current : null,
    setField,
    setCrs,
    setStep,
    move,
    raise,
    rotate,
    turn,
    applyQuick,
    undo,
    usePicked,
    setReal,
    applyPoints,
  };
}

export const CRS_OPTIONS = MAP_CRS_CHILE;
