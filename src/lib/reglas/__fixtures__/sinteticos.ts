// Utilidades de las pruebas: normas desde public/normas, geometría sintética (cajas) y el fixture del proyecto hipotético.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { NormCatalog } from "../normas";
import type { ElementGeometry, ModelGeometry, ParcelEdge, RuleInput, RuleResult } from "../tipos";

const normasRoot = new URL("../../../../public/normas/", import.meta.url);

export const leerJson = (ruta: string): unknown => JSON.parse(readFileSync(new URL(ruta, normasRoot), "utf8"));

/** NormCatalog.Load(data/normas, comuna) del escritorio, leyendo public/normas. */
export const cargarNormasDePrueba = (comuna: string | null = "la-serena"): NormCatalog =>
  new NormCatalog(leerJson("oguc/geometria.json"), comuna === null ? null : leerJson(`${comuna}/normas_zonas.json`));

export interface BoxSpec {
  id: number;
  cls: string;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  z0: number;
  z1: number;
  storey?: string;
  footprint?: boolean;
}

export const box = (id: number, cls: string, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, storey = "Piso 1", footprint = true): BoxSpec =>
  ({ id, cls, x0, x1, y0, y1, z0, z1, storey, footprint });

const rect = (x0: number, y0: number, x1: number, y1: number) => ({
  type: "Polygon" as const,
  coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]],
});

function element(b: BoxSpec, points: number[]): ElementGeometry {
  return {
    expressId: b.id,
    globalId: `G${b.id}`,
    ifcClass: b.cls,
    name: b.cls,
    storeyName: b.storey ?? "Piso 1",
    storeyElevation: 0,
    xMin: b.x0, xMax: b.x1, yMin: b.y0, yMax: b.y1, zMin: b.z0, zMax: b.z1,
    footprint: b.footprint === false ? null : rect(b.x0, b.y0, b.x1, b.y1),
    points: new Float32Array(points),
    sampled: false,
  };
}

/** GeometricRulesTests.WriteGeometry: cajas con sus 8 vértices como puntos. */
export function cornerBoxes(modelId: string, boxes: BoxSpec[]): ModelGeometry {
  return {
    modelId,
    elements: boxes.map((b) => {
      const points: number[] = [];
      for (const x of [b.x0, b.x1]) for (const y of [b.y0, b.y1]) for (const z of [b.z0, b.z1]) points.push(x, y, z);
      return element(b, points);
    }),
  };
}

/** RulesBlock1Tests.Write: vértices y puntos cada 1 m en las aristas horizontales, como el motor IFC. */
export function denseBoxes(modelId: string, boxes: BoxSpec[]): ModelGeometry {
  const steps = (a: number, b: number): number[] => {
    const values: number[] = [];
    for (let v = a; v < b; v += 1) values.push(v);
    values.push(b);
    return values;
  };
  return {
    modelId,
    elements: boxes.map((b) => {
      const points: number[] = [];
      for (const z of [b.z0, b.z1]) {
        for (const x of steps(b.x0, b.x1)) for (const y of [b.y0, b.y1]) points.push(x, y, z);
        for (const y of steps(b.y0, b.y1)) for (const x of [b.x0, b.x1]) points.push(x, y, z);
      }
      return element(b, points);
    }),
  };
}

export const frente = (ancho: number | null = 10): ParcelEdge => ({ kind: "Frente", officialLinesWidth: ancho, label: null });
export const vecino = (): ParcelEdge => ({ kind: "Vecino", officialLinesWidth: null, label: null });

/** Predio rectangular en el origen: anillo antihorario sur (frente), oriente, norte, poniente. */
export const rectLot = (width: number, depth: number) => [{ x: 0, y: 0 }, { x: width, y: 0 }, { x: width, y: depth }, { x: 0, y: depth }];

export function entrada(models: ModelGeometry[], extra: Partial<RuleInput> = {}): RuleInput {
  return {
    lotRing: rectLot(20, 20),
    edges: [frente(10), vecino(), vecino(), vecino()],
    groundZ: 0,
    groundConfirmed: true,
    positionConfirmed: true,
    zoneCode: "ZU-1A",
    region: "Coquimbo",
    isExtension: false,
    models,
    ...extra,
  };
}

export const porId = (results: RuleResult[]): Map<string, RuleResult> => new Map(results.map((r) => [r.id, r]));

export const fixtureUrl = new URL("./casa_hipotetica.geom.json", import.meta.url);

export const fixtureDisponible = (): boolean => existsSync(fileURLToPath(fixtureUrl));

/** Geometría del proyecto hipotético extraída del IFC (points como number[] en el JSON → Float32Array). */
export function casaHipotetica(): ModelGeometry {
  const raw = JSON.parse(readFileSync(fixtureUrl, "utf8")) as { modelId: string; elements: (Omit<ElementGeometry, "points"> & { points: number[] })[] };
  return { modelId: raw.modelId, elements: raw.elements.map((e) => ({ ...e, points: new Float32Array(e.points) })) };
}
