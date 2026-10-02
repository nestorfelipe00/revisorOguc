"use client";

// Láminas de la cabida preliminar dibujadas con SVG propio (sin librerías): planta del predio, corte con rasantes y pila de pisos.
// Cada lámina es una lista de primitivas que se dibuja igual en React (pestaña Cabida, escalada al ancho del panel) y como
// cadena SVG (informe impreso a PDF), para que ambas muestren exactamente lo mismo. Fondo blanco propio: se lee igual en el
// panel oscuro y en papel.
import type { ReactNode } from "react";
import { fromGeographic, zoneFor } from "@/lib/territorio/utm";
import { distanciamiento } from "@/lib/reglas/cabidaPreliminar";
import type { BoundaryKind, CabidaPreliminar, Parcel } from "@/lib/reglas/tipos";

type Ancla = "start" | "middle" | "end";

type Primitiva =
  | { k: "path"; d: string; fill?: string; stroke?: string; sw?: number; dash?: string; op?: number; clip?: string }
  | { k: "line"; x1: number; y1: number; x2: number; y2: number; stroke: string; sw?: number; dash?: string }
  | { k: "rect"; x: number; y: number; w: number; h: number; fill?: string; stroke?: string; sw?: number; dash?: string }
  | { k: "text"; x: number; y: number; t: string; size?: number; anchor?: Ancla; fill?: string; bold?: boolean; halo?: boolean }
  | { k: "clip"; id: string; d: string };

export interface Lamina {
  id: string;
  titulo: string;
  w: number;
  h: number;
  prims: Primitiva[];
}

export const LEYENDA_LAMINA = "Referencial: estudio preliminar, no reemplaza el CIP ni la revisión de la DOM";

const W = 400;
const FONT = "Segoe UI, Arial, sans-serif";
const INK = "#1b1f23";
const MUTED = "#57606a";
const KIND_COLORS: Record<BoundaryKind, string> = { Vecino: "#e8590c", Frente: "#1c7ed6", AreaVerde: "#2f9e44" };
const KIND_LABELS: Record<BoundaryKind, string> = { Vecino: "Deslinde con vecino", Frente: "Frente a espacio público", AreaVerde: "Frente a área verde" };
const YARD = "#cfe8c4";
const SETBACK = "#fbd9c2";
const BUILDABLE = "#cdbfe9";
const FLOOR = "#bcd6ee";
const FLOOR_EDGE = "#2b5d8a";
const PARKING = "#c9ccd1";

const n = (v: number, d = 2) => (Math.round(v * 10 ** d) / 10 ** d).toLocaleString("es-CL", { maximumFractionDigits: d, useGrouping: false });
const r1 = (v: number) => Math.round(v * 10) / 10;

interface P {
  x: number;
  y: number;
}

// ---------- Geometría del predio (metros locales, X este, Y norte) ----------

interface Deslinde {
  numero: number;
  a: P;
  b: P;
  kind: BoundaryKind;
  ancho: number | null;
  largo: number;
  /** Normal hacia el interior del predio. */
  nx: number;
  ny: number;
}

function deslindes(parcel: Parcel): { pts: P[]; edges: Deslinde[] } {
  const zone = zoneFor(parcel.vertices[0].longitude);
  const utm = parcel.vertices.map((v) => fromGeographic(v, zone));
  const cx = utm.reduce((s, p) => s + p.easting, 0) / utm.length;
  const cy = utm.reduce((s, p) => s + p.northing, 0) / utm.length;
  const pts = utm.map((p) => ({ x: p.easting - cx, y: p.northing - cy }));
  let area2 = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    area2 += a.x * b.y - b.x * a.y;
  }
  const ccw = area2 > 0;
  const edges = pts.map((a, i) => {
    const b = pts[(i + 1) % pts.length];
    const largo = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const dx = (b.x - a.x) / largo;
    const dy = (b.y - a.y) / largo;
    const info = parcel.edges[i];
    return { numero: i + 1, a, b, kind: info?.kind ?? "Vecino", ancho: info?.officialLinesWidth ?? null, largo, nx: ccw ? -dy : dy, ny: ccw ? dx : -dx };
  });
  return { pts, edges };
}

