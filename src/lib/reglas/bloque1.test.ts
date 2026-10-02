// Porte de RulesBlock1Tests.cs: zonas múltiples (art. 2.1.21), agrupamiento (R-10), muro de adosamiento (R-04), cuerpos salientes
// sobre el antejardín (Art. 6º de la Ordenanza Local, R-05), superficie predial mínima (R-09) y afectaciones (R-11).
// Predio de prueba: 20 × 20 m con frente al sur (calle de 10 m) salvo que se indique otra cosa; cifras de ZU-1A y ZU-5A de La Serena.
import { describe, expect, it } from "vitest";
import { evaluarReglas } from "./motor";
import { fireRatingKey, type Polygon2D, type PublicUseArea, type RuleInput, type RuleResult, type RuleState, type ZonePart } from "./tipos";
import { box, cargarNormasDePrueba, denseBoxes, entrada, porId, rectLot, type BoxSpec } from "./__fixtures__/sinteticos";

const norms = cargarNormasDePrueba("la-serena");

const rect = (x0: number, y0: number, x1: number, y1: number): Polygon2D => ({
  type: "Polygon",
  coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]],
});

function input(boxes: BoxSpec[], options: { width?: number; depth?: number; zone?: string; zones?: ZonePart[] } = {}): RuleInput {
  const { width = 20, depth = 20, zone = "ZU-1A", zones } = options;
  // Anillo antihorario desde (0,0): sur (frente, calle de 10 m), oriente, norte, poniente.
  return entrada([denseBoxes("m", boxes)], { lotRing: rectLot(width, depth), zoneCode: zone, zoneParts: zones ?? null });
}

const evaluate = (i: RuleInput): Map<string, RuleResult> => porId(evaluarReglas(norms, i).results);

const get = (results: Map<string, RuleResult>, id: string): RuleResult => results.get(id)!;

describe("Art. 2.1.21: predio en dos zonas", () => {
  it("cada zona conserva su altura y los coeficientes se promedian por superficie", () => {
    // Predio 40 × 20 m: mitad poniente en ZU-1A (13 m, 0,8, 2), mitad oriente en ZU-5A (9 m, 0,3, 0,4).
    const r = evaluate(
      input([box(1, "IfcBuildingElementProxy", 5, 15, 8, 14, 0, 12), box(2, "IfcBuildingElementProxy", 25, 35, 8, 14, 0, 10)], {
        width: 40,
        zones: [{ code: "ZU-1A", area: rect(0, 0, 20, 20) }, { code: "ZU-5A", area: rect(20, 0, 40, 20) }],
      }),
    );

    expect(get(r, "R-01").state).toBe("NoCumple"); // 10 m en ZU-5A (máximo 9 m); 12 m en ZU-1A cumple
    expect(get(r, "R-01").elements).toHaveLength(1);
    const finding = get(r, "R-01").elements[0];
    expect(finding.expressId).toBe(2);
    expect(finding.value).toBeCloseTo(1.0, 3);
    expect(finding.detail).toContain("ZU-5A");
    expect(get(r, "R-01").sources.some((s) => s.article === "Art. 2.1.21")).toBe(true);

    expect(get(r, "R-06").state).toBe("Cumple"); // 120 / 800 = 0,15 bajo (0,8·400 + 0,3·400) / 800 = 0,55
    expect(get(r, "R-06").required).toBe("0,55");
    expect(get(r, "R-06").notes.some((n) => n.includes("promediado"))).toBe(true);
    expect(get(r, "R-07").required).toBe("1,2"); // (2·400 + 0,4·400) / 800
  });
});

