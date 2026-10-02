// Cabida preliminar de departamentos con la ficha ZU-1A de La Serena (ocupación 0,8, constructibilidad 2, altura 13 m,
// antejardín 3 m; rasante 70° en Coquimbo) sobre el predio de referencia de 12 × 17 m (204 m²).
import { describe, expect, it } from "vitest";
import { AJUSTES_CABIDA, DATO_FALTANTE, cabidaPreliminar, datosDeEntrada, prepararEntradaCabida, type AjustesCabida, type ContextoCabida } from "./cabidaPreliminar";
import { evaluarCabida } from "./cabida";
import type { CabidaPreliminar, ItemCabida, RuleInput } from "./tipos";
import { cargarNormasDePrueba, frente, rectLot, vecino } from "./__fixtures__/sinteticos";

const norms = cargarNormasDePrueba("la-serena");

const contexto = (zona: string | null = "ZU-1A", superficie = 204): ContextoCabida => ({
  norms,
  zona: norms.zone(zona),
  zonaCodigo: zona,
  region: "Coquimbo",
  superficiePredio: superficie,
  notas: [],
});

const ajustes = (cambios: Partial<AjustesCabida> = {}): AjustesCabida => ({ ...AJUSTES_CABIDA, ...cambios });

function calcular(cambios: Partial<AjustesCabida> = {}, ctx = contexto(), volumen: Parameters<typeof prepararEntradaCabida>[3] = null): CabidaPreliminar {
  const { entrada, errores } = prepararEntradaCabida(ctx, ajustes(cambios), "2,7", volumen);
  expect(errores).toEqual([]);
  return cabidaPreliminar(entrada!);
}

const item = (c: CabidaPreliminar, id: string): ItemCabida => c.items.find((i) => i.id === id)!;

