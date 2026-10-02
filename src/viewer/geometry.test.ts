// Compara la geometría extraída con web-ifc (geometryCore.ts) contra la del motor Python IfcOpenShell del escritorio
// (fixtures *.geom.json generados con `bnc_ifc.py geom`): mismo conjunto de elementos, caja a < 1 cm por eje, zMax a 1 cm,
// área de huella a < 0,5 % y mismo piso. Corre en Node con la build `web-ifc-api-node` de web-ifc.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as WebIFC from "web-ifc";
import type { Area2D, ElementGeometry, ModelGeometry } from "@/lib/reglas/tipos";
import { DENSE_MESH, MAX_POINTS, elementFootprint, elementPoints, extraer, lengthScaleOf } from "./geometryCore";

const SAMPLES = "C:\\Users\\Usuario\\Documents\\REVISOR OGUC\\samples\\";
const FIXTURES = fileURLToPath(new URL("../lib/reglas/__fixtures__/", import.meta.url));
const WASM_DIR = fileURLToPath(new URL("../../node_modules/web-ifc/", import.meta.url));

interface FixtureElement {
  expressId: number;
  globalId: string | null;
  ifcClass: string;
  name: string | null;
  storeyName: string | null;
  storeyElevation: number | null;
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  zMin: number;
  zMax: number;
  footprint: Area2D | null;
  points: number[];
  sampled: boolean;
}

interface Fixture {
  modelId: string;
  elements: FixtureElement[];
}

const CASES = [
  { name: "BNC_prueba_IFC4X3", ifc: `${SAMPLES}BNC_prueba_IFC4X3.ifc`, fixture: `${FIXTURES}bnc_prueba.geom.json`, modelId: "bnc" },
  { name: "casa_hipotetica_IFC4X3", ifc: `${SAMPLES}proyecto_hipotetico\\casa_hipotetica_IFC4X3.ifc`, fixture: `${FIXTURES}casa_hipotetica.geom.json`, modelId: "casa" },
];

/** Área con signo de un anillo (fórmula del zapatero). */
const ringArea = (ring: number[][]): number => {
  let s = 0;
  for (let i = 0; i < ring.length - 1; i++) s += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  return s / 2;
};

/** Área de un Polygon/MultiPolygon GeoJSON (exterior menos huecos). */
export function area(a: Area2D | null): number {
  if (!a) return 0;
  const polygons = a.type === "Polygon" ? [a.coordinates] : a.coordinates;
  let total = 0;
  for (const rings of polygons) {
    total += Math.abs(ringArea(rings[0]));
    for (const hole of rings.slice(1)) total -= Math.abs(ringArea(hole));
  }
  return total;
}

async function openApi(): Promise<WebIFC.IfcAPI> {
  const api = new WebIFC.IfcAPI();
  api.SetWasmPath(WASM_DIR, true);
  await api.Init();
  return api;
}

function extractFile(api: WebIFC.IfcAPI, file: string, modelId: string): ModelGeometry {
  const modelID = api.OpenModel(new Uint8Array(readFileSync(file)), { COORDINATE_TO_ORIGIN: false });
  try {
    return extraer(api, modelID, modelId, lengthScaleOf(api, modelID), () => {});
  } finally {
    api.CloseModel(modelID);
  }
}

// ---------- Caja cerrada sintética ----------

/** Caja [0,a]×[0,b]×[0,c] con normales hacia afuera (12 triángulos). */
function box(a: number, b: number, c: number): { verts: Float64Array; faces: Uint32Array } {
  const corners = [
    [0, 0, 0], [a, 0, 0], [a, b, 0], [0, b, 0],
    [0, 0, c], [a, 0, c], [a, b, c], [0, b, c],
  ];
  const quads = [
    [0, 3, 2, 1], // abajo (mira a −z)
    [4, 5, 6, 7], // arriba (mira a +z)
    [0, 1, 5, 4], // y = 0
    [1, 2, 6, 5], // x = a
    [2, 3, 7, 6], // y = b
    [3, 0, 4, 7], // x = 0
  ];
  const faces: number[] = [];
  for (const [p, q, r, s] of quads) faces.push(p, q, r, p, r, s);
  return { verts: new Float64Array(corners.flat()), faces: new Uint32Array(faces) };
}

