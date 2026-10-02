// Geometría por elemento a partir de un modelo abierto en web-ifc. Porte de la función `geometry` (y de `element_points` y
// `element_footprint`) del motor Python tools/ifc-engine/bnc_ifc.py del escritorio: mismas clases excluidas, mismos huecos de
// muro, mismo piso, mismos puntos (vértices únicos a 1 cm + muestras en aristas largas, tope de 4000) y misma huella
// (unión de los triángulos proyectados en planta). Función pura: no depende del DOM ni de Web Workers, para poder probarla
// en Node con la build `web-ifc-api-node`.
//
// Coordenadas: web-ifc entrega las mallas ya en metros (aplica la unidad de longitud del proyecto) y con Y hacia arriba
// (su matriz de colocación incluye el cambio Z→Y); aquí se vuelve al sistema del modelo: x = X, y = −Z, z = Y.
import type * as WebIFC from "web-ifc";
import GeometryFactory from "jsts/org/locationtech/jts/geom/GeometryFactory.js";
import PrecisionModel from "jsts/org/locationtech/jts/geom/PrecisionModel.js";
import Coordinate from "jsts/org/locationtech/jts/geom/Coordinate.js";
import UnaryUnionOp from "jsts/org/locationtech/jts/operation/union/UnaryUnionOp.js";
import TopologyPreservingSimplifier from "jsts/org/locationtech/jts/simplify/TopologyPreservingSimplifier.js";
import ConvexHull from "jsts/org/locationtech/jts/algorithm/ConvexHull.js";
import GeoJSONWriter from "jsts/org/locationtech/jts/io/GeoJSONWriter.js";
import type { Area2D, ElementGeometry, ModelGeometry, MultiPolygon2D, Polygon2D } from "@/lib/reglas/tipos";
import { toIfcClassName } from "./ifcClassNames";

// ---------- Constantes (idénticas a bnc_ifc.py) ----------

/** Clases sin volumen construido (o que no son el edificio): no entran a las reglas geométricas. */
export const GEOMETRY_EXCLUDED = [
  "IfcSpace",
  "IfcOpeningElement",
  "IfcSite",
  "IfcAnnotation",
  "IfcGrid",
  "IfcVirtualElement",
  "IfcSpatialZone",
  "IfcDistributionPort",
  "IfcGeographicElement",
  "IfcFurnishingElement",
] as const;

/** Huella exacta siempre para lo que define la ocupación de suelo; el resto, si su malla es muy detallada, usa la envolvente convexa. */
export const EXACT_FOOTPRINT = [
  "IfcSlab",
  "IfcRoof",
  "IfcWall",
  "IfcColumn",
  "IfcBeam",
  "IfcCurtainWall",
  "IfcPlate",
  "IfcMember",
  "IfcStair",
  "IfcStairFlight",
  "IfcRamp",
  "IfcRampFlight",
  "IfcFooting",
  "IfcRailing",
  "IfcCovering",
  "IfcBuildingElementProxy",
] as const;

/** Triángulos sobre los cuales un elemento no estructural usa la envolvente convexa como huella. */
export const DETAILED_MESH = 300;
/** Triángulos sobre los cuales no se agregan muestras en las aristas (los vértices ya son densos). */
export const DENSE_MESH = 3000;
/** Puntos por elemento; si hay más se toma una muestra que conserva los extremos. */
export const MAX_POINTS = 4000;
/** Puntos intermedios en aristas largas: los excesos pueden estar a media cara. */
export const EDGE_SAMPLE_M = 1.0;
/** Huecos en muros sin ventana ni puerta que los llene: son vanos para la tabla de distanciamientos (art. 2.6.3). */
export const VOID_HOSTS = ["IfcWall", "IfcCurtainWall"] as const;

export type GeometryProgress = (stage: string, progress: number | null) => void;

// ---------- Lectura de líneas IFC ----------

type Handle = { type: number; value: unknown } | null | undefined;

const val = (h: unknown): unknown => (h && typeof h === "object" && "value" in (h as object) ? (h as { value: unknown }).value : h);
const num = (h: unknown, fallback = 0): number => {
  const v = val(h);
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
};
const str = (h: unknown): string | null => {
  const v = val(h);
  return typeof v === "string" && v.length > 0 ? v : null;
};
const refs = (h: unknown): number[] => (Array.isArray(h) ? h.map((r) => num(r, -1)).filter((id) => id >= 0) : []);

