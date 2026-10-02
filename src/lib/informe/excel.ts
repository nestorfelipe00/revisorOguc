// Libro Excel (.xlsx) del informe, escrito a mano como SpreadsheetML dentro de un zip (fflate): sin librería de hojas
// de cálculo. Mismas hojas y columnas que ReportWriters.WriteExcel del escritorio: Resumen, Reglas, Fuentes,
// Elementos, Predio y Modelos (y Cabida en el informe de cabida). Los textos van como cadenas en línea (nunca fórmulas)
// y las cifras como números.
import { zipSync, strToU8 } from "fflate";
import { RULE_STATE_LABELS, citation, type CabidaPreliminar, type RuleState } from "@/lib/reglas/tipos";
import { ORIGEN_LABELS, datosDeEntrada } from "@/lib/reglas/cabidaPreliminar";
import { DESCARGO_CABIDA, DESCARGO_INFORME, ESTADOS, conteos, tituloInforme, type Informe } from "./informe";

type Celda = string | number | null | { v: string | number | null; s?: Estilo };
type Fila = Celda[];

/** Índices de xl/styles.xml (cellXfs). */
const enum Estilo {
  Normal = 0,
  Negrita = 1,
  Encabezado = 2,
  Cumple = 3,
  NoCumple = 4,
  RevisionRequerida = 5,
  NoVerificable = 6,
  Otro = 7,
  Titulo = 8,
}

interface Hoja {
  nombre: string;
  anchos: number[];
  filas: Fila[];
  /** La primera fila es un encabezado fijo (se congela). */
  congelar: boolean;
}

const X = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");

function columna(i: number): string {
  let s = "";
  for (let n = i; n >= 0; n = Math.floor(n / 26) - 1) s = String.fromCharCode(65 + (n % 26)) + s;
  return s;
}

function estiloEstado(state: RuleState): Estilo {
  switch (state) {
    case "Cumple":
      return Estilo.Cumple;
    case "NoCumple":
      return Estilo.NoCumple;
    case "RevisionRequerida":
      return Estilo.RevisionRequerida;
    case "NoVerificable":
      return Estilo.NoVerificable;
    default:
      return Estilo.Otro;
  }
}

const enc = (titulos: string[]): Fila => titulos.map((t) => ({ v: t, s: Estilo.Encabezado }));

