// Porte de GeometricRulesTests.cs: SRS-NOR-001, CA-03, el proyecto hipotético (casa de 8 × 11 m en un predio FICTICIO de 12 × 17 m,
// zona ZU-1A) y el hueco en muro sin ventana.
import { describe, expect, it } from "vitest";
import { evaluarReglas } from "./motor";
import { box, cargarNormasDePrueba, casaHipotetica, cornerBoxes, entrada, fixtureDisponible, frente, porId, rectLot, vecino } from "./__fixtures__/sinteticos";

describe("Catálogo de normas", () => {
  it("lee las cifras verificadas de la OGUC y de La Serena", () => {
    const norms = cargarNormasDePrueba("la-serena");

    expect(norms.rasanteAngle("Coquimbo")).toBe(70);
    expect(norms.rasanteAngle("Atacama")).toBe(80);
    expect(norms.requiredSetback(3.5, false)).toBe(1.4);
    expect(norms.requiredSetback(3.6, false)).toBe(2.5);
    expect(norms.requiredSetback(7.0, true)).toBe(3.0);
    expect(norms.requiredSetback(7.1, false)).toBe(4.0);
    expect(norms.adosamientoLengthPercent).toBe(40);
    expect(norms.adosamientoHeight).toBe(3.5);
    const zone = norms.zone("ZU-1A");
    expect(zone).not.toBeNull();
    expect([zone!.maxHeight, zone!.frontYard, zone!.landCoverage, zone!.floorAreaRatio, zone!.page]).toEqual([13.0, 3.0, 0.8, 2.0, 13]);
    expect(zone!.grouping).toContain("aislado");
    expect(norms.zoneSource(zone!, zone!.landCoverageText!).quote).toContain("Coeficiente de ocupación de suelo 0,8");
  });
});

describe("Proyecto hipotético (CA-03)", () => {
  const skip = !fixtureDisponible();
  const motivo = "Falta el fixture src/lib/reglas/__fixtures__/casa_hipotetica.geom.json (geometría extraída del IFC).";

  it.skipIf(skip)(`da los resultados esperados por el SRS${skip ? ` (${motivo})` : ""}`, () => {
    const geometry = casaHipotetica();
    const norms = cargarNormasDePrueba("la-serena");
    // Predio en coordenadas del modelo: el origen es la esquina poniente del frente (ver samples/proyecto_hipotetico/generar.py).
    const input = entrada([geometry], { lotRing: rectLot(12, 17), edges: [frente(10), vecino(), vecino(), vecino()] });

    const evaluation = evaluarReglas(norms, input);
    const byId = porId(evaluation.results);

    expect(evaluation.lotArea).toBeCloseTo(204, 3);
    expect(byId.get("R-01")!.state).toBe("Cumple");
    expect(byId.get("R-02")!.state).toBe("NoCumple");
    const rasante = Math.max(...byId.get("R-02")!.elements.map((e) => e.value));
    expect(Math.abs(rasante - (5.6 - 2 * Math.tan((70 * Math.PI) / 180)))).toBeLessThanOrEqual(0.005); // 0,105 m
    expect(byId.get("R-03")!.state).toBe("NoCumple");
    expect(Math.abs(Math.max(...byId.get("R-03")!.elements.map((e) => e.value)) - 0.5)).toBeLessThanOrEqual(0.005); // 2,5 − 2,0
    expect(byId.get("R-04")!.state).toBe("NoCumple"); // 11 m de 17 m = 64,7 %
    expect(byId.get("R-04")!.measured).toContain("64,71 %");
    expect(byId.get("R-05")!.state).toBe("Cumple");
    expect(byId.get("R-06")!.state).toBe("Cumple");
    expect(byId.get("R-06")!.measured!.startsWith("0,43")).toBe(true); // 88 / 204
    expect(byId.get("R-07")!.state).toBe("Cumple");
    expect(byId.get("R-07")!.measured!.startsWith("0,86")).toBe(true); // 176 / 204
    expect(byId.get("R-08")!.state).toBe("Informativo");
    expect(evaluation.volume).not.toBeNull();
    expect(evaluation.volume!.volumeM3).toBeGreaterThan(0);
    // Celdas de 0,5 m a 1,4 m o más de los vecinos (distanciamiento sin vano) y fuera de los 3 m de antejardín: 9 m × 12,5 m.
    expect(evaluation.volume!.buildableArea).toBeCloseTo(112.5, 3);
    for (const r of evaluation.results.filter((r) => r.state !== "NoVerificable")) expect(r.sources.length).toBeGreaterThan(0); // CA-01
  });

  it.skipIf(skip)("sin suelo confirmado ninguna regla que dependa de él da «Cumple» (CA-09)", () => {
    const norms = cargarNormasDePrueba("la-serena");
    // Predio grande (40 × 40 m): nada excede, pero el suelo y la posición no están confirmados.
    const input = entrada([casaHipotetica()], {
      lotRing: [{ x: -14, y: -12 }, { x: 26, y: -12 }, { x: 26, y: 28 }, { x: -14, y: 28 }],
      groundConfirmed: false,
      positionConfirmed: false,
    });

    const results = porId(evaluarReglas(norms, input).results);

    for (const id of ["R-01", "R-02", "R-03", "R-05"]) expect(results.get(id)!.state).toBe("RevisionRequerida");
    expect(results.get("R-02")!.notes.some((n) => n.includes("suelo natural"))).toBe(true);
  });
});

describe("Hueco en muro", () => {
  it("cuenta como vano pero no como volumen construido", () => {
    // Predio 20 × 20 m en ZU-1A, frente al sur. Muro de 7 m de alto a 2,6 m del deslinde poniente: sin vano cumple (2,5 m).
    // Hueco sin ventana cerca de su coronación (6,2 a 7,0 m), sobresaliendo 0,1 m: con vano exige 3,0 m y queda a 2,5 m.
    const model = cornerBoxes("m", [box(1, "IfcWall", 2.6, 2.8, 8, 12, 0, 7.0), box(2, "IfcOpeningElement", 2.5, 2.9, 9, 10, 6.2, 7.0, "Piso 1", false)]);
    const norms = cargarNormasDePrueba("la-serena");

    const results = porId(evaluarReglas(norms, entrada([model])).results);

    expect(results.get("R-03")!.state).toBe("NoCumple");
    const findings = results.get("R-03")!.elements.filter((e) => e.ifcClass === "IfcOpeningElement");
    expect(findings).toHaveLength(1);
    expect(findings[0].value).toBeCloseTo(0.5, 3); // 3,0 − 2,5
    expect(findings[0].detail).toContain("hueco");
    // El hueco no es volumen: a 2,5 m la rasante permite 6,87 m y el hueco llega a 7,0 m, pero la rasante se mide al muro (7,14 m).
    expect(results.get("R-02")!.state).toBe("Cumple");
    expect(results.get("R-01")!.elements.some((e) => e.ifcClass === "IfcOpeningElement")).toBe(false);
  });
});
