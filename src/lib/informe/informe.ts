// Informe de la revisión normativa o del estudio de cabida (MVP-W3): porte de Core/Reports/ReviewReport.cs y de los
// escritores JSON y HTML de Infrastructure/Reports/ReportWriters.cs. Un solo objeto alimenta los tres formatos
// (JSON, Excel y PDF por impresión del HTML) para que no puedan discrepar. Todo se genera en el navegador.
import { RULE_STATE_LABELS, citation, type CabidaPreliminar, type NormSource, type Parcel, type RuleResult, type RuleState } from "@/lib/reglas/tipos";
import { edgeLength, orientation, parcelArea } from "@/lib/reglas/predio";
import { ORIGEN_LABELS, datosDeEntrada } from "@/lib/reglas/cabidaPreliminar";

export const ESQUEMA_INFORME = "bnc-report/1";

export const DESCARGO_INFORME =
  "Revisión de apoyo generada por Norma+BIM. No reemplaza la revisión del arquitecto revisor ni de la DOM. " +
  "Los datos del PRC obtenidos de la IDE MINVU son referenciales: lo oficial es la Ordenanza Local vigente. " +
  "Cada exigencia cita su fuente; un resultado «Revisión requerida» o «No verificable» no es una aprobación.";

export interface LineaInforme {
  label: string;
  value: string;
}

export interface ModeloInforme {
  fileName: string;
  discipline: string;
  condition: string;
  sha256: string | null;
  elementCount: number | null;
}

export interface DeslindeInforme {
  number: number;
  orientation: string;
  kind: string;
  lengthM: number;
  officialLinesWidthM: number | null;
}

export interface PredioInforme {
  areaM2: number;
  source: string;
  naturalGroundZ: number;
  groundConfirmed: boolean;
  positionConfirmed: boolean;
  edges: DeslindeInforme[];
}

export const DESCARGO_CABIDA =
  "Estudio preliminar de cabida: referencial, no reemplaza el Certificado de Informaciones Previas (CIP) ni la revisión de la DOM. " +
  "Cada cifra normativa cita su fuente (ficha del PRC, OGUC o CIP indicado por el usuario); los supuestos están marcados y son editables; " +
  "lo que depende de un dato faltante queda «Revisión requerida».";

export const PIE_ISOMETRICA = "Captura del visor: rasantes, altura máxima, volumen teórico y predio";

/** Cabida preliminar del informe: cálculo con su desarrollo, láminas como SVG y la isométrica del visor (PNG) o el motivo si no se pudo. */
export interface CabidaInforme {
  preliminar: CabidaPreliminar;
  laminas: { titulo: string; svg: string }[];
  isometrica: string | null;
  isometricaError: string | null;
}

/** Todo lo necesario para leer el informe sin la aplicación. Mismos campos (camelCase) que el escritorio. */
export interface Informe {
  kind: string;
  generatedAt: string;
  appVersion: string;
  projectName: string | null;
  permit: string | null;
  project: LineaInforme[];
  models: ModeloInforme[];
  territory: LineaInforme[];
  parcel: PredioInforme | null;
  zone: string | null;
  status: string | null;
  warnings: string[];
  results: RuleResult[];
  /** Solo en el informe de cabida (pestaña Cabida). */
  cabidaPreliminar?: CabidaInforme | null;
}

export const ESTADOS: RuleState[] = ["Cumple", "NoCumple", "RevisionRequerida", "NoVerificable", "NoAplica", "Informativo"];

export const tituloInforme = (r: Informe): string => (r.projectName ? `${r.kind} · ${r.projectName}` : r.kind);

export function conteos(r: Informe): Record<RuleState, number> {
  const out = Object.fromEntries(ESTADOS.map((s) => [s, 0])) as Record<RuleState, number>;
  for (const result of r.results) out[result.state] = (out[result.state] ?? 0) + 1;
  return out;
}

/** Nombre de archivo seguro, sin extensión: «Informe <proyecto o tipo> <fecha>» o «Informe de cabida <proyecto> <fecha>». */
export function nombreArchivoInforme(r: Informe): string {
  const base = (r.projectName?.trim() || (r.cabidaPreliminar ? "" : r.kind)).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim();
  return [r.cabidaPreliminar ? "Informe de cabida" : "Informe", base, r.generatedAt.slice(0, 10)].filter((t) => t !== "").join(" ");
}