const PREFIXES: Record<string, number> = { EXA: 1e18, PETA: 1e15, TERA: 1e12, GIGA: 1e9, MEGA: 1e6, KILO: 1e3, HECTO: 1e2, DECA: 10, DECI: 0.1, CENTI: 0.01, MILLI: 0.001, MICRO: 1e-6, NANO: 1e-9 };

/** Metros por unidad de longitud del proyecto (misma lógica que ifcMetaWorker.ts; se repite porque ese módulo instala un onmessage al importarse). */
export function lengthScaleOf(api: WebIFC.IfcAPI, modelID: number): number {
  const assignments = api.GetLineIDsWithType(modelID, api.GetTypeCodeFromName("IFCUNITASSIGNMENT"));
  for (let i = 0; i < assignments.size(); i++) {
    const assignment = api.GetLine(modelID, assignments.get(i)) as { Units?: Handle[] };
    for (const unitRef of assignment.Units ?? []) {
      const id = num(unitRef, -1);
      if (id < 0) continue;
      const unit = api.GetLine(modelID, id) as { UnitType?: Handle; Prefix?: Handle; Name?: Handle; ConversionFactor?: Handle };
      if (str(unit.UnitType) !== "LENGTHUNIT") continue;
      if (str(unit.Name) === "METRE") return PREFIXES[str(unit.Prefix) ?? ""] ?? 1;
      if (unit.ConversionFactor) {
        const factor = api.GetLine(modelID, num(unit.ConversionFactor, -1), true) as { ValueComponent?: Handle; UnitComponent?: { Prefix?: Handle; Name?: Handle } };
        const base = PREFIXES[str(factor.UnitComponent?.Prefix) ?? ""] ?? 1;
        const value = num(factor.ValueComponent, 0);
        if (value > 0) return value * base;
      }
      return 1;
    }
  }
  return 1;
}

/** Identificadores de todas las instancias de una clase IFC, incluidas sus subclases (equivale a `is_a`). */
function idsOf(api: WebIFC.IfcAPI, modelID: number, ifcClass: string): Set<number> {
  const code = api.GetTypeCodeFromName(ifcClass.toUpperCase());
  const ids = new Set<number>();
  if (!code) return ids;
  const lines = api.GetLineIDsWithType(modelID, code, true);
  for (let i = 0; i < lines.size(); i++) ids.add(lines.get(i));
  return ids;
}

function idsOfAny(api: WebIFC.IfcAPI, modelID: number, classes: readonly string[]): Set<number> {
  const all = new Set<number>();
  for (const c of classes) for (const id of idsOf(api, modelID, c)) all.add(id);
  return all;
}

type LineReader = (id: number) => Record<string, unknown>;

/** Relación «parte → todo» (IfcRelAggregates / IfcRelNests) o «elemento → estructura» (IfcRelContainedInSpatialStructure). */
function parentMap(api: WebIFC.IfcAPI, modelID: number, read: LineReader, relClass: string, childrenKey: string, parentKey: string): Map<number, number> {
  const map = new Map<number, number>();
  for (const relId of idsOf(api, modelID, relClass)) {
    const rel = read(relId);
    const parent = num(rel[parentKey], -1);
    if (parent < 0) continue;
    for (const child of refs(rel[childrenKey])) if (!map.has(child)) map.set(child, parent);
  }
  return map;
}

// ---------- Puntos (element_points) ----------

/**
 * Redondeo a 1 cm como np.round(x, 2): primero se quita el ruido de los float32 de web-ifc (rejilla de 0,01 mm) y los empates
 * exactos (x,xx5) van al par, para que un vértice en 0,075 m dé 0,08 aquí y en el motor Python.
 */
const round2 = (x: number): number => {
  const s = Math.round(x * 1e5) / 1e3; // centímetros, sin ruido de float32
  const f = Math.floor(s);
  const frac = s - f;
  if (Math.abs(frac - 0.5) < 1e-6) return (f % 2 === 0 ? f : f + 1) / 100;
  return Math.round(s) / 100;
};

export interface PointSample {
  points: Float32Array;
  sampled: boolean;
}

