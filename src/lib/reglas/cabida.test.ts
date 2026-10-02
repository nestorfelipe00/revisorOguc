// Porte de CabidaStudyTests.cs: el volumen teórico (grilla de 0,5 m) se corta en pisos y se limita con la ocupación de suelo
// (primer piso) y la constructibilidad (total). Cifras de ZU-1A de La Serena: 13 m, 0,8, 2, antejardín 3 m; rasante 70°.
import { describe, expect, it } from "vitest";
import { evaluarCabida } from "./cabida";
import { edgeLength, orientation, parcelArea, rectangleParcel } from "./predio";
import type { RuleInput } from "./tipos";
import { cargarNormasDePrueba, frente, rectLot, vecino } from "./__fixtures__/sinteticos";

const norms = cargarNormasDePrueba("la-serena");

const lot = (width: number, depth: number): RuleInput => ({
  lotRing: rectLot(width, depth),
  edges: [frente(10), vecino(), vecino(), vecino()],
  groundZ: 0,
  groundConfirmed: false,
  positionConfirmed: true,
  zoneCode: "ZU-1A",
  region: "Coquimbo",
  isExtension: false,
  models: [],
});

describe("Estudio de cabida", () => {
  it("el predio hipotético queda limitado por el volumen teórico", () => {
    // Predio 12 × 17 m: planta a 1,4 m de los vecinos (1° piso), a 2,5 m (2°) y a 4 m (3° y 4°, bajo los 13 m y la rasante).
    const study = evaluarCabida(norms, lot(12, 17), 2.7);

    expect(study.floors.map((f) => Math.round(f.area * 100) / 100)).toEqual([112.5, 80.5, 40, 40]);
    expect(study.buildableArea).toBeCloseTo(273, 3); // bajo los 2 × 204 = 408 m² de constructibilidad
    const c02 = study.results.find((r) => r.id === "C-02")!;
    expect(c02.state).toBe("Informativo");
    expect(c02.notes.some((n) => n.includes("El volumen teórico limita la cabida"))).toBe(true);
    expect(study.results.map((r) => r.id)).toEqual(["C-01", "C-02", "R-08", "R-09", "R-11"]);
    for (const r of study.results.filter((r) => r.state !== "NoVerificable")) expect(r.sources.length).toBeGreaterThan(0);
  });

  it("un predio grande queda limitado por la ocupación de suelo y la constructibilidad", () => {
    const study = evaluarCabida(norms, lot(40, 40), 2.7);

    expect(study.floors[0].area).toBeCloseTo(1280, 3); // 0,8 × 1.600 m² (el volumen admite 1.313,5 m²)
    expect(study.floors[0].envelopeArea).toBeCloseTo(1313.5, 3);
    expect(study.buildableArea).toBeCloseTo(3200, 3); // 2 × 1.600 m²
    expect(study.results.find((r) => r.id === "C-02")!.notes.some((n) => n.includes("La constructibilidad limita la cabida"))).toBe(true);
  });

  it("avisa cuando el piso a piso es menor que la altura mínima de piso a cielo", () => {
    const c02 = evaluarCabida(norms, lot(12, 17), 2.2).results.find((r) => r.id === "C-02")!;

    expect(c02.notes.some((n) => n.includes("2,3 m"))).toBe(true);
    expect(c02.sources.some((s) => s.article === "Art. 4.1.1")).toBe(true);
  });
});

describe("Predio rectangular", () => {
  it.each<[number, string]>([
    [180, "Sur"],
    [90, "Oriente"],
    [0, "Norte"],
  ])("con rumbo %s° el frente mira al %s", (bearing, front) => {
    const { parcel } = rectangleParcel({ latitude: -29.9, longitude: -71.25 }, 12, 25, bearing);

    expect(parcelArea(parcel)).toBeCloseTo(300, 1);
    expect(edgeLength(parcel, 0)).toBeCloseTo(12, 2);
    expect(orientation(parcel, 0)).toBe(front);
    expect(parcel.edges[0].kind).toBe("Frente");
    for (const e of parcel.edges.slice(1)) expect(e.kind).toBe("Vecino");
  });

  it("sin rumbo el frente mira al sur", () => {
    const { parcel, orientation: text } = rectangleParcel({ latitude: -29.9, longitude: -71.25 }, 12, 25, null);

    expect(orientation(parcel, 0)).toBe("Sur");
    expect(text).toContain("sur");
    expect(parcel.source).toContain("12 × 25 m");
  });
});