export function predioInforme(parcel: Parcel): PredioInforme {
  return {
    areaM2: parcelArea(parcel),
    source: parcel.source,
    naturalGroundZ: parcel.naturalGroundZ,
    groundConfirmed: parcel.groundConfirmed,
    positionConfirmed: parcel.positionConfirmed,
    edges: parcel.edges.map((e, i) => ({
      number: i + 1,
      orientation: orientation(parcel, i),
      kind: e.kind,
      lengthM: edgeLength(parcel, i),
      officialLinesWidthM: e.officialLinesWidth ?? null,
    })),
  };
}

// --- JSON (para otros programas) ---------------------------------------------------------------------------------

/** JSON `bnc-report/1`, con el codificador por defecto (nunca se incrusta en HTML; se descarga). */
export function informeJson(r: Informe): string {
  return JSON.stringify(
    {
      schema: ESQUEMA_INFORME,
      kind: r.kind,
      generatedAt: r.generatedAt,
      appVersion: r.appVersion,
      projectName: r.projectName,
      permit: r.permit,
      project: r.project,
      models: r.models,
      territory: r.territory,
      parcel: r.parcel,
      zone: r.zone,
      status: r.status,
      warnings: r.warnings,
      counts: conteos(r),
      results: r.results,
      ...(r.cabidaPreliminar
        ? {
            cabidaPreliminar: {
              ...r.cabidaPreliminar.preliminar,
              datosEntrada: datosDeEntrada(r.cabidaPreliminar.preliminar.entrada),
              ...(r.cabidaPreliminar.isometrica ? { isometrica: r.cabidaPreliminar.isometrica } : {}),
              isometricaError: r.cabidaPreliminar.isometricaError,
              disclaimer: DESCARGO_CABIDA,
            },
          }
        : {}),
      disclaimer: DESCARGO_INFORME,
    },
    null,
    2,
  );
}

// --- HTML (se imprime a PDF) -------------------------------------------------------------------------------------