/**
 * Vértices únicos (1 cm) más puntos cada ~1 m en las aristas largas (solo si la malla tiene ≤ DENSE_MESH triángulos);
 * si superan MAX_POINTS, muestra que conserva los extremos. `verts` es [x, y, z, …] en coordenadas del modelo.
 */
export function elementPoints(verts: Float64Array, faces: Uint32Array): PointSample {
  const nv = verts.length / 3;
  const nf = faces.length / 3;
  const xs: number[] = [];
  const ys: number[] = [];
  const zs: number[] = [];
  for (let i = 0; i < nv; i++) {
    xs.push(round2(verts[3 * i]));
    ys.push(round2(verts[3 * i + 1]));
    zs.push(round2(verts[3 * i + 2]));
  }
  if (nf > 0 && nf <= DENSE_MESH) {
    const seen = new Set<number>();
    for (let t = 0; t < nf; t++) {
      for (let k = 0; k < 3; k++) {
        const i = faces[3 * t + k];
        const j = faces[3 * t + ((k + 1) % 3)];
        const a = Math.min(i, j);
        const b = Math.max(i, j);
        const key = a * nv + b;
        if (seen.has(key)) continue;
        seen.add(key);
        const ax = verts[3 * a], ay = verts[3 * a + 1], az = verts[3 * a + 2];
        const dx = verts[3 * b] - ax, dy = verts[3 * b + 1] - ay, dz = verts[3 * b + 2] - az;
        const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (length <= EDGE_SAMPLE_M) continue;
        const n = Math.ceil(length / EDGE_SAMPLE_M);
        for (let s = 1; s < n; s++) {
          const u = s / n;
          xs.push(round2(ax + dx * u));
          ys.push(round2(ay + dy * u));
          zs.push(round2(az + dz * u));
        }
      }
    }
  }
  // np.unique(axis=0): filas únicas ordenadas lexicográficamente (x, y, z).
  const order = Array.from({ length: xs.length }, (_, i) => i).sort((i, j) => xs[i] - xs[j] || ys[i] - ys[j] || zs[i] - zs[j]);
  const ux: number[] = [];
  const uy: number[] = [];
  const uz: number[] = [];
  for (const i of order) {
    const m = ux.length;
    if (m > 0 && ux[m - 1] === xs[i] && uy[m - 1] === ys[i] && uz[m - 1] === zs[i]) continue;
    ux.push(xs[i]);
    uy.push(ys[i]);
    uz.push(zs[i]);
  }
  let chosen: number[] = Array.from({ length: ux.length }, (_, i) => i);
  let sampled = false;
  if (ux.length > MAX_POINTS) {
    sampled = true;
    const m = ux.length;
    const argExtreme = (arr: number[], max: boolean): number => {
      let best = 0;
      for (let i = 1; i < m; i++) if (max ? arr[i] > arr[best] : arr[i] < arr[best]) best = i;
      return best;
    };
    const keep = new Set<number>([argExtreme(uz, true), argExtreme(uz, false), argExtreme(ux, true), argExtreme(ux, false), argExtreme(uy, true), argExtreme(uy, false)]);
    const byZ = Array.from({ length: m }, (_, i) => i).sort((i, j) => uz[i] - uz[j]);
    for (const i of byZ.slice(-Math.floor(MAX_POINTS / 4))) keep.add(i);
    const steps = Math.floor(MAX_POINTS / 2);
    for (let s = 0; s < steps; s++) keep.add(Math.floor((s * (m - 1)) / (steps - 1)));
    chosen = [...keep].sort((a, b) => a - b);
  }
  const points = new Float32Array(chosen.length * 3);
  chosen.forEach((i, k) => {
    points[3 * k] = ux[i];
    points[3 * k + 1] = uy[i];
    points[3 * k + 2] = uz[i];
  });
  return { points, sampled };
}

// ---------- Huella (element_footprint) ----------

const writer = new GeoJSONWriter();
const floating = new GeometryFactory(new PrecisionModel());

type GeoJsonLike = { type: string; coordinates?: unknown; geometries?: GeoJsonLike[] };

const roundTo = (x: number, scale: number): number => Math.round(x * scale) / scale;