describe("Cabida preliminar de departamentos", () => {
  it("calcula los seis puntos con las cifras de la ficha y su desarrollo", () => {
    const c = calcular({ razonEstacionamientos: "1", densidad: { origen: "Libre", valor: "" } });

    expect(c.items.map((i) => i.id)).toEqual(["CP-01", "CP-02", "CP-03", "CP-04", "CP-05", "CP-06"]);
    expect(c.construible).toBeCloseTo(408, 6); // 204 × 2
    expect(c.ocupacion).toBeCloseTo(163.2, 6); // 204 × 0,8
    expect(c.util).toBeCloseTo(346.8, 6); // 408 × (1 − 15 %)
    expect(c.departamentos).toBe(6); // ⌊346,8 ÷ 55⌋
    expect(c.tope).toBe("superficie");
    expect(c.numeroPisos).toBe(3); // mín(⌊13 ÷ 2,7⌋ = 4, ⌈408 ÷ 163,2⌉ = 3)
    expect(c.pisos.map((p) => Math.round(p.superficie * 10) / 10)).toEqual([163.2, 163.2, 81.6]);
    expect(c.pisos.reduce((s, p) => s + p.departamentos, 0)).toBe(6);
    for (const p of c.pisos) expect(p.mezcla.reduce((s, m) => s + m, 0)).toBe(p.departamentos);
    expect(c.estacionamientos).toBe(6); // ⌈6 × 1⌉
    expect(c.superficieEstacionamientos).toBe(150); // 6 × 25 m²
    for (const i of c.items) expect(i.estado).not.toBe("Cumple");

    const cp01 = item(c, "CP-01");
    expect(cp01.estado).toBe("Informativo");
    expect(cp01.desarrollo[0].formula).toBe("Superficie construible = superficie del predio × coeficiente de constructibilidad");
    expect(cp01.desarrollo[0].sustitucion).toBe("= 204 m² × 2");
    expect(cp01.desarrollo[0].resultado).toBeCloseTo(408, 6);
    expect(cp01.fuentes[0].quote).toBe("Coeficiente de constructibilidad 2");
    expect(cp01.fuentes.some((s) => s.article === "Art. 1.1.2")).toBe(true);
    expect(item(c, "CP-03").desarrollo[0].supuestos[0]).toContain("15 %");
    expect(item(c, "CP-05").desarrollo.map((p) => p.resultado)).toEqual([4, 3, 3]);
    expect(item(c, "CP-05").desarrollo[0].sustitucion).toBe("= ⌊13 m ÷ 2,7 m⌋ = ⌊4,81⌋");
    expect(item(c, "CP-06").desarrollo[1].sustitucion).toBe("= 6 × 25 m²");
  });

  it("la densidad limita los departamentos y se indica que manda", () => {
    // 400 hab/ha × 0,0204 ha ÷ 4 hab/viv = 2,04 → 2 departamentos (bajo los 6 por superficie útil).
    const c = calcular({ densidad: { origen: "CIP", valor: "400" } });

    expect(c.departamentos).toBe(2);
    expect(c.tope).toBe("densidad");
    const cp04 = item(c, "CP-04");
    expect(cp04.resumen).toContain("manda la densidad máxima");
    const densidad = cp04.desarrollo.find((p) => p.concepto === "Tope por densidad")!;
    expect(densidad.sustitucion).toBe("= ⌊400 hab/ha × 0,0204 ha ÷ 4 hab/viv⌋ = ⌊2,04⌋");
    expect(densidad.fuentes[0].document).toContain("CIP");
    expect(densidad.supuestos[0]).toContain("4 habitantes por vivienda");
    expect(c.pisos.reduce((s, p) => s + p.departamentos, 0)).toBe(2);
  });

  it("el volumen teórico de la cabida 3D limita pisos y departamentos", () => {
    const lot: RuleInput = {
      lotRing: rectLot(12, 17),
      edges: [frente(10), vecino(), vecino(), vecino()],
      groundZ: 0,
      groundConfirmed: false,
      positionConfirmed: true,
      zoneCode: "ZU-1A",
      region: "Coquimbo",
      isExtension: false,
      models: [],
    };
    const study = evaluarCabida(norms, lot, 2.7); // plantas de 112,5 / 80,5 / 40 / 40 m²
    const c = calcular({ densidad: { origen: "Libre", valor: "" } }, contexto(), study.floors);

    expect(c.numeroPisos).toBe(4);
    expect(c.pisos.map((p) => p.superficie)).toEqual([112.5, 80.5, 40, 40]);
    expect(c.departamentos).toBe(4); // ⌊273 × 0,85 ÷ 55⌋ = ⌊4,22⌋
    expect(c.tope).toBe("volumen");
    expect(item(c, "CP-05").notas.some((n) => n.includes("El volumen teórico limita: caben 273 m² de los 408 m²"))).toBe(true);
  });

  it("sin ficha de zona ni CIP los resultados quedan en revisión con «dato faltante»", () => {
    const c = calcular({}, contexto(null));

    for (const id of ["CP-01", "CP-02", "CP-03", "CP-04", "CP-05", "CP-06"]) expect(item(c, id).estado).toBe("RevisionRequerida");
    expect(c.construible).toBeNull();
    expect(c.departamentos).toBeNull();
    expect(item(c, "CP-01").notas[0]).toBe(`Coeficiente de constructibilidad: ${DATO_FALTANTE}.`);
    expect(item(c, "CP-01").desarrollo[0].sustitucion).toContain(DATO_FALTANTE);
    expect(c.restricciones.find((r) => r.id === "CR-03")!.texto).toContain(DATO_FALTANTE);
    expect(c.restricciones.find((r) => r.id === "CR-04")!.estado).toBe("RevisionRequerida");
    expect(datosDeEntrada(c.entrada).find((d) => d.label === "Coeficiente de constructibilidad")!.origen).toBe("Faltante");
  });

  it("sin densidad ni razón de estacionamientos: se calcula lo demás y se pide el dato del CIP", () => {
    const c = calcular();

    expect(c.departamentos).toBe(6);
    expect(item(c, "CP-04").estado).toBe("RevisionRequerida");
    expect(item(c, "CP-04").notas).toContain(`Densidad máxima: ${DATO_FALTANTE}.`);
    expect(item(c, "CP-06").estado).toBe("RevisionRequerida");
    expect(c.estacionamientos).toBeNull();
    expect(item(c, "CP-06").resumen).toContain(DATO_FALTANTE);
  });

  it("los coeficientes del CIP sustituyen a los de la ficha y quedan citados como CIP", () => {
    const c = calcular({ constructibilidad: { origen: "CIP", valor: "1,5" }, densidad: { origen: "Libre", valor: "" } });

    expect(c.construible).toBeCloseTo(306, 6);
    expect(c.entrada.constructibilidad.origen).toBe("CIP");
    expect(item(c, "CP-01").fuentes[0].document).toBe("Certificado de Informaciones Previas (CIP)");
    expect(item(c, "CP-01").notas.some((n) => n.includes("indicado desde el CIP"))).toBe(true);
    expect(c.entrada.ocupacion.origen).toBe("PRC");
  });

  it("restricciones con cita: rasante de la región, distanciamientos, adosamiento y antejardín de la ficha", () => {
    const c = calcular({ densidad: { origen: "Libre", valor: "" } });
    const [rasante, distancias, antejardin] = c.restricciones;

    expect(c.restricciones.map((r) => r.id)).toEqual(["CR-01", "CR-02", "CR-03", "CR-04", "CR-05"]);
    expect(rasante.texto).toContain("70°");
    expect(rasante.fuentes[0].article).toBe("Art. 2.6.3");
    expect(distancias.texto).toContain("Con 3 pisos (8,1 m): 4 m con vano");
    expect(distancias.fuentes.map((s) => s.article)).toContain("Art. 2.6.2 N° 1");
    expect(antejardin.texto).toContain("Antejardín de 3 m");
    expect(antejardin.fuentes[0].quote).toBe("Antejardín 3 m");
  });

  it("el desarrollo se serializa sin perder datos (JSON del informe)", () => {
    const c = calcular({ razonEstacionamientos: "1,5", densidad: { origen: "CIP", valor: "800" } });
    const copia = JSON.parse(JSON.stringify(c)) as CabidaPreliminar;

    expect(copia).toEqual(c);
    expect(copia.items[3].desarrollo.at(-1)!.sustitucion).toMatch(/^= mín\(/);
    expect(copia.estacionamientos).toBe(Math.ceil(c.departamentos! * 1.5));
  });

  it("informa los errores de entrada en vez de inventar valores", () => {
    const { entrada, errores } = prepararEntradaCabida(contexto(), ajustes({ mezcla: ["30", "30", "30"], m2Departamento: "0" }), "2,7", null);

    expect(entrada).toBeNull();
    expect(errores.some((e) => e.includes("m² útiles promedio"))).toBe(true);
    expect(errores.some((e) => e.includes("debe sumar 100 %"))).toBe(true);
  });
});