function dentro(p: P, pts: P[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i];
    const b = pts[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function distanciaSegmento(p: P, a: P, b: P): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Superficie del predio fuera de las franjas (antejardín y distanciamientos), por muestreo en grilla, y su centro. */
function areaLibre(pts: P[], franjas: { a: P; b: P; ancho: number }[]): { area: number; centro: P | null } {
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const step = Math.max(0.25, Math.sqrt(((maxX - minX) * (maxY - minY)) / 60000));
  let cells = 0;
  let sx = 0;
  let sy = 0;
  for (let x = minX + step / 2; x < maxX; x += step) {
    for (let y = minY + step / 2; y < maxY; y += step) {
      const p = { x, y };
      if (!dentro(p, pts)) continue;
      if (franjas.some((f) => f.ancho > 0 && distanciaSegmento(p, f.a, f.b) < f.ancho)) continue;
      cells++;
      sx += x;
      sy += y;
    }
  }
  return { area: cells * step * step, centro: cells > 0 ? { x: sx / cells, y: sy / cells } : null };
}

// ---------- Piezas comunes de una lámina ----------

const path = (pts: P[], close = true) => pts.map((p, i) => `${i === 0 ? "M" : "L"}${r1(p.x)} ${r1(p.y)}`).join(" ") + (close ? " Z" : "");

/** Largo «redondo» de la escala gráfica (1, 2, 5 × 10ⁿ m) que ocupe entre ~40 y ~110 px. */
function largoEscala(pxPorMetro: number): number {
  const nice = [0.5, 1, 2, 5, 10, 20, 25, 50, 100, 200, 500];
  let best = nice[0];
  for (const v of nice) if (v * pxPorMetro <= 110) best = v;
  return best;
}

function escalaGrafica(x: number, y: number, pxPorMetro: number, vertical = false): Primitiva[] {
  const L = largoEscala(pxPorMetro);
  const len = L * pxPorMetro;
  const out: Primitiva[] = [];
  if (vertical) {
    out.push(
      { k: "rect", x: x - 2.5, y: y - len, w: 5, h: len / 2, fill: INK, stroke: INK, sw: 0.6 },
      { k: "rect", x: x - 2.5, y: y - len / 2, w: 5, h: len / 2, fill: "#fff", stroke: INK, sw: 0.6 },
      { k: "text", x: x + 5, y: y + 3, t: "0", size: 7.5, fill: MUTED },
      { k: "text", x: x + 5, y: y - len + 3, t: `${n(L)} m`, size: 7.5, fill: MUTED },
    );
    return out;
  }
  out.push(
    { k: "rect", x, y, w: len / 2, h: 4, fill: INK, stroke: INK, sw: 0.6 },
    { k: "rect", x: x + len / 2, y, w: len / 2, h: 4, fill: "#fff", stroke: INK, sw: 0.6 },
    { k: "text", x, y: y + 12, t: "0", size: 7.5, anchor: "middle", fill: MUTED },
    { k: "text", x: x + len / 2, y: y + 12, t: n(L / 2), size: 7.5, anchor: "middle", fill: MUTED },
    { k: "text", x: x + len, y: y + 12, t: `${n(L)} m`, size: 7.5, anchor: "middle", fill: MUTED },
  );
  return out;
}

/** Hoja de la lámina: marco, título, el dibujo (hasta contentBottom), la leyenda de colores en dos columnas y el descargo al pie. */
function hoja(id: string, titulo: string, contentBottom: number, prims: Primitiva[], leyenda: { color: string; label: string; line?: boolean }[]): Lamina {
  const filas = Math.ceil(leyenda.length / 2);
  const h = contentBottom + 16 + filas * 12 + 14;
  const out: Primitiva[] = [{ k: "rect", x: 0.5, y: 0.5, w: W - 1, h: h - 1, fill: "#ffffff", stroke: "#c9d1d9", sw: 1 }];
  out.push({ k: "text", x: 12, y: 19, t: titulo, size: 12, bold: true, fill: "#1F5C3A" });
  out.push(...prims);
  leyenda.forEach((item, i) => {
    const x = 12 + (i % 2) * 190;
    const y = contentBottom + 18 + Math.floor(i / 2) * 12;
    if (item.line) out.push({ k: "line", x1: x, y1: y - 3, x2: x + 12, y2: y - 3, stroke: item.color, sw: 2.5 });
    else out.push({ k: "rect", x, y: y - 7, w: 12, h: 8, fill: item.color, stroke: "#8c959f", sw: 0.5 });
    out.push({ k: "text", x: x + 16, y, t: item.label, size: 8, fill: INK });
  });
  out.push({ k: "text", x: 12, y: h - 8, t: LEYENDA_LAMINA, size: 7.5, fill: MUTED });
  return { id, titulo, w: W, h, prims: out };
}

// ---------- (a) Planta del predio ----------

function laminaPlanta(parcel: Parcel, c: CabidaPreliminar): Lamina {
  const { pts, edges } = deslindes(parcel);
  const e = c.entrada;
  const yard = e.antejardin.valor ?? 0;
  const altura = c.alturaEdificio ?? e.alturaMetros.valor ?? null;
  // Distanciamiento con vano (departamentos con ventanas) a la altura del edificio estimado.
  const setback = altura !== null ? distanciamiento(e.distanciamientos.tabla, altura, true) : 0;
  const franjas = edges.map((d) => ({ a: d.a, b: d.b, ancho: d.kind === "Frente" ? yard : setback }));
  const libre = areaLibre(pts, franjas);

  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const box = { x: 40, y: 46, w: W - 80, h: 214 };
  const k = Math.min(box.w / (maxX - minX || 1), box.h / (maxY - minY || 1));
  const ox = box.x + (box.w - (maxX - minX) * k) / 2;
  const oy = box.y + (box.h - (maxY - minY) * k) / 2;
  const T = (p: P): P => ({ x: ox + (p.x - minX) * k, y: oy + (maxY - p.y) * k });

  const prims: Primitiva[] = [];
  const lote = path(pts.map(T));
  prims.push({ k: "clip", id: "lamina-planta-lote", d: lote });
  prims.push({ k: "path", d: lote, fill: BUILDABLE });
  edges.forEach((d, i) => {
    const ancho = franjas[i].ancho;
    if (ancho <= 0) return;
    const quad = [d.a, d.b, { x: d.b.x + d.nx * ancho, y: d.b.y + d.ny * ancho }, { x: d.a.x + d.nx * ancho, y: d.a.y + d.ny * ancho }];
    prims.push({ k: "path", d: path(quad.map(T)), fill: d.kind === "Frente" ? YARD : SETBACK, clip: "lamina-planta-lote" });
  });
  // Deslindes con el color de su tipo, número y largo hacia afuera.
  for (const d of edges) {
    const a = T(d.a);
    const b = T(d.b);
    prims.push({ k: "line", x1: r1(a.x), y1: r1(a.y), x2: r1(b.x), y2: r1(b.y), stroke: KIND_COLORS[d.kind], sw: 3 });
  }
  for (const d of edges) {
    const mid = T({ x: (d.a.x + d.b.x) / 2 - d.nx * (12 / k), y: (d.a.y + d.b.y) / 2 - d.ny * (12 / k) });
    prims.push({ k: "text", x: mid.x, y: mid.y + 3, t: `${d.numero} · ${n(d.largo)} m`, size: 8.5, anchor: "middle", fill: KIND_COLORS[d.kind], bold: true, halo: true });
  }
  if (libre.centro) {
    const p = T(libre.centro);
    if (c.ocupacion !== null) prims.push({ k: "text", x: p.x, y: p.y - 3, t: `Ocupación máx. ${n(c.ocupacion)} m²`, size: 9, anchor: "middle", fill: INK, bold: true, halo: true });
    prims.push({ k: "text", x: p.x, y: p.y + 9, t: `libre de franjas: ${n(libre.area, 1)} m²`, size: 8, anchor: "middle", fill: INK, halo: true });
    if (c.ocupacion !== null && libre.area < c.ocupacion - 0.5) {
      prims.push({ k: "text", x: p.x, y: p.y + 20, t: "no cabe: vea la cabida 3D", size: 7.5, anchor: "middle", fill: "#cf222e", bold: true, halo: true });
    }
  }
  // Norte arriba y escala gráfica.
  prims.push(
    { k: "line", x1: W - 22, y1: 46, x2: W - 22, y2: 30, stroke: INK, sw: 1.2 },
    { k: "path", d: `M${W - 26} 35 L${W - 22} 28 L${W - 18} 35 Z`, fill: INK },
    { k: "text", x: W - 22, y: 56, t: "N", size: 8.5, anchor: "middle", fill: INK, bold: true },
  );
  prims.push(...escalaGrafica(40, 272, k));
  const resumen = `Predio ${n(e.superficiePredio)} m²${c.ocupacion !== null ? ` · ocupación ${n(e.ocupacion.valor ?? 0, 4)} × ${n(e.superficiePredio)} m² = ${n(c.ocupacion)} m²` : " · ocupación: dato faltante"}`;
  prims.push({ k: "text", x: 12, y: 300, t: resumen, size: 8, fill: INK });

  const kinds = [...new Set(edges.map((d) => d.kind))];
  const leyenda = [
    ...kinds.map((kind) => ({ color: KIND_COLORS[kind], label: KIND_LABELS[kind], line: true })),
    { color: YARD, label: yard > 0 ? `Antejardín ${n(yard)} m (ficha de la zona)` : "Antejardín: dato faltante (CIP)" },
    { color: SETBACK, label: altura !== null ? `Distanciamiento ${n(setback)} m con vano (${n(altura)} m)` : "Distanciamiento: falta la altura" },
    { color: BUILDABLE, label: "Área donde cabe la ocupación de primer piso" },
  ];
  return hoja("planta", "Planta del predio: deslindes, antejardín y distanciamientos", 304, prims, leyenda);
}

// ---------- (b) Corte con altura máxima y rasantes ----------

function laminaCorte(parcel: Parcel, c: CabidaPreliminar): Lamina {
  const { pts, edges } = deslindes(parcel);
  const e = c.entrada;
  const prims: Primitiva[] = [];
  const notas: string[] = [];
  // Corte perpendicular al frente más largo (o al deslinde más largo si no hay frente), del frente hacia el fondo.
  const fronts = edges.filter((d) => d.kind === "Frente");
  const ref = (fronts.length > 0 ? fronts : edges).reduce((m, d) => (d.largo > m.largo ? d : m));
  const s = (p: P) => (p.x - ref.a.x) * ref.nx + (p.y - ref.a.y) * ref.ny;
  const D = Math.max(...pts.map(s));
  const back = edges.filter((d) => d !== ref).reduce((m, d) => (s({ x: (d.a.x + d.b.x) / 2, y: (d.a.y + d.b.y) / 2 }) > s({ x: (m.a.x + m.b.x) / 2, y: (m.a.y + m.b.y) / 2 }) ? d : m));
  const angle = e.rasante.angulo;
  const tan = angle !== null ? Math.tan((angle * Math.PI) / 180) : null;
  const offsetDe = (d: Deslinde): number | null => {
    if (d.kind !== "Frente") return 0;
    if (d.ancho === null) {
      notas.push(`Deslinde ${d.numero}: sin ancho entre líneas oficiales, sin rasante (dato del CIP).`);
      return null;
    }
    return d.ancho > e.rasante.anchoMaximoFrente ? null : d.ancho / 2;
  };
  const frontOff = offsetDe(ref);
  const backOff = offsetDe(back);
  const yard = e.antejardin.valor ?? 0;
  const hMax = e.alturaMetros.valor;
  const topN = c.pisos.at(-1)?.top ?? 0;
  const zMax = Math.max(hMax ?? 0, topN, 6) + 3;
  const sMin = -(frontOff ?? 0) - 3;
  const sMax = D + (backOff ?? 0) + 3;
  const box = { x: 30, y: 34, w: W - 60, h: 230 };
  const k = Math.min(box.w / (sMax - sMin), box.h / (zMax + 2));
  const ox = box.x + (box.w - (sMax - sMin) * k) / 2;
  const groundY = box.y + zMax * k;
  const X = (sv: number) => ox + (sv - sMin) * k;
  const Y = (z: number) => groundY - z * k;

  // Terreno y suelo.
  prims.push({ k: "rect", x: X(sMin), y: groundY, w: (sMax - sMin) * k, h: 1.5 * k, fill: "#e6e4df" });
  prims.push({ k: "line", x1: X(sMin), y1: groundY, x2: X(sMax), y2: groundY, stroke: INK, sw: 1.2 });
  prims.push({ k: "text", x: X(sMin) + 2, y: groundY - 3, t: "N.T. ±0,00", size: 7.5, fill: MUTED });
  // Líneas oficiales / deslindes del corte.
  for (const [sv, label, kind] of [[0, ref.kind === "Frente" ? "L.O." : `Deslinde ${ref.numero}`, ref.kind], [D, back.kind === "Frente" ? "L.O." : `Deslinde ${back.numero}`, back.kind]] as const) {
    prims.push({ k: "line", x1: X(sv), y1: groundY + 6, x2: X(sv), y2: Y(Math.min(zMax, 4)), stroke: KIND_COLORS[kind], sw: 1.5, dash: "3 2" });
    prims.push({ k: "text", x: X(sv), y: groundY + 15, t: label, size: 7.5, anchor: "middle", fill: KIND_COLORS[kind] });
  }
  if (frontOff !== null && frontOff > 0) {
    prims.push({ k: "line", x1: X(-frontOff), y1: groundY + 6, x2: X(-frontOff), y2: Y(2.5), stroke: KIND_COLORS.Frente, sw: 1, dash: "6 2 1 2" });
    prims.push({ k: "text", x: X(-frontOff), y: groundY + 15, t: "Eje calle", size: 7.5, anchor: "middle", fill: KIND_COLORS.Frente });
  }
  if (backOff !== null && backOff > 0) {
    prims.push({ k: "line", x1: X(D + backOff), y1: groundY + 6, x2: X(D + backOff), y2: Y(2.5), stroke: KIND_COLORS.Frente, sw: 1, dash: "6 2 1 2" });
    prims.push({ k: "text", x: X(D + backOff), y: groundY + 15, t: "Eje calle", size: 7.5, anchor: "middle", fill: KIND_COLORS.Frente });
  }
  // Antejardín (cota bajo el terreno).
  if (ref.kind === "Frente" && yard > 0) {
    prims.push({ k: "rect", x: X(0), y: groundY - 0.3 * k, w: yard * k, h: 0.3 * k, fill: YARD });
    prims.push({ k: "line", x1: X(0), y1: groundY + 22, x2: X(yard), y2: groundY + 22, stroke: INK, sw: 0.8 });
    prims.push({ k: "text", x: X(yard / 2), y: groundY + 31, t: `antejardín ${n(yard)} m`, size: 7.5, anchor: "middle", fill: INK });
  }

  // Altura máxima de la zona.
  if (hMax !== null) {
    prims.push({ k: "line", x1: X(0), y1: Y(hMax), x2: X(D), y2: Y(hMax), stroke: "#cf222e", sw: 1.2, dash: "5 3" });
    prims.push({ k: "text", x: X(D / 2), y: Y(hMax) - 4, t: `Altura máxima ${n(hMax)} m`, size: 8, anchor: "middle", fill: "#cf222e", halo: true });
  } else {
    notas.push(e.alturaLibre ? "La ficha no fija altura máxima: la limitan las rasantes." : "Altura máxima: dato faltante (CIP).");
  }

  // Rasantes desde el eje de la calle (frente) o el deslinde (vecino, área verde).
  const rasante = (origen: number, sentido: 1 | -1, kind: BoundaryKind) => {
    if (tan === null) return;
    let sEnd = origen + (sentido * zMax) / tan;
    let zEnd = zMax;
    const limite = sentido > 0 ? sMax : sMin;
    if ((sentido > 0 && sEnd > limite) || (sentido < 0 && sEnd < limite)) {
      sEnd = limite;
      zEnd = Math.abs(limite - origen) * tan;
    }
    prims.push({ k: "line", x1: X(origen), y1: Y(0), x2: X(sEnd), y2: Y(zEnd), stroke: KIND_COLORS[kind], sw: 1.4 });
    prims.push({ k: "text", x: X(origen) + sentido * 14, y: Y(0) - 5, t: `${n(angle ?? 0)}°`, size: 8, anchor: "middle", fill: KIND_COLORS[kind], bold: true, halo: true });
  };
  if (frontOff !== null) rasante(-frontOff, 1, ref.kind);
  if (backOff !== null) rasante(D + backOff, -1, back.kind);
  if (tan === null) notas.push("Ángulo de rasante: dato faltante (CIP).");

  // Pisos: cada planta entre el antejardín o distanciamiento y las rasantes, con su cota.
  for (const p of c.pisos) {
    const t = p.top;
    const sepFront = ref.kind === "Frente" ? yard : distanciamiento(e.distanciamientos.tabla, t, true);
    const sepBack = back.kind === "Frente" ? yard : distanciamiento(e.distanciamientos.tabla, t, true);
    let sL = sepFront;
    let sR = D - sepBack;
    if (tan !== null && frontOff !== null) sL = Math.max(sL, t / tan - frontOff);
    if (tan !== null && backOff !== null) sR = Math.min(sR, D + backOff - t / tan);
    if (sR - sL < 0.3) {
      prims.push({ k: "text", x: X(D / 2), y: Y((p.base + t) / 2) + 3, t: `Piso ${p.numero}: no cabe en este corte`, size: 7.5, anchor: "middle", fill: "#cf222e", halo: true });
      continue;
    }
    prims.push({ k: "rect", x: X(sL), y: Y(t), w: (sR - sL) * k, h: (t - p.base) * k, fill: FLOOR, stroke: FLOOR_EDGE, sw: 0.8 });
    if ((t - p.base) * k >= 8) prims.push({ k: "text", x: X(sL) + 3, y: Y(t) + Math.min(9, (t - p.base) * k - 1), t: `P${p.numero}`, size: 7, fill: FLOOR_EDGE });
    prims.push({ k: "text", x: X(sR) + 3, y: Y(t) + 3, t: `+${n(t)}`, size: 7, fill: INK, halo: true });
  }
  prims.push(...escalaGrafica(30, groundY + 40, k));
  notas.forEach((t, i) => prims.push({ k: "text", x: W - 12, y: groundY + 40 + i * 10, t, size: 7.5, anchor: "end", fill: MUTED }));

  const tituloCorte = ref.kind === "Frente" ? `Corte perpendicular al frente (deslinde ${ref.numero})` : `Corte perpendicular al deslinde ${ref.numero}`;
  return hoja("corte", `${tituloCorte}: altura, rasantes y pisos`, groundY + 56 + Math.max(0, notas.length - 1) * 10, prims, [
    { color: KIND_COLORS.Frente, label: angle !== null ? `Rasante ${n(angle)}° desde el eje de la calle` : "Rasante: sin ángulo", line: true },
    { color: KIND_COLORS.Vecino, label: angle !== null ? `Rasante ${n(angle)}° desde el deslinde vecino` : "Rasante: sin ángulo", line: true },
    { color: "#cf222e", label: "Altura máxima de la zona", line: true },
    { color: FLOOR, label: `Pisos de ${n(e.pisoAPiso)} m (supuesto) con cota` },
  ]);
}

// ---------- (c) Pila de pisos ----------

function laminaPila(c: CabidaPreliminar): Lamina {
  const e = c.entrada;
  const prims: Primitiva[] = [];
  const pisos = c.pisos;
  const est = c.superficieEstacionamientos;
  const maxArea = Math.max(1, ...pisos.map((p) => p.superficie), est ?? 0);
  const barMax = 190;
  const kx = barMax / maxArea;
  const niveles = pisos.length + 1;
  const kz = Math.min(18, 220 / (niveles * e.pisoAPiso));
  const x0 = 46;
  const groundY = 48 + pisos.length * e.pisoAPiso * kz;
  for (const p of pisos) {
    const y = groundY - p.top * kz;
    const h = e.pisoAPiso * kz;
    prims.push({ k: "rect", x: x0, y, w: Math.max(2, p.superficie * kx), h, fill: FLOOR, stroke: FLOOR_EDGE, sw: 0.8 });
    if (h >= 9) prims.push({ k: "text", x: x0 + 3, y: y + h / 2 + 3, t: `P${p.numero}`, size: 7.5, fill: FLOOR_EDGE, bold: true });
    const [d1, d2, d3] = p.mezcla;
    prims.push({ k: "text", x: x0 + barMax + 8, y: y + h / 2 - (h >= 16 ? 1 : -3), t: `${n(p.superficie, 1)} m² · ${p.departamentos} dpto${p.departamentos === 1 ? "" : "s"}`, size: 8, fill: INK });
    if (h >= 16) prims.push({ k: "text", x: x0 + barMax + 8, y: y + h / 2 + 8, t: `1D ${d1} · 2D ${d2} · 3D ${d3}`, size: 7.5, fill: MUTED });
  }
  prims.push({ k: "line", x1: x0 - 12, y1: groundY, x2: x0 + barMax + 4, y2: groundY, stroke: INK, sw: 1.2 });
  prims.push({ k: "text", x: x0 + barMax + 8, y: groundY + 3, t: "N.T. ±0,00", size: 7.5, fill: MUTED });
  // Estacionamientos bajo el primer piso (superficie estimada con el supuesto de m² por estacionamiento).
  const hEst = e.pisoAPiso * kz;
  if (est !== null && c.estacionamientos !== null) {
    prims.push({ k: "rect", x: x0, y: groundY + 2, w: Math.max(2, est * kx), h: hEst, fill: PARKING, stroke: "#6e7781", sw: 0.8 });
    prims.push({ k: "text", x: x0 + barMax + 8, y: groundY + 2 + hEst / 2 + 3, t: `${c.estacionamientos} estacionamientos · ${n(est, 1)} m²`, size: 8, fill: INK });
  } else {
    prims.push({ k: "rect", x: x0, y: groundY + 2, w: barMax / 2, h: hEst, fill: "#ffffff", stroke: "#6e7781", sw: 0.8, dash: "3 2" });
    prims.push({ k: "text", x: x0 + barMax + 8, y: groundY + 2 + hEst / 2 + 3, t: "Estacionamientos: dato faltante (CIP)", size: 8, fill: "#9a6700" });
  }
  prims.push(...escalaGrafica(22, groundY, kz, true));
  const total = pisos.reduce((s, p) => s + p.superficie, 0);
  const tipos = pisos.reduce<[number, number, number]>((acc, p) => [acc[0] + p.mezcla[0], acc[1] + p.mezcla[1], acc[2] + p.mezcla[2]], [0, 0, 0]);
  const yTot = groundY + hEst + 18;
  prims.push({
    k: "text",
    x: 12,
    y: yTot,
    t: pisos.length > 0 ? `Total: ${n(total, 1)} m² en ${pisos.length} piso${pisos.length === 1 ? "" : "s"} · ${c.departamentos ?? 0} departamentos (1D ${tipos[0]} · 2D ${tipos[1]} · 3D ${tipos[2]})` : "Faltan datos para repartir la cabida en pisos.",
    size: 8.5,
    fill: INK,
    bold: true,
  });
  prims.push({ k: "text", x: 12, y: yTot + 11, t: "Ancho de cada barra proporcional a su superficie; altura a escala.", size: 7.5, fill: MUTED });
  return hoja("pila", "Pila de pisos: superficie, departamentos y estacionamientos", yTot + 14, prims, [
    { color: FLOOR, label: "Piso sobre el terreno" },
    { color: PARKING, label: `Estacionamientos (${n(e.m2Estacionamiento)} m² c/u, supuesto)` },
  ]);
}

/** Las tres láminas de la cabida preliminar. */
export function laminasCabida(parcel: Parcel, c: CabidaPreliminar): Lamina[] {
  return [laminaPlanta(parcel, c), laminaCorte(parcel, c), laminaPila(c)];
}

// ---------- Dibujo: React y cadena SVG ----------

const esc = (t: string): string => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function primitivaSvg(p: Primitiva): string {
  switch (p.k) {
    case "clip":
      return `<defs><clipPath id="${p.id}"><path d="${p.d}"/></clipPath></defs>`;
    case "path":
      return `<path d="${p.d}" fill="${p.fill ?? "none"}"${p.stroke ? ` stroke="${p.stroke}" stroke-width="${p.sw ?? 1}"` : ""}${p.dash ? ` stroke-dasharray="${p.dash}"` : ""}${p.op !== undefined ? ` opacity="${p.op}"` : ""}${p.clip ? ` clip-path="url(#${p.clip})"` : ""}/>`;
    case "line":
      return `<line x1="${r1(p.x1)}" y1="${r1(p.y1)}" x2="${r1(p.x2)}" y2="${r1(p.y2)}" stroke="${p.stroke}" stroke-width="${p.sw ?? 1}"${p.dash ? ` stroke-dasharray="${p.dash}"` : ""} stroke-linecap="round"/>`;
    case "rect":
      return `<rect x="${r1(p.x)}" y="${r1(p.y)}" width="${r1(p.w)}" height="${r1(p.h)}" fill="${p.fill ?? "none"}"${p.stroke ? ` stroke="${p.stroke}" stroke-width="${p.sw ?? 1}"` : ""}${p.dash ? ` stroke-dasharray="${p.dash}"` : ""}/>`;
    case "text":
      return (
        `<text x="${r1(p.x)}" y="${r1(p.y)}" font-size="${p.size ?? 9}" text-anchor="${p.anchor ?? "start"}" fill="${p.fill ?? INK}"${p.bold ? ' font-weight="600"' : ""}` +
        `${p.halo ? ' stroke="#ffffff" stroke-width="3" stroke-linejoin="round" paint-order="stroke"' : ""}>${esc(p.t)}</text>`
      );
  }
}

/** Lámina como cadena SVG (informe HTML/PDF). */
export function laminaSvg(l: Lamina): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${l.w} ${r1(l.h)}" width="100%" font-family="${FONT}" role="img" aria-label="${esc(l.titulo)}">${l.prims.map(primitivaSvg).join("")}</svg>`;
}

function primitivaReact(p: Primitiva, i: number): ReactNode {
  switch (p.k) {
    case "clip":
      return (
        <defs key={i}>
          <clipPath id={p.id}>
            <path d={p.d} />
          </clipPath>
        </defs>
      );
    case "path":
      return <path key={i} d={p.d} fill={p.fill ?? "none"} stroke={p.stroke} strokeWidth={p.stroke ? (p.sw ?? 1) : undefined} strokeDasharray={p.dash} opacity={p.op} clipPath={p.clip ? `url(#${p.clip})` : undefined} />;
    case "line":
      return <line key={i} x1={r1(p.x1)} y1={r1(p.y1)} x2={r1(p.x2)} y2={r1(p.y2)} stroke={p.stroke} strokeWidth={p.sw ?? 1} strokeDasharray={p.dash} strokeLinecap="round" />;
    case "rect":
      return <rect key={i} x={r1(p.x)} y={r1(p.y)} width={r1(p.w)} height={r1(p.h)} fill={p.fill ?? "none"} stroke={p.stroke} strokeWidth={p.stroke ? (p.sw ?? 1) : undefined} strokeDasharray={p.dash} />;
    case "text":
      return (
        <text
          key={i}
          x={r1(p.x)}
          y={r1(p.y)}
          fontSize={p.size ?? 9}
          textAnchor={p.anchor ?? "start"}
          fill={p.fill ?? INK}
          fontWeight={p.bold ? 600 : undefined}
          stroke={p.halo ? "#ffffff" : undefined}
          strokeWidth={p.halo ? 3 : undefined}
          strokeLinejoin={p.halo ? "round" : undefined}
          paintOrder={p.halo ? "stroke" : undefined}
        >
          {p.t}
        </text>
      );
  }
}

/** Lámina en la pestaña: SVG escalado al ancho del panel. */
export function LaminaSvg({ lamina }: { lamina: Lamina }) {
  return (
    <svg className="lamina" viewBox={`0 0 ${lamina.w} ${r1(lamina.h)}`} width="100%" fontFamily={FONT} role="img" aria-label={lamina.titulo}>
      {lamina.prims.map(primitivaReact)}
    </svg>
  );
}

/** Las tres láminas, una debajo de otra. */
export default function CabidaLaminas({ laminas }: { laminas: Lamina[] }) {
  return (
    <div className="laminas">
      {laminas.map((l) => (
        <LaminaSvg key={l.id} lamina={l} />
      ))}
    </div>
  );
}
