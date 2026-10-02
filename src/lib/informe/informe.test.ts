import { describe, expect, it } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import { ESQUEMA_INFORME, informeHtml, informeJson, nombreArchivoInforme, type Informe } from "./informe";
import { hojasInforme, informeExcel } from "./excel";

const informe: Informe = {
  kind: "Revisión normativa geométrica",
  generatedAt: "2026-10-02T15:04:00.000Z",
  appVersion: "web-w3",
  projectName: 'Casa <Los "Robles">',
  permit: "Permiso de edificación",
  project: [{ label: "Proyecto", value: "Casa <Los \"Robles\">" }],
  models: [{ fileName: "casa.ifc", discipline: "Arquitectura", condition: "Proyectado", sha256: "abc", elementCount: 11 }],
  territory: [{ label: "Territorio", value: "La Serena · ZU-1A" }],
  parcel: {
    areaM2: 450.5,
    source: "Dibujado",
    naturalGroundZ: 0,
    groundConfirmed: false,
    positionConfirmed: true,
    edges: [{ number: 1, orientation: "Norte", kind: "Frente", lengthM: 15, officialLinesWidthM: 12 }],
  },
  zone: "ZU-1A",
  status: "2 cumple · 1 no cumple",
  warnings: ["Suelo natural supuesto"],
  results: [
    {
      id: "R-01",
      title: "Altura máxima",
      state: "NoCumple",
      summary: "Excede en 1,2 m",
      required: "≤ 10,5 m",
      measured: "11,7 m",
      sources: [{ document: "Ordenanza Local", article: "Art. 12", quote: "altura máxima 10,5 m", page: 4, version: "2021", url: null }],
      elements: [{ modelId: "m1", expressId: 55, globalId: "G1", ifcClass: "IfcRoof", name: "Techo =1", value: 1.2, detail: "cumbrera a 11,7 m" }],
      notes: ["⚠ Supuesto: suelo natural"],
    },
    { id: "R-02", title: "Rasantes", state: "Cumple", summary: "Dentro", required: null, measured: null, sources: [], elements: [], notes: [] },
  ],
};

describe("informe", () => {
  it("JSON cumple bnc-report/1 con conteos y descargo", () => {
    const json = JSON.parse(informeJson(informe));
    expect(json.schema).toBe(ESQUEMA_INFORME);
    expect(json.counts.NoCumple).toBe(1);
    expect(json.counts.Cumple).toBe(1);
    expect(json.results).toHaveLength(2);
    expect(json.disclaimer).toContain("No reemplaza");
  });

  it("el HTML escapa el marcado y conserva tildes y comillas angulares", () => {
    const html = informeHtml(informe);
    expect(html).not.toContain("<Los");
    expect(html).toContain("&lt;Los &quot;Robles&quot;&gt;");
    expect(html).toContain("«altura máxima 10,5 m»");
    expect(html).toContain("Ordenanza Local, Art. 12, p. 4");
    expect(html).toContain('class="chip NoCumple"');
    expect(html).toContain("Deslinde 1");
  });

  it("el nombre de archivo no tiene caracteres inválidos", () => {
    expect(nombreArchivoInforme(informe)).toBe("Informe Casa _Los _Robles__ 2026-10-02");
  });

  it("el Excel es un zip con las seis hojas y los textos en línea", () => {
    const hojas = hojasInforme(informe);
    expect(hojas.map((h) => h.nombre)).toEqual(["Resumen", "Reglas", "Fuentes", "Elementos", "Predio", "Modelos"]);
    const zip = unzipSync(informeExcel(informe));
    expect(Object.keys(zip)).toContain("xl/workbook.xml");
    expect(Object.keys(zip).filter((k) => k.startsWith("xl/worksheets/"))).toHaveLength(6);
    const reglas = strFromU8(zip["xl/worksheets/sheet2.xml"]);
    expect(reglas).toContain('t="inlineStr"');
    expect(reglas).toContain("Altura máxima");
    expect(reglas).toContain("<v>1</v>"); // elementos de R-01
    expect(strFromU8(zip["xl/workbook.xml"])).toContain('name="Resumen"');
  });
});