/** Quita el primer vértice de un anillo si es colineal con sus vecinos (JTS no simplifica el extremo del anillo; GEOS sí). */
function trimRingStart(ring: number[][], tolerance: number): number[][] {
  if (ring.length < 5) return ring;
  const [p0, p1] = ring;
  const pN = ring[ring.length - 2];
  const dx = p1[0] - pN[0], dy = p1[1] - pN[1];
  const len = Math.hypot(dx, dy);
  if (len === 0) return ring;
  const t = ((p0[0] - pN[0]) * dx + (p0[1] - pN[1]) * dy) / (len * len);
  if (t < 0 || t > 1) return ring;
  const dist = Math.abs((p0[0] - pN[0]) * dy - (p0[1] - pN[1]) * dx) / len;
  if (dist > tolerance) return ring;
  const open = ring.slice(1, -1);
  return [...open, open[0]];
}

function toArea(geometry: unknown, tolerance: number): Area2D | null {
  const g = geometry as GeoJsonLike;
  const polygons: number[][][][] = [];
  const collect = (x: GeoJsonLike): void => {
    if (x.type === "Polygon") polygons.push(x.coordinates as number[][][]);
    else if (x.type === "MultiPolygon") polygons.push(...(x.coordinates as number[][][][]));
    else if (x.type === "GeometryCollection") (x.geometries ?? []).forEach(collect);
  };
  collect(g);
  const cleaned = polygons.map((rings) => rings.map((r) => trimRingStart(r, tolerance))).filter((rings) => rings.length > 0 && rings[0].length >= 4);
  if (cleaned.length === 0) return null;
  if (cleaned.length === 1) return { type: "Polygon", coordinates: cleaned[0] } satisfies Polygon2D;
  return { type: "MultiPolygon", coordinates: cleaned } satisfies MultiPolygon2D;
}

/** Unión de triángulos 2D con precisión fija (equivale a shapely.union_all(grid_size=1/scale)) y simplificación 5 mm. */
function unionTriangles(tris: number[][][], scale: number): unknown {
  const factory = new GeometryFactory(new PrecisionModel(scale));
  const polygons: unknown[] = [];
  for (const [a, b, c] of tris) {
    const pa = [roundTo(a[0], scale), roundTo(a[1], scale)];
    const pb = [roundTo(b[0], scale), roundTo(b[1], scale)];
    const pc = [roundTo(c[0], scale), roundTo(c[1], scale)];
    const signed = ((pb[0] - pa[0]) * (pc[1] - pa[1]) - (pc[0] - pa[0]) * (pb[1] - pa[1])) / 2;
    if (Math.abs(signed) < 1e-7) continue; // colapsado por el redondeo
    const ring = [pa, pb, pc, pa].map(([x, y]) => new Coordinate(x, y));
    polygons.push(factory.createPolygon(factory.createLinearRing(ring)));
  }
  if (polygons.length === 0) return null;
  const union = UnaryUnionOp.union(factory.createGeometryCollection(polygons)) as { isEmpty(): boolean };
  if (union.isEmpty()) return null;
  return TopologyPreservingSimplifier.simplify(union, 0.005);
}

/**
 * Huella en planta: unión de los triángulos proyectados. En un sólido cerrado basta con las caras que miran hacia arriba (la mitad);
 * si la orientación de las caras no es coherente se usan todas. Con exact=false y una malla muy detallada, la envolvente convexa.
 */
export function elementFootprint(verts: Float64Array, faces: Uint32Array, exact: boolean): Area2D | null {
  const nv = verts.length / 3;
  const nf = faces.length / 3;
  if (nf === 0) return null;
  if (!exact && nf > DETAILED_MESH) {
    const coords: unknown[] = [];
    for (let i = 0; i < nv; i++) coords.push(new Coordinate(verts[3 * i], verts[3 * i + 1]));
    const hull = new ConvexHull(coords, floating).getConvexHull() as { getArea(): number };
    return hull.getArea() > 1e-6 ? toArea(writer.write(hull), 0) : null;
  }
  const tris: number[][][] = [];
  const signed = new Float64Array(nf);
  let up = 0;
  let down = 0;
  for (let t = 0; t < nf; t++) {
    const a = faces[3 * t], b = faces[3 * t + 1], c = faces[3 * t + 2];
    const ax = verts[3 * a], ay = verts[3 * a + 1];
    const s = ((verts[3 * b] - ax) * (verts[3 * c + 1] - ay) - (verts[3 * c] - ax) * (verts[3 * b + 1] - ay)) / 2;
    signed[t] = s;
    if (s > 1e-6) up += s;
    else if (s < -1e-6) down -= s;
  }
  const closed = up > 0 && Math.abs(up - down) <= 0.05 * Math.max(up, down);
  for (let t = 0; t < nf; t++) {
    const s = signed[t];
    if (closed ? s > 1e-6 : Math.abs(s) > 1e-6) {
      const a = faces[3 * t], b = faces[3 * t + 1], c = faces[3 * t + 2];
      tris.push([
        [verts[3 * a], verts[3 * a + 1]],
        [verts[3 * b], verts[3 * b + 1]],
        [verts[3 * c], verts[3 * c + 1]],
      ]);
    }
  }
  if (tris.length === 0) return null;
  // Precisión de 1 mm como el motor Python; si la unión falla por robustez, se reintenta con una rejilla más gruesa.
  for (const scale of [1000, 100, 20]) {
    try {
      const union = unionTriangles(tris, scale);
      return union === null ? null : toArea(writer.write(union), 0.005);
    } catch (error) {
      if (scale === 20) console.warn("No se pudo calcular la huella de un elemento:", error instanceof Error ? error.message : error);
    }
  }
  return null;
}