describe("elementPoints", () => {
  it("vértices únicos a 1 cm y muestras cada metro en las aristas largas", () => {
    const { verts, faces } = box(3, 2, 0.5);
    const { points, sampled } = elementPoints(verts, faces);
    expect(sampled).toBe(false);
    const n = points.length / 3;
    // 8 esquinas + 2 muestras en cada una de las 4 aristas de 3 m + 1 en cada una de las 4 de 2 m + diagonales de las caras (> 1 m).
    expect(n).toBeGreaterThan(8 + 8 + 4);
    const xs = Array.from({ length: n }, (_, i) => points[3 * i]);
    expect(Math.min(...xs)).toBe(0);
    expect(Math.max(...xs)).toBe(3);
    // Todos los puntos están sobre la caja (redondeados a 1 cm).
    for (let i = 0; i < n; i++) {
      const z = points[3 * i + 2];
      expect(z).toBeGreaterThanOrEqual(0);
      expect(z).toBeLessThanOrEqual(0.5);
      expect(Math.abs(Math.round(z * 100) / 100 - z)).toBeLessThan(1e-6); // float32
    }
  });

  it("muestra que conserva los extremos cuando hay más de MAX_POINTS puntos", () => {
    const n = 90;
    const coords: number[] = [];
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) coords.push(i * 0.05, j * 0.05, ((i * 7 + j * 3) % 11) * 0.1);
    coords.push(2.2, 2.2, 9.99); // el más alto
    const verts = new Float64Array(coords);
    const faces = new Uint32Array(Array.from({ length: (DENSE_MESH + 1) * 3 }, () => 0)); // malla densa: sin muestras de aristas
    const { points, sampled } = elementPoints(verts, faces);
    expect(sampled).toBe(true);
    expect(points.length / 3).toBeLessThanOrEqual(MAX_POINTS);
    let zMax = -Infinity, xMax = -Infinity, yMin = Infinity;
    for (let k = 0; k < points.length; k += 3) {
      zMax = Math.max(zMax, points[k + 2]);
      xMax = Math.max(xMax, points[k]);
      yMin = Math.min(yMin, points[k + 1]);
    }
    expect(zMax).toBeCloseTo(9.99, 5);
    expect(xMax).toBeCloseTo(4.45, 5);
    expect(yMin).toBe(0);
  });
});

describe("elementFootprint", () => {
  it("en un sólido cerrado usa solo las caras que miran hacia arriba", () => {
    const { verts, faces } = box(3, 2, 0.5);
    const footprint = elementFootprint(verts, faces, true);
    expect(footprint?.type).toBe("Polygon");
    expect(area(footprint)).toBeCloseTo(6, 6);
    expect((footprint as { coordinates: number[][][] }).coordinates[0]).toHaveLength(5); // sin vértices colineales
  });

  it("une triángulos solapados y descarta los degenerados", () => {
    const verts = new Float64Array([0, 0, 0, 2, 0, 0, 2, 2, 0, 0, 2, 0, 1, 1, 0, 3, 1, 0, 3, 3, 0, 5, 5, 0, 5, 5, 0]);
    // dos triángulos del cuadrado [0,2]², uno solapado hacia (3,3) y uno degenerado.
    const faces = new Uint32Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 7, 8, 8]);
    const footprint = elementFootprint(verts, faces, true);
    expect(footprint?.type).toBe("Polygon");
    expect(area(footprint)).toBeCloseTo(4 + 2 - 0.5, 6);
  });

  it("usa la envolvente convexa en elementos no estructurales con malla detallada", () => {
    const n = 400;
    const coords: number[] = [];
    const faces: number[] = [];
    for (let i = 0; i < n; i++) {
      const t = (2 * Math.PI * i) / n;
      coords.push(Math.cos(t), Math.sin(t), 0, 0, 0, 1, Math.cos(t + 0.01), Math.sin(t + 0.01), 0);
      faces.push(3 * i, 3 * i + 1, 3 * i + 2);
    }
    const footprint = elementFootprint(new Float64Array(coords), new Uint32Array(faces), false);
    expect(footprint?.type).toBe("Polygon");
    expect(area(footprint)).toBeCloseTo(Math.PI, 2);
  });

  it("sin triángulos no hay huella", () => {
    expect(elementFootprint(new Float64Array([0, 0, 0]), new Uint32Array(0), true)).toBeNull();
  });
});

describe("huecos de muro sin relleno", () => {
  const ifc = CASES[0].ifc;
  it.skipIf(!existsSync(ifc))("un IfcOpeningElement sin IfcRelFillsElement entra como vano, sin huella y con el piso del muro", async () => {
    // Se quita la relación de relleno de la puerta (#130) para que el hueco #117 del muro sur quede vacío.
    const text = readFileSync(ifc, "latin1")
      .split(/\r?\n/)
      .filter((line) => !line.startsWith("#130=IFCRELFILLSELEMENT"))
      .join("\n");
    const api = await openApi();
    try {
      const modelID = api.OpenModel(new TextEncoder().encode(text), { COORDINATE_TO_ORIGIN: false });
      const geometry = extraer(api, modelID, "bnc", lengthScaleOf(api, modelID), () => {});
      api.CloseModel(modelID);
      const opening = geometry.elements.find((e) => e.ifcClass === "IfcOpeningElement");
      expect(opening).toBeDefined();
      expect(opening!.expressId).toBe(117);
      expect(opening!.footprint).toBeNull();
      expect(opening!.storeyName).toBe("Nivel 1");
      expect(opening!.storeyElevation).toBe(0);
      const wall = geometry.elements.find((e) => e.expressId === 63)!;
      expect(opening!.xMin).toBeGreaterThanOrEqual(wall.xMin);
      expect(opening!.xMax).toBeLessThanOrEqual(wall.xMax);
      expect(opening!.zMax).toBeLessThanOrEqual(wall.zMax);
      expect(opening!.zMax - opening!.zMin).toBeGreaterThan(1.5);
      // La puerta sigue estando: los rellenos ya son elementos propios.
      expect(geometry.elements.some((e) => e.expressId === 129)).toBe(true);
    } finally {
      api.Dispose();
    }
  });
});