const es2 = (v: number) => v.toLocaleString("es-CL", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const es0 = (v: number) => v.toLocaleString("es-CL", { maximumFractionDigits: 0 });

/** Solo se escapa el marcado: el documento es UTF-8 y las tildes y «» deben quedar legibles. */
export const E = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const row = (label: string, value: string) => `<tr><th>${E(label)}</th><td>${E(value)}</td></tr>`;

const fechaGenerado = (r: Informe): string => {
  const fecha = new Date(r.generatedAt);
  return `Generado el ${fecha.toLocaleDateString("es-CL", { day: "numeric", month: "long", year: "numeric" })}, ${fecha.toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit" })} · Norma+BIM ${r.appVersion}`;
};

const STYLE = `
@page { size: A4; margin: 16mm 14mm; }
body { font: 10pt/1.4 "Segoe UI", Arial, sans-serif; color: #1b1f23; margin: 0; }
h1 { font-size: 18pt; margin: 0 0 4pt; color: #1F5C3A; }
h2 { font-size: 12pt; margin: 16pt 0 6pt; border-bottom: 1.5px solid #1F5C3A; padding-bottom: 2pt; color: #1F5C3A; }
table { border-collapse: collapse; width: 100%; }
td, th { border: 1px solid #c9d1d9; padding: 3pt 5pt; vertical-align: top; text-align: left; }
th { background: #eef3ef; width: 28%; }
.muted { color: #57606a; font-size: 9pt; }
.rule { break-inside: avoid; border: 1px solid #c9d1d9; border-radius: 4pt; padding: 6pt 8pt; margin: 0 0 8pt; }
.chip { display: inline-block; border-radius: 3pt; padding: 0 5pt; font-weight: 600; font-size: 9pt; margin-right: 6pt; }
.Cumple { background: #b7e1c1 } .NoCumple { background: #f4b6b6 } .RevisionRequerida { background: #f8e1a1 }
.NoVerificable { background: #d9d9d9 } .NoAplica, .Informativo { background: #e3eaf2 }
blockquote { margin: 3pt 0 3pt 8pt; padding-left: 8pt; border-left: 3px solid #1F5C3A; color: #333; font-size: 9pt; }
.warn { background: #fff4d6; border: 1px solid #e8c766; border-radius: 4pt; padding: 3pt 8pt; margin: 4pt 0; }
`;

export function informeHtml(r: Informe): string {
  if (r.cabidaPreliminar) return informeCabidaHtml(r, r.cabidaPreliminar);
  const counts = conteos(r);
  const parts: string[] = [];
  parts.push(`<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${E(tituloInforme(r))}</title><style>${STYLE}</style></head><body>`);
  parts.push(`<h1>${E(tituloInforme(r))}</h1><div class="muted">${E(fechaGenerado(r))}</div><p class="muted">${E(DESCARGO_INFORME)}</p>`);

  parts.push("<h2>Resumen</h2><table>");
  if (r.permit) parts.push(row("Trámite", r.permit));
  if (r.zone) parts.push(row("Zona del PRC", r.zone));
  if (r.status) parts.push(row("Resultado", r.status));
  parts.push(row("Estados", ESTADOS.filter((s) => counts[s] > 0).map((s) => `${counts[s]} ${RULE_STATE_LABELS[s].toLowerCase()}`).join(" · ")));
  for (const line of [...r.project, ...r.territory]) parts.push(row(line.label, line.value));
  parts.push("</table>");
  for (const warning of r.warnings) parts.push(`<div class="warn">${E(warning)}</div>`);

  if (r.models.length > 0) {
    parts.push("<h2>Modelos revisados</h2><table>");
    for (const m of r.models) {
      parts.push(row(m.fileName, `${m.discipline} · ${m.condition}` + (m.elementCount !== null ? ` · ${es0(m.elementCount)} elementos` : "") + (m.sha256 ? ` · SHA-256 ${m.sha256}` : "")));
    }
    parts.push("</table>");
  }

  if (r.parcel) {
    const p = r.parcel;
    parts.push("<h2>Predio</h2><table>");
    parts.push(row("Superficie", `${es2(p.areaM2)} m² · ${p.source}`));
    parts.push(row("Suelo natural", `Z = ${es2(p.naturalGroundZ)} m (${p.groundConfirmed ? "confirmado" : "supuesto, sin confirmar"})`));
    parts.push(row("Posición del modelo", p.positionConfirmed ? "verificada" : "sin verificar"));
    for (const e of p.edges) {
      parts.push(row(`Deslinde ${e.number}`, `${e.orientation} · ${e.kind} · ${es2(e.lengthM)} m` + (e.officialLinesWidthM !== null ? ` · entre líneas oficiales ${e.officialLinesWidthM.toLocaleString("es-CL", { maximumFractionDigits: 2 })} m` : "")));
    }
    parts.push("</table>");
  }

  parts.push("<h2>Reglas</h2>");
  for (const result of r.results) {
    parts.push(`<div class="rule"><div><span class="chip ${result.state}">${E(RULE_STATE_LABELS[result.state])}</span><b>${E(`${result.id} · ${result.title}`)}</b></div>`);
    parts.push(`<div>${E(result.summary)}</div>`);
    if (result.required) parts.push(`<div><span class="muted">Exigido:</span> ${E(result.required)}</div>`);
    if (result.measured) parts.push(`<div><span class="muted">Medido:</span> ${E(result.measured)}</div>`);
    for (const source of result.sources) {
      parts.push(`<blockquote>«${E(source.quote)}»<br><span class="muted">${E(citation(source))}${source.version ? E(` · ${source.version}`) : ""}</span></blockquote>`);
    }
    for (const note of result.notes) parts.push(`<div class="muted">• ${E(note)}</div>`);
    if (result.elements.length > 0) {
      const shown = result.elements.slice(0, 15).map((e) => `#${e.expressId} ${e.ifcClass}${e.name ? ` «${e.name}»` : ""}: ${e.detail}`).join("; ");
      const more = result.elements.length > 15 ? E(`; … y ${result.elements.length - 15} más (ver el Excel)`) : "";
      parts.push(`<div class="muted">Elementos (${result.elements.length}): ${E(shown)}${more}</div>`);
    }
    parts.push("</div>");
  }
  parts.push("</body></html>");
  return parts.join("");
}

// --- Informe de cabida (HTML impreso a PDF) ------------------------------------------------------------------------

const cita = (s: NormSource) => `<blockquote>«${E(s.quote)}»<br><span class="muted">${E(citation(s))}${s.version ? E(` · ${s.version}`) : ""}</span></blockquote>`;

const num = (v: number | null, d = 2) => (v === null ? "—" : v.toLocaleString("es-CL", { maximumFractionDigits: d }));

/** Portada, datos de entrada con su origen, desarrollo paso a paso, tabla por piso, estacionamientos, restricciones, láminas e isométrica. */
function informeCabidaHtml(r: Informe, cab: CabidaInforme): string {
  const c = cab.preliminar;
  const e = c.entrada;
  const parts: string[] = [];
  parts.push(`<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${E(tituloInforme(r))}</title><style>${STYLE}
.portada { break-after: page; }
.portada h1 { font-size: 22pt; margin-top: 40pt; }
.kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6pt; margin: 12pt 0; }
.kpi { border: 1px solid #c9d1d9; border-radius: 4pt; padding: 6pt; text-align: center; }
.kpi b { display: block; font-size: 16pt; color: #1F5C3A; }
.paso { border-left: 3px solid #2f9d5c; padding: 2pt 0 2pt 8pt; margin: 4pt 0; break-inside: avoid; }
.f { font-family: Consolas, "Cascadia Mono", monospace; font-size: 9pt; }
.sup { color: #9a6700; font-size: 9pt; }
th.c, td.c { text-align: right; width: auto; }
figure { margin: 8pt 0; break-inside: avoid; }
figure img { width: 100%; border: 1px solid #c9d1d9; }
figcaption { color: #57606a; font-size: 9pt; margin-top: 3pt; }
</style></head><body>`);

  const comuna = r.territory.find((l) => l.label === "Comuna")?.value ?? "sin comuna identificada";
  parts.push(`<section class="portada"><h1>${E(tituloInforme(r))}</h1><div>Estudio preliminar de cabida para edificio de departamentos</div><div class="muted">${E(fechaGenerado(r))}</div><table>`);
  parts.push(row("Proyecto", r.projectName ?? "sin nombre"));
  parts.push(row("Comuna", comuna));
  parts.push(row("Zona del PRC", r.zone ?? e.zona ?? "sin zona con normas"));
  parts.push(row("Fecha", new Date(r.generatedAt).toLocaleDateString("es-CL", { day: "numeric", month: "long", year: "numeric" })));
  parts.push(row("Predio", `${num(e.superficiePredio)} m²${r.parcel ? ` · ${r.parcel.source}` : ""}`));
  for (const line of r.project.filter((l) => l.label !== "Proyecto")) parts.push(row(line.label, line.value));
  parts.push("</table>");
  parts.push(`<div class="kpis"><div class="kpi"><b>${num(c.construible, 1)}</b>m² construibles</div><div class="kpi"><b>${num(c.departamentos, 0)}</b>departamentos</div>` +
    `<div class="kpi"><b>${num(c.numeroPisos, 0)}</b>pisos</div><div class="kpi"><b>${num(c.estacionamientos, 0)}</b>estacionamientos</div></div>`);
  parts.push(`<p class="muted">${E(DESCARGO_CABIDA)}</p><p class="muted">${E(DESCARGO_INFORME)}</p></section>`);

  parts.push("<h2>Datos de entrada</h2><table><tr><th>Dato</th><th>Valor</th><th>Origen</th><th>Fuente</th></tr>");
  for (const d of datosDeEntrada(e)) {
    parts.push(`<tr><th>${E(d.label)}</th><td>${E(d.value)}</td><td>${E(ORIGEN_LABELS[d.origen])}</td><td>${d.fuente ? `«${E(d.fuente.quote)}»<br><span class="muted">${E(citation(d.fuente))}</span>` : ""}</td></tr>`);
  }
  parts.push("</table>");
  for (const t of e.notasZona) parts.push(`<div class="muted">• ${E(t)}</div>`);
  for (const warning of r.warnings) parts.push(`<div class="warn">${E(warning)}</div>`);

  parts.push("<h2>Desarrollo matemático</h2>");
  for (const item of c.items) {
    parts.push(`<div class="rule"><div><span class="chip ${item.estado}">${E(RULE_STATE_LABELS[item.estado])}</span><b>${E(`${item.id} · ${item.titulo}`)}</b></div><div>${E(item.resumen)}</div>`);
    for (const p of item.desarrollo) {
      parts.push(`<div class="paso"><b>${E(p.concepto)}</b><div class="f">${E(p.formula)}</div><div class="f">${E(p.sustitucion)}</div>` +
        `<div class="f">= <b>${p.resultado !== null ? E(`${num(p.resultado)} ${p.unidad}`) : "sin resultado"}</b></div>`);
      for (const s of p.supuestos) parts.push(`<div class="sup">Supuesto: ${E(s)}</div>`);
      for (const s of p.fuentes) parts.push(cita(s));
      parts.push("</div>");
    }
    for (const note of item.notas) parts.push(`<div class="muted">• ${E(note)}</div>`);
    parts.push("</div>");
  }

  parts.push("<h2>Tabla por piso</h2>");
  if (c.pisos.length === 0) parts.push(`<p class="muted">Faltan datos para repartir la cabida en pisos.</p>`);
  else {
    parts.push(`<table><tr><th>Piso</th><th class="c">Cota (m)</th><th class="c">Superficie (m²)</th><th class="c">Útil (m²)</th><th class="c">Departamentos</th><th class="c">1D</th><th class="c">2D</th><th class="c">3D</th></tr>`);
    for (const p of c.pisos) {
      parts.push(`<tr><th>Piso ${p.numero}</th><td class="c">${num(p.base)} a ${num(p.top)}</td><td class="c">${num(p.superficie)}</td><td class="c">${num(p.util)}</td><td class="c">${p.departamentos}</td><td class="c">${p.mezcla[0]}</td><td class="c">${p.mezcla[1]}</td><td class="c">${p.mezcla[2]}</td></tr>`);
    }
    const sum = (f: (p: (typeof c.pisos)[number]) => number) => c.pisos.reduce((acc, p) => acc + f(p), 0);
    parts.push(`<tr><th>Total</th><td></td><td class="c"><b>${num(sum((p) => p.superficie))}</b></td><td class="c"><b>${num(sum((p) => p.util))}</b></td><td class="c"><b>${sum((p) => p.departamentos)}</b></td>` +
      `<td class="c">${sum((p) => p.mezcla[0])}</td><td class="c">${sum((p) => p.mezcla[1])}</td><td class="c">${sum((p) => p.mezcla[2])}</td></tr></table>`);
  }

  parts.push("<h2>Estacionamientos</h2><table>");
  parts.push(row("Departamentos", num(c.departamentos, 0)));
  parts.push(row("Estacionamientos por departamento", e.razonEstacionamientos.valor !== null ? `${num(e.razonEstacionamientos.valor, 4)} (CIP)` : "dato faltante: indíquelo desde el CIP"));
  parts.push(row("Estacionamientos", num(c.estacionamientos, 0)));
  parts.push(row("Superficie estimada", c.superficieEstacionamientos !== null ? `${num(c.superficieEstacionamientos)} m² (supuesto de ${num(e.m2Estacionamiento)} m² por estacionamiento)` : "—"));
  parts.push("</table>");

  parts.push("<h2>Restricciones</h2>");
  for (const x of c.restricciones) {
    parts.push(`<div class="rule"><div><span class="chip ${x.estado}">${E(RULE_STATE_LABELS[x.estado])}</span><b>${E(x.titulo)}</b></div><div>${E(x.texto)}</div>${x.fuentes.map(cita).join("")}</div>`);
  }

  parts.push("<h2>Láminas</h2>");
  for (const l of cab.laminas) parts.push(`<figure>${l.svg}</figure>`);

  parts.push("<h2>Isométrica del visor</h2>");
  parts.push(cab.isometrica
    ? `<figure><img src="${E(cab.isometrica)}" alt="${E(PIE_ISOMETRICA)}"><figcaption>${E(PIE_ISOMETRICA)}</figcaption></figure>`
    : `<div class="warn">${E(cab.isometricaError ?? "Sin isométrica del visor.")}</div>`);

  if (r.results.length > 0) {
    parts.push("<h2>Cabida 3D: resultados del motor</h2>");
    for (const result of r.results) {
      parts.push(`<div class="rule"><div><span class="chip ${result.state}">${E(RULE_STATE_LABELS[result.state])}</span><b>${E(`${result.id} · ${result.title}`)}</b></div><div>${E(result.summary)}</div></div>`);
    }
  }
  parts.push(`<p class="muted">${E(DESCARGO_CABIDA)}</p></body></html>`);
  return parts.join("");
}