// ---------- Extracción ----------

interface MeshChunk {
  vertices: Float32Array;
  indices: Uint32Array;
  matrix: number[];
}

/** Concatena las geometrías colocadas de un elemento en coordenadas del modelo (m): x = X, y = −Z, z = Y. */
function assemble(chunks: MeshChunk[]): { verts: Float64Array; faces: Uint32Array } {
  let nv = 0;
  let ni = 0;
  for (const c of chunks) {
    nv += c.vertices.length / 6;
    ni += c.indices.length;
  }
  const verts = new Float64Array(nv * 3);
  const faces = new Uint32Array(ni);
  let vo = 0;
  let io = 0;
  for (const { vertices, indices, matrix: m } of chunks) {
    const count = vertices.length / 6;
    for (let i = 0; i < count; i++) {
      const x = vertices[6 * i], y = vertices[6 * i + 1], z = vertices[6 * i + 2];
      const X = m[0] * x + m[4] * y + m[8] * z + m[12];
      const Y = m[1] * x + m[5] * y + m[9] * z + m[13];
      const Z = m[2] * x + m[6] * y + m[10] * z + m[14];
      verts[3 * (vo + i)] = X;
      verts[3 * (vo + i) + 1] = -Z;
      verts[3 * (vo + i) + 2] = Y;
    }
    for (let k = 0; k < indices.length; k++) faces[io + k] = indices[k] + vo;
    vo += count;
    io += indices.length;
  }
  return { verts, faces };
}

/**
 * Geometría por elemento (coordenadas del modelo, m) para las reglas geométricas: puntos, cotas, huella y piso.
 * `lengthScale`: metros por unidad de longitud del proyecto (solo para la Elevation de los pisos; las mallas ya vienen en m).
 */