describe("R-10 Sistema de agrupamiento", () => {
  it("un cuerpo en un deslinde lateral es pareado y queda exento de los distanciamientos de ese deslinde", () => {
    // Volumen de 7 m apoyado en el deslinde poniente (lateral: toca el frente sur).
    const r = evaluate(input([box(1, "IfcBuildingElementProxy", 0, 10, 3, 13, 0, 7)]));

    expect(get(r, "R-10").state).toBe("RevisionRequerida"); // ZU-1A admite pareado; falta el pareo simultáneo
    expect(get(r, "R-10").summary).toContain("pareada");
    expect(get(r, "R-10").sources.some((s) => s.quote.includes("forma simultánea"))).toBe(true);
    expect(get(r, "R-03").state).toBe("Cumple"); // el cuerpo pareado no se mide contra su deslinde
    expect(get(r, "R-02").state).toBe("Cumple");
    expect(get(r, "R-03").notes.some((n) => n.includes("pareado"))).toBe(true);
  });

  it("un cuerpo en ambos deslindes laterales es continuo y se rechaza donde la zona no lo admite", () => {
    const b = box(1, "IfcBuildingElementProxy", 0, 20, 5, 15, 0, 7);
    const inZu1A = evaluate(input([b]));
    const inZu5A = evaluate(input([b], { zone: "ZU-5A" }));

    expect(get(inZu1A, "R-10").state).toBe("RevisionRequerida"); // ZU-1A: aislado, pareado, continuo
    expect(get(inZu1A, "R-10").summary).toContain("continua");
    expect(get(inZu5A, "R-10").state).toBe("NoCumple"); // ZU-5A: aislado, pareado
  });

  it("un cuerpo solo en el deslinde posterior no se clasifica", () => {
    const r = evaluate(input([box(1, "IfcBuildingElementProxy", 5, 15, 10, 20, 0, 7)]));

    expect(get(r, "R-10").state).toBe("RevisionRequerida");
    expect(get(r, "R-10").summary).toContain("no corresponde claramente");
    expect(get(r, "R-03").state).toBe("NoCumple"); // sin clasificación no hay exención
  });

  it("una edificación separada de los deslindes es aislada", () => {
    const r = evaluate(input([box(1, "IfcBuildingElementProxy", 5, 15, 5, 15, 0, 7)]));

    expect(get(r, "R-10").state).toBe("Cumple");
    expect(get(r, "R-10").summary).toContain("aislada");
  });
});

describe("R-04 Muro de adosamiento", () => {
  it.each<[number, string | null, RuleState, string]>([
    [2.2, "F-60", "RevisionRequerida", "aguas lluvia"],
    [2.2, "EI 120", "RevisionRequerida", "aguas lluvia"],
    [2.2, null, "RevisionRequerida", "resistencia al fuego"],
    [2.2, "F-30", "NoCumple", "bajo F-60"],
    [1.5, "F-60", "NoCumple", "muro"],
  ])("muro de %s m con resistencia %s → %s (%s)", (wallHeight, fireRating, expected, text) => {
    // Cuerpo de 3 m a 1 m del vecino poniente (adosamiento de 6 m de 20 m = 30 %) y muro en el deslinde.
    const fire = fireRating === null ? null : { [fireRatingKey("m", 2)]: fireRating };
    const i = { ...input([box(1, "IfcBuildingElementProxy", 1, 9, 5, 11, 0, 3), box(2, "IfcWall", 0, 0.15, 5, 11, 0, wallHeight)]), fireRatings: fire };
    const r = get(evaluate(i), "R-04");

    expect(r.state).toBe(expected);
    expect(r.summary + " " + r.notes.join(" ")).toContain(text);
    expect(r.sources.some((s) => s.quote.includes("aguas lluvia"))).toBe(true);
  });

  it("el adosamiento sin muro en el deslinde no cumple", () => {
    const r = get(evaluate(input([box(1, "IfcBuildingElementProxy", 1, 9, 5, 11, 0, 3)])), "R-04");

    expect(r.state).toBe("NoCumple");
    expect(r.summary).toContain("no hay muro en el deslinde");
  });
});