function hojaXml(h: Hoja): string {
  const cols = h.anchos.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("");
  const filas = h.filas
    .map((fila, r) => {
      const celdas = fila
        .map((c, i) => {
          const celda = c !== null && typeof c === "object" ? c : { v: c, s: Estilo.Normal };
          if (celda.v === null || celda.v === undefined) return "";
          const ref = `${columna(i)}${r + 1}`;
          const s = celda.s ?? Estilo.Normal;
          if (typeof celda.v === "number") return `<c r="${ref}" s="${s}"><v>${Number.isFinite(celda.v) ? celda.v : 0}</v></c>`;
          return `<c r="${ref}" s="${s}" t="inlineStr"><is><t xml:space="preserve">${X(String(celda.v))}</t></is></c>`;
        })
        .join("");
      return `<row r="${r + 1}">${celdas}</row>`;
    })
    .join("");
  const pane = h.congelar ? `<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>` : "";
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<sheetViews><sheetView workbookViewId="0">${pane}</sheetView></sheetViews>` +
    (cols ? `<cols>${cols}</cols>` : "") +
    `<sheetData>${filas}</sheetData></worksheet>`
  );
}

const STYLES_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
  `<fonts count="4"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font>` +
  `<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font><font><b/><sz val="14"/><name val="Calibri"/></font></fonts>` +
  `<fills count="7"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>` +
  `<fill><patternFill patternType="solid"><fgColor rgb="FF1F5C3A"/></patternFill></fill>` +
  `<fill><patternFill patternType="solid"><fgColor rgb="FFB7E1C1"/></patternFill></fill>` +
  `<fill><patternFill patternType="solid"><fgColor rgb="FFF4B6B6"/></patternFill></fill>` +
  `<fill><patternFill patternType="solid"><fgColor rgb="FFF8E1A1"/></patternFill></fill>` +
  `<fill><patternFill patternType="solid"><fgColor rgb="FFD9D9D9"/></patternFill></fill></fills>` +
  `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
  `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
  `<cellXfs count="9">` +
  `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>` +
  `<xf numFmtId="0" fontId="1" fillId="0" borderId="0" applyFont="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>` +
  `<xf numFmtId="0" fontId="2" fillId="2" borderId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>` +
  `<xf numFmtId="0" fontId="0" fillId="3" borderId="0" applyFill="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>` +
  `<xf numFmtId="0" fontId="0" fillId="4" borderId="0" applyFill="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>` +
  `<xf numFmtId="0" fontId="0" fillId="5" borderId="0" applyFill="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>` +
  `<xf numFmtId="0" fontId="0" fillId="6" borderId="0" applyFill="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>` +
  `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>` +
  `<xf numFmtId="0" fontId="3" fillId="0" borderId="0" applyFont="1"/>` +
  `</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

/** Hojas del informe, en el mismo orden que el escritorio. */
export function hojasInforme(r: Informe): Hoja[] {
  const counts = conteos(r);
  const fecha = new Date(r.generatedAt);
  const resumen: Fila[] = [
    [{ v: tituloInforme(r), s: Estilo.Titulo }],
    ["Generado", `${fecha.toLocaleDateString("es-CL")} ${fecha.toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit" })}`],
    ["Aplicación", `BIM Normative Checker ${r.appVersion}`],
  ];
  if (r.permit) resumen.push(["Trámite", r.permit]);
  if (r.zone) resumen.push(["Zona del PRC", r.zone]);
  if (r.status) resumen.push(["Resultado", r.status]);
  resumen.push([], [{ v: "Estados", s: Estilo.Negrita }]);
  for (const s of ESTADOS) resumen.push([RULE_STATE_LABELS[s], counts[s]]);
  resumen.push([]);
  for (const line of [...r.project, ...r.territory]) resumen.push([line.label, line.value]);
  if (r.warnings.length > 0) {
    resumen.push([], [{ v: "Supuestos y advertencias", s: Estilo.Negrita }]);
    for (const w of r.warnings) resumen.push([w]);
  }
  resumen.push([], [DESCARGO_INFORME]);

  const reglas: Fila[] = [enc(["Regla", "Título", "Estado", "Resumen", "Exigido", "Medido", "Fuentes", "Notas", "Elementos"])];
  for (const x of r.results) {
    reglas.push([
      x.id,
      x.title,
      { v: RULE_STATE_LABELS[x.state], s: estiloEstado(x.state) },
      x.summary,
      x.required ?? "",
      x.measured ?? "",
      x.sources.map((s) => citation(s)).join("\n"),
      x.notes.join("\n"),
      x.elements.length,
    ]);
  }

  const fuentes: Fila[] = [enc(["Regla", "Documento", "Artículo", "Página", "Versión", "Texto literal", "Enlace"])];
  for (const x of r.results) for (const s of x.sources) fuentes.push([x.id, s.document, s.article, s.page ?? null, s.version ?? "", s.quote, s.url ?? ""]);

  const elementos: Fila[] = [enc(["Regla", "Modelo", "ExpressID", "GlobalId", "Clase IFC", "Nombre", "Valor", "Detalle"])];
  for (const x of r.results) for (const e of x.elements) elementos.push([x.id, e.modelId, e.expressId, e.globalId ?? "", e.ifcClass, e.name ?? "", Math.round(e.value * 1000) / 1000, e.detail]);

  const hojas: Hoja[] = [
    { nombre: "Resumen", anchos: [30, 80], filas: resumen, congelar: false },
    { nombre: "Reglas", anchos: [8, 40, 18, 60, 40, 40, 50, 50, 11], filas: reglas, congelar: true },
    { nombre: "Fuentes", anchos: [8, 40, 25, 8, 20, 90, 40], filas: fuentes, congelar: true },
    { nombre: "Elementos", anchos: [8, 10, 11, 26, 24, 30, 10, 70], filas: elementos, congelar: true },
  ];
  if (r.parcel) {
    const p = r.parcel;
    const predio: Fila[] = [
      ["Superficie (m²)", Math.round(p.areaM2 * 100) / 100],
      ["Origen", p.source],
      ["Suelo natural en Z (m)", Math.round(p.naturalGroundZ * 100) / 100],
      ["Suelo natural confirmado", p.groundConfirmed ? "Sí" : "No (supuesto)"],
      ["Posición del modelo verificada", p.positionConfirmed ? "Sí" : "No"],
      [],
      enc(["Deslinde", "Orientación", "Tipo", "Largo (m)", "Ancho entre líneas oficiales (m)"]),
    ];
    for (const e of p.edges) predio.push([e.number, e.orientation, e.kind, Math.round(e.lengthM * 100) / 100, e.officialLinesWidthM]);
    hojas.push({ nombre: "Predio", anchos: [30, 30, 30, 30, 30], filas: predio, congelar: false });
  }
  if (r.models.length > 0) {
    const modelos: Fila[] = [enc(["Archivo", "Disciplina", "Condición", "Elementos", "SHA-256"])];
    for (const m of r.models) modelos.push([m.fileName, m.discipline, m.condition, m.elementCount, m.sha256 ?? ""]);
    hojas.push({ nombre: "Modelos", anchos: [40, 24, 14, 12, 70], filas: modelos, congelar: true });
  }
  if (r.cabidaPreliminar) hojas.push(hojaCabida(r.cabidaPreliminar.preliminar));
  return hojas;
}