describe.each(CASES)("$name contra el motor Python", ({ ifc, fixture, modelId }) => {
  const missing = [ifc, fixture].filter((f) => !existsSync(f));
  const reason = missing.length ? ` (omitida: falta ${missing.join(", ")})` : "";
  let api: WebIFC.IfcAPI | null = null;
  let actual: ModelGeometry | null = null;
  let expected: Fixture | null = null;
  const byId = new Map<number, ElementGeometry>();

  beforeAll(async () => {
    if (missing.length) return;
    api = await openApi();
    actual = extractFile(api, ifc, modelId);
    expected = JSON.parse(readFileSync(fixture, "utf8")) as Fixture;
    for (const e of actual.elements) byId.set(e.expressId, e);
  });

  afterAll(() => {
    api?.Dispose();
  });

  it.skipIf(missing.length > 0)(`mismo conjunto de elementos${reason}`, () => {
    expect(actual!.modelId).toBe(modelId);
    const got = actual!.elements.map((e) => e.expressId).sort((a, b) => a - b);
    const want = expected!.elements.map((e) => e.expressId).sort((a, b) => a - b);
    expect(got).toEqual(want);
    for (const ref of expected!.elements) {
      const e = byId.get(ref.expressId)!;
      expect(e.ifcClass, `clase de #${ref.expressId}`).toBe(ref.ifcClass);
      expect(e.globalId, `GlobalId de #${ref.expressId}`).toBe(ref.globalId);
      expect(e.name, `nombre de #${ref.expressId}`).toBe(ref.name);
    }
  });

  it.skipIf(missing.length > 0)(`caja y zMax a menos de 1 cm${reason}`, () => {
    let worst = 0;
    for (const ref of expected!.elements) {
      const e = byId.get(ref.expressId)!;
      for (const k of ["xMin", "xMax", "yMin", "yMax", "zMin", "zMax"] as const) {
        const diff = Math.abs(e[k] - ref[k]);
        worst = Math.max(worst, diff);
        expect(diff, `${k} de #${ref.expressId} (${ref.name}): web ${e[k]} vs python ${ref[k]}`).toBeLessThan(0.01);
      }
      expect(Math.abs(e.zMax - ref.zMax), `zMax de #${ref.expressId}`).toBeLessThanOrEqual(0.01);
      expect(e.points.length, `puntos de #${ref.expressId}`).toBeGreaterThan(0);
    }
    console.info(`${modelId}: ${expected!.elements.length} elementos, mayor diferencia de caja ${(worst * 1000).toFixed(2)} mm`);
  });

  it.skipIf(missing.length > 0)(`área de la huella a menos de 0,5 %${reason}`, () => {
    let worst = 0;
    for (const ref of expected!.elements) {
      const e = byId.get(ref.expressId)!;
      if (ref.footprint === null) {
        expect(e.footprint, `huella de #${ref.expressId} debería ser null`).toBeNull();
        continue;
      }
      expect(e.footprint, `huella de #${ref.expressId} (${ref.ifcClass} ${ref.name})`).not.toBeNull();
      const want = area(ref.footprint);
      const got = area(e.footprint);
      const rel = want > 0 ? Math.abs(got - want) / want : Math.abs(got - want);
      worst = Math.max(worst, rel);
      expect(rel, `área de #${ref.expressId} (${ref.name}): web ${got.toFixed(4)} vs python ${want.toFixed(4)}`).toBeLessThan(0.005);
    }
    console.info(`${modelId}: mayor diferencia de área ${(worst * 100).toFixed(3)} %`);
  });

  it.skipIf(missing.length > 0)(`mismo piso${reason}`, () => {
    for (const ref of expected!.elements) {
      const e = byId.get(ref.expressId)!;
      expect(e.storeyName, `piso de #${ref.expressId}`).toBe(ref.storeyName);
      if (ref.storeyElevation === null) expect(e.storeyElevation).toBeNull();
      else expect(e.storeyElevation, `cota del piso de #${ref.expressId}`).toBeCloseTo(ref.storeyElevation, 6);
    }
  });
});
