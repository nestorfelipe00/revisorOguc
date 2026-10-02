// Porte de RasanteExamplesTests.cs: ejemplos de rasantes (OGUC art. 2.6.3) con geometría sintética, un volumen de 8 × 8 m frente a un
// solo deslinde que genera rasante. Los demás deslindes son frentes de más de 100 m entre líneas oficiales, que no generan rasante.
import { describe, expect, it } from "vitest";
import { evaluarReglas } from "./motor";
import { rasanteExcess, rasanteLimit, type BoundaryKind, type ParcelEdge, type RuleEvaluation } from "./tipos";
import { box, cargarNormasDePrueba, cornerBoxes, rectLot } from "./__fixtures__/sinteticos";

/** Predio de 30 × 30 m; el deslinde de prueba es el poniente (x = 0), salvo en los frentes, que es el sur (y = 0). */
function evaluate(region: string, kind: BoundaryKind, width: number | null, distance: number, height: number): RuleEvaluation {
  const front = kind === "Frente";
  const [x0, y0] = front ? [11.0, distance] : [distance, 11.0];
  const model = cornerBoxes("m", [box(1, "IfcBuildingElementProxy", x0, x0 + 8, y0, y0 + 8, 0, height)]);
  const wide: ParcelEdge = { kind: "Frente", officialLinesWidth: 150, label: null };
  const test: ParcelEdge = { kind, officialLinesWidth: width, label: null };
  // Anillo antihorario desde (0,0): sur, oriente, norte, poniente.
  const edges = front ? [test, wide, wide, wide] : [wide, wide, wide, test];
  return evaluarReglas(cargarNormasDePrueba("la-serena"), {
    lotRing: rectLot(30, 30),
    edges,
    groundZ: 0,
    groundConfirmed: true,
    positionConfirmed: true,
    zoneCode: null,
    region,
    isExtension: false,
    models: [model],
  });
}

describe("Ejemplos de rasantes", () => {
  // nombre, región, deslinde, ancho entre líneas oficiales, distancia al deslinde, altura, límite de la rasante, sobrepasa
  it.each<[string, string, BoundaryKind, number | null, number, number, number, boolean]>([
    ["E1 vecino, 4,5 m, 13 m", "Coquimbo", "Vecino", null, 4.5, 13, 12.364, true],
    ["E2 vecino, 5 m, 13 m", "Coquimbo", "Vecino", null, 5.0, 13, 13.737, false],
    ["E3 frente, calle de 10 m, antejardín 3 m", "Coquimbo", "Frente", 10, 3.0, 13, 21.979, false],
    ["E4 frente, pasaje de 4 m, antejardín 2 m", "Coquimbo", "Frente", 4, 2.0, 13, 10.99, true],
    ["E5 área verde, 4,5 m, 13 m", "Coquimbo", "AreaVerde", null, 4.5, 13, 12.364, true],
    ["E6 vecino en Atacama (80°)", "Atacama", "Vecino", null, 4.5, 13, 25.521, false],
    ["E7 vecino en Los Lagos (60°)", "Los Lagos", "Vecino", null, 4.5, 13, 7.794, true],
  ])("%s", (name, region, kind, width, distance, height, limit, exceeds) => {
    const evaluation = evaluate(region, kind, width, distance, height);
    const r02 = evaluation.results.find((r) => r.id === "R-02")!;

    expect(r02.state).toBe(exceeds ? "NoCumple" : "Cumple");
    expect(evaluation.rasantes!.sections).toHaveLength(1);
    const section = evaluation.rasantes!.sections[0];
    const fromLine = distance + (width ?? 0) / 2; // en un frente se mide desde el eje entre líneas oficiales
    expect(section.criticalS).toBeCloseTo(fromLine, 3);
    expect(section.criticalHeight).toBeCloseTo(height, 3);
    expect(rasanteLimit(section, evaluation.rasantes!.angle)).toBeCloseTo(limit, 2);
    expect(rasanteExcess(section, evaluation.rasantes!.angle) > 0.01).toBe(exceeds);
    if (exceeds) {
      expect(r02.elements).toHaveLength(1);
      expect(r02.elements[0].value).toBeCloseTo(height - limit, 2);
    }
    // El corte muestra el volumen desde su cara más cercana a la línea.
    expect(section.blocks).toHaveLength(1);
    expect(section.blocks[0].s0).toBeCloseTo(fromLine, 3);
    expect(section.blocks[0].top).toBeCloseTo(height, 3);
    expect(name.length).toBeGreaterThan(0);
  });

  it("un frente de más de 100 m no tiene rasante", () => {
    const evaluation = evaluate("Coquimbo", "Frente", 120, 2.0, 30);
    const r02 = evaluation.results.find((r) => r.id === "R-02")!;

    expect(r02.state).toBe("NoVerificable"); // no queda ninguna línea desde donde aplicar rasantes
    expect(evaluation.rasantes).toBeNull();
  });

  it("el adosamiento queda exento de rasantes", () => {
    // 3,5 m de alto a 1 m del vecino: la rasante permitiría 2,75 m, pero cabe en el adosamiento (3,5 m + 45°) y queda exento (art. 2.6.2).
    const evaluation = evaluate("Coquimbo", "Vecino", null, 1.0, 3.5);
    const r02 = evaluation.results.find((r) => r.id === "R-02")!;

    expect(r02.state).toBe("Cumple");
    expect(r02.notes.some((n) => n.includes("adosamiento"))).toBe(true);
    for (const s of evaluation.rasantes!.sections) expect(rasanteExcess(s, evaluation.rasantes!.angle)).toBeLessThan(0); // lo adosado no cuenta
  });
});