describe("R-05 Cuerpos salientes sobre el antejardín (Art. 6º)", () => {
  const house = (...extra: BoxSpec[]): BoxSpec[] => [
    box(1, "IfcBuildingElementProxy", 5, 15, 3, 13, 0, 2.7),
    box(2, "IfcBuildingElementProxy", 5, 15, 3, 13, 2.7, 5.4, "Piso 2"),
    ...extra,
  ];

  it("admite el cuerpo saliente del 1° piso y el balcón superior dentro de 1,20 m", () => {
    const r = get(
      evaluate(
        input(
          house(
            box(10, "IfcBuildingElementProxy", 8, 10, 2, 3, 0.6, 2.4), // 1° piso: 1 m, a 0,6 m del suelo, 2 m de 10 m de fachada
            box(11, "IfcSlab", 6, 9, 1.8, 3, 2.8, 3.0, "Piso 2"), // balcón de 1,2 m
          ),
        ),
      ),
      "R-05",
    );

    expect(r.state).toBe("Cumple");
    expect(r.elements).toHaveLength(2);
    expect(r.sources.some((s) => s.article === "Artículo 6º a)")).toBe(true);
  });

  it.each<[number, number, number, number, string]>([
    [2.0, 0.2, 8, 10, "a 0,2 m del suelo"], // bajo 0,50 m del nivel del antejardín
    [1.5, 0.6, 8, 10, "entra 1,5 m"], // más de 1,20 m
    [2.0, 0.6, 5, 13, "2/3"], // 8 m de 10 m de fachada
  ])("un saliente del 1° piso fuera del Art. 6º no cumple (y0 %s, base %s, x %s–%s: %s)", (y0, bottom, x0, x1, text) => {
    const r = get(evaluate(input(house(box(10, "IfcBuildingElementProxy", x0, x1, y0, 3, bottom, 2.4)))), "R-05");

    expect(r.state).toBe("NoCumple");
    expect(r.elements.some((e) => e.expressId === 10 && e.detail.includes(text))).toBe(true);
  });

  it("un saliente cerrado en un piso superior requiere revisión", () => {
    const r = get(evaluate(input(house(box(10, "IfcWall", 6, 9, 2, 3, 2.7, 5.4, "Piso 2")))), "R-05");

    expect(r.state).toBe("RevisionRequerida");
    expect(r.elements.some((e) => e.expressId === 10 && e.detail.includes("solo balcones"))).toBe(true);
  });
});

describe("R-09 Superficie predial mínima", () => {
  it("solo rige al subdividir", () => {
    const boxes = [box(1, "IfcBuildingElementProxy", 5, 8, 5, 8, 0, 3)];
    const building = get(evaluate(input(boxes, { width: 10, depth: 15 })), "R-09");
    const subdivision = get(evaluate({ ...input(boxes, { width: 10, depth: 15 }), isSubdivision: true }), "R-09");

    expect(building.state).toBe("NoAplica"); // 150 m² bajo los 200 m² de subdivisión de ZU-1A
    expect(building.notes.some((n) => n.includes("menor"))).toBe(true);
    expect(subdivision.state).toBe("NoCumple");
  });
});

describe("R-11 Afectaciones de utilidad pública", () => {
  it("un parque sobre el predio y una faja vial que lo cruza requieren revisión", () => {
    const park: PublicUseArea = { kind: "parque comunal", name: "PC1", geometry: rect(15, 0, 25, 20) };
    const road: PublicUseArea = { kind: "apertura", name: "faja vial", geometry: { type: "LineString", coordinates: [[-5, 10], [25, 10]] } };
    const none = get(evaluate({ ...input([box(1, "IfcBuildingElementProxy", 5, 10, 5, 10, 0, 3)]), publicUse: [] }), "R-11");
    const r = get(evaluate({ ...input([box(1, "IfcBuildingElementProxy", 12, 18, 5, 10, 0, 3)]), publicUse: [park, road] }), "R-11");

    expect(none.state).toBe("NoAplica");
    expect(r.state).toBe("RevisionRequerida");
    expect(r.summary).toContain("100 m²"); // 5 × 20 m del parque dentro del predio
    expect(r.summary).toContain("cruza el predio");
    expect(r.elements).toHaveLength(1);
    expect(r.elements[0].expressId).toBe(1);
  });
});