const redondo = (v: number | null, d = 2): number | null => (v === null ? null : Math.round(v * 10 ** d) / 10 ** d);

/** Hoja «Cabida»: entradas con su origen, desarrollo paso a paso, tabla por piso, estacionamientos y restricciones (sin imágenes). */
function hojaCabida(c: CabidaPreliminar): Hoja {
  const filas: Fila[] = [[{ v: "Cabida preliminar (edificio de departamentos)", s: Estilo.Titulo }], [DESCARGO_CABIDA], []];
  filas.push([{ v: "Datos de entrada", s: Estilo.Negrita }], enc(["Dato", "Valor", "Origen", "Fuente", "Texto literal"]));
  for (const d of datosDeEntrada(c.entrada)) filas.push([d.label, d.value, ORIGEN_LABELS[d.origen], d.fuente ? citation(d.fuente) : "", d.fuente?.quote ?? ""]);

  filas.push([], [{ v: "Desarrollo matemático", s: Estilo.Negrita }], enc(["Punto", "Estado", "Paso", "Fórmula", "Sustitución", "Resultado", "Unidad", "Supuestos", "Fuentes"]));
  for (const item of c.items) {
    for (const p of item.desarrollo) {
      filas.push([
        `${item.id} ${item.titulo}`,
        { v: RULE_STATE_LABELS[item.estado], s: estiloEstado(item.estado) },
        p.concepto,
        p.formula,
        p.sustitucion,
        redondo(p.resultado),
        p.unidad,
        p.supuestos.join("\n"),
        p.fuentes.map((s) => `${citation(s)}: «${s.quote}»`).join("\n"),
      ]);
    }
  }

  filas.push([], [{ v: "Tabla por piso", s: Estilo.Negrita }], enc(["Piso", "Base (m)", "Techo (m)", "Superficie (m²)", "Útil (m²)", "Departamentos", "1D", "2D", "3D"]));
  for (const p of c.pisos) filas.push([p.numero, redondo(p.base), redondo(p.top), redondo(p.superficie), redondo(p.util), p.departamentos, ...p.mezcla]);

  filas.push([], [{ v: "Estacionamientos", s: Estilo.Negrita }]);
  filas.push(["Estacionamientos", c.estacionamientos], ["Superficie estimada (m²)", redondo(c.superficieEstacionamientos)], ["m² por estacionamiento (supuesto)", c.entrada.m2Estacionamiento]);

  filas.push([], [{ v: "Restricciones", s: Estilo.Negrita }], enc(["Restricción", "Estado", "Texto", "Fuentes"]));
  for (const x of c.restricciones) {
    filas.push([x.titulo, { v: RULE_STATE_LABELS[x.estado], s: estiloEstado(x.estado) }, x.texto, x.fuentes.map((s) => `${citation(s)}: «${s.quote}»`).join("\n")]);
  }
  return { nombre: "Cabida", anchos: [34, 30, 26, 50, 50, 14, 14, 40, 50], filas, congelar: false };
}

/** Bytes del .xlsx. */
export function informeExcel(r: Informe): Uint8Array {
  const hojas = hojasInforme(r);
  const files: Record<string, Uint8Array> = {};
  files["[Content_Types].xml"] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
      `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
      hojas.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("") +
      `</Types>`,
  );
  files["_rels/.rels"] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
      `</Relationships>`,
  );
  files["xl/workbook.xml"] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
      `<sheets>${hojas.map((h, i) => `<sheet name="${X(h.nombre)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`,
  );
  files["xl/_rels/workbook.xml.rels"] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      hojas.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("") +
      `<Relationship Id="rId${hojas.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
      `</Relationships>`,
  );
  files["xl/styles.xml"] = strToU8(STYLES_XML);
  hojas.forEach((h, i) => (files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(hojaXml(h))));
  return zipSync(files, { level: 6 });
}