export function extraer(api: WebIFC.IfcAPI, modelID: number, modelId: string, lengthScale: number, onProgress: GeometryProgress): ModelGeometry {
  onProgress("Leyendo relaciones", null);
  const cache = new Map<number, Record<string, unknown>>();
  const read: LineReader = (id) => {
    let line = cache.get(id);
    if (!line) {
      line = api.GetLine(modelID, id) as Record<string, unknown>;
      cache.set(id, line);
    }
    return line;
  };

  const products = idsOf(api, modelID, "IfcProduct");
  const excluded = idsOfAny(api, modelID, GEOMETRY_EXCLUDED);
  const exact = idsOfAny(api, modelID, EXACT_FOOTPRINT);
  const voidHosts = idsOfAny(api, modelID, VOID_HOSTS);
  const elements = idsOf(api, modelID, "IfcElement");
  const storeys = idsOf(api, modelID, "IfcBuildingStorey");

  const containedIn = parentMap(api, modelID, read, "IfcRelContainedInSpatialStructure", "RelatedElements", "RelatingStructure");
  const aggregatedIn = parentMap(api, modelID, read, "IfcRelAggregates", "RelatedObjects", "RelatingObject");
  const nestedIn = parentMap(api, modelID, read, "IfcRelNests", "RelatedObjects", "RelatingObject");
  const filled = new Set<number>();
  for (const relId of idsOf(api, modelID, "IfcRelFillsElement")) filled.add(num(read(relId).RelatingOpeningElement, -1));

  const hasRepresentation = (id: number): boolean => val(read(id).Representation) != null;

  // Huecos sin relleno en muros (los rellenos ya están como IfcWindow / IfcDoor). Heredan el piso del muro.
  const voidHost = new Map<number, number>();
  for (const relId of idsOf(api, modelID, "IfcRelVoidsElement")) {
    const rel = read(relId);
    const opening = num(rel.RelatedOpeningElement, -1);
    const host = num(rel.RelatingBuildingElement, -1);
    if (opening < 0 || host < 0 || !voidHosts.has(host) || filled.has(opening) || !hasRepresentation(opening)) continue;
    voidHost.set(opening, host);
  }

  const candidates: number[] = [];
  for (const id of products) if (!excluded.has(id) && hasRepresentation(id)) candidates.push(id);
  for (const id of voidHost.keys()) candidates.push(id);
  candidates.sort((a, b) => a - b);

  // ifcopenshell.util.element.get_container: el contenedor del todo que agrega al elemento, si lo hay; si no, el de la relación directa.
  const containerOf = (id: number, depth = 0): number | null => {
    if (depth > 64) return null;
    const whole = aggregatedIn.get(id) ?? nestedIn.get(id);
    if (whole !== undefined) return containerOf(whole, depth + 1);
    return containedIn.get(id) ?? null;
  };
  const storeyOf = (id: number): { name: string | null; elevation: number | null } => {
    let container = containerOf(voidHost.get(id) ?? id);
    let guard = 0;
    while (container !== null && !storeys.has(container) && guard++ < 64) {
      container = aggregatedIn.get(container) ?? (elements.has(container) ? containerOf(container) : null);
    }
    if (container === null || !storeys.has(container)) return { name: null, elevation: null };
    const storey = read(container);
    const elevation = val(storey.Elevation);
    return { name: str(storey.Name), elevation: typeof elevation === "number" && Number.isFinite(elevation) ? elevation * lengthScale : null };
  };

  const result: ElementGeometry[] = [];
  const total = candidates.length;
  const every = Math.max(1, Math.floor(total / 200));
  onProgress("Geometría", 0);
  if (total > 0) {
    api.StreamMeshes(modelID, candidates, (mesh, index) => {
      const chunks: MeshChunk[] = [];
      const placed = mesh.geometries;
      for (let i = 0; i < placed.size(); i++) {
        const pg = placed.get(i);
        const geometry = api.GetGeometry(modelID, pg.geometryExpressID);
        const vertices = api.GetVertexArray(geometry.GetVertexData(), geometry.GetVertexDataSize());
        const indices = api.GetIndexArray(geometry.GetIndexData(), geometry.GetIndexDataSize());
        geometry.delete();
        if (vertices.length > 0) chunks.push({ vertices, indices, matrix: pg.flatTransformation });
      }
      if (chunks.length > 0) {
        const { verts, faces } = assemble(chunks);
        if (verts.length > 0) {
          const id = mesh.expressID;
          const line = read(id);
          const { points, sampled } = elementPoints(verts, faces);
          let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity, zMin = Infinity, zMax = -Infinity;
          for (let k = 0; k < points.length; k += 3) {
            xMin = Math.min(xMin, points[k]);
            xMax = Math.max(xMax, points[k]);
            yMin = Math.min(yMin, points[k + 1]);
            yMax = Math.max(yMax, points[k + 1]);
            zMin = Math.min(zMin, points[k + 2]);
            zMax = Math.max(zMax, points[k + 2]);
          }
          const storey = storeyOf(id);
          result.push({
            expressId: id,
            globalId: str(line.GlobalId),
            ifcClass: toIfcClassName(api.GetNameFromTypeCode(api.GetLineType(modelID, id))),
            name: str(line.Name),
            storeyName: storey.name,
            storeyElevation: storey.elevation,
            xMin, xMax, yMin, yMax, zMin, zMax,
            footprint: voidHost.has(id) ? null : elementFootprint(verts, faces, exact.has(id)),
            points,
            sampled,
          });
        }
      }
      if ((index + 1) % every === 0 || index + 1 === total) onProgress("Geometría", (index + 1) / total);
    });
  }
  onProgress("Geometría", 1);
  return { modelId, elements: result };
}
