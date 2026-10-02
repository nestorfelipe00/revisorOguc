// Cabida preliminar de un edificio de departamentos (pestaña Cabida). Con la superficie del predio y las normas de la zona
// —ficha del PRC o, si el usuario lo indica, el CIP— estima la superficie construible, la ocupación de primer piso, la superficie
// útil, los departamentos (con tope por densidad y por la altura o el volumen teórico de la cabida 3D), los pisos y los
// estacionamientos. Cada resultado guarda su desarrollo (fórmula → sustitución → resultado) con la fuente literal o el supuesto
// que usa, para que el informe lo muestre paso a paso. Nunca da «Cumple»: lo que depende de un dato faltante queda
// «Revisión requerida» y lo dice. No usa jsts ni el motor geométrico: corre en el hilo principal al editar una cifra.
import { parseNumber } from "@/lib/territorio/colocacion";
import type { NormCatalog, ZoneNorms } from "./normas";
import type {
  CabidaFloor,
  CabidaPreliminar,
  DatoCabida,
  EntradaCabidaPreliminar,
  ItemCabida,
  NormSource,
  PasoDesarrollo,
  PisoCabidaPreliminar,
  RestriccionCabida,
  RuleState,
  TopeDepartamentos,
} from "./tipos";

export const DATO_FALTANTE = "dato faltante: indíquelo desde el CIP";

export type OrigenNorma = "PRC" | "CIP";

/** Cifras de la pestaña tal como se escriben (coma o punto decimal). Se guardan en `campos.cabida` del proyecto. */
export interface AjustesCabida {
  m2Departamento: string;
  /** Mezcla 1D / 2D / 3D en %. */
  mezcla: [string, string, string];
  /** Estacionamientos por departamento (dato del CIP u Ordenanza; vacío = falta). */
  razonEstacionamientos: string;
  /** % de la superficie construible en circulaciones y muros. */
  circulaciones: string;
  habPorVivienda: string;
  m2Estacionamiento: string;
  ocupacion: { origen: OrigenNorma; valor: string };
  constructibilidad: { origen: OrigenNorma; valor: string };
  altura: { origen: OrigenNorma; metros: string; pisos: string };
  densidad: { origen: OrigenNorma | "Libre"; valor: string };
}

/**
 * Valores de partida: supuestos de diseño (55 m² útiles, mezcla 30/50/20) y del estudio (15 %, 4 hab/viv, 25 m²), todos editables.
 * Ninguna cifra normativa: coeficientes, altura y densidad salen de la ficha (PRC) o del CIP.
 */
export const AJUSTES_CABIDA: AjustesCabida = {
  m2Departamento: "55",
  mezcla: ["30", "50", "20"],
  razonEstacionamientos: "",
  circulaciones: "15",
  habPorVivienda: "4",
  m2Estacionamiento: "25",
  ocupacion: { origen: "PRC", valor: "" },
  constructibilidad: { origen: "PRC", valor: "" },
  altura: { origen: "PRC", metros: "", pisos: "" },
  densidad: { origen: "PRC", valor: "" },
};

/** Lo que la cabida preliminar toma del territorio: normativa cargada, ficha de la zona principal, región y superficie del predio. */
export interface ContextoCabida {
  norms: NormCatalog;
  zona: ZoneNorms | null;
  zonaCodigo: string | null;
  region: string | null;
  superficiePredio: number;
  notas: string[];
}

/** Math.Round a d decimales con coma decimal y sin separador de miles (como F del motor, sin importar el motor). */
const F = (value: number, decimals = 2): string =>
  (Math.round(value * 10 ** decimals) / 10 ** decimals).toLocaleString("es-CL", { minimumFractionDigits: 0, maximumFractionDigits: decimals, useGrouping: false });

const piso = (x: number): number => Math.floor(x + 1e-9);
const techo = (x: number): number => Math.ceil(x - 1e-9);

/** Fuente de un dato que el usuario copia del Certificado de Informaciones Previas. */
const cipSource = (quote: string): NormSource => ({
  document: "Certificado de Informaciones Previas (CIP)",
  article: "Dato ingresado por el usuario",
  quote,
  version: null,
  url: null,
  page: null,
});

const faltante = (): DatoCabida => ({ valor: null, origen: "Faltante", fuente: null, advertencia: null });

/** Advertencias de la ficha sobre un campo (las de «zona» valen para todas sus cifras). */
const advertenciaDe = (zona: ZoneNorms | null, field: string): string | null => {
  const textos = (zona?.warnings ?? []).filter((w) => w.field === field || w.field === "zona").map((w) => w.text);
  return textos.length > 0 ? textos.join(" ") : null;
};

/**
 * Resuelve las cifras de la pestaña: las normativas desde la ficha (PRC) o el CIP, los supuestos con su valor y, si se calculó,
 * las plantas del volumen teórico de la cabida 3D. Devuelve los errores de lo que no se puede leer (nunca inventa un valor).
 */
export function prepararEntradaCabida(
  ctx: ContextoCabida,
  a: AjustesCabida,
  pisoAPisoTexto: string,
  volumen: CabidaFloor[] | null,
): { entrada: EntradaCabidaPreliminar | null; errores: string[] } {
  const errores: string[] = [];
  const { norms, zona } = ctx;
  const leer = (texto: string, nombre: string, minimo: number, maximo = Number.POSITIVE_INFINITY, incluyeMinimo = false): number | null => {
    const v = parseNumber(texto);
    if (v === null || v < minimo || (!incluyeMinimo && v === minimo) || v > maximo) {
      errores.push(`${nombre}: indique un número ${incluyeMinimo ? "mayor o igual a" : "mayor que"} ${F(minimo)}${Number.isFinite(maximo) ? ` y hasta ${F(maximo)}` : ""}.`);
      return null;
    }
    return v;
  };

  /** Dato normativo: del CIP si el usuario lo eligió y lo escribió; si no, de la ficha con su texto literal. */
  const normativo = (origen: OrigenNorma | "Libre", texto: string, nombre: string, unidad: string, prc: number | null, prcText: string | null, campo: string): DatoCabida => {
    if (origen === "CIP") {
      if (texto.trim() === "") return faltante();
      const v = leer(texto, nombre, 0);
      return v === null ? faltante() : { valor: v, origen: "CIP", fuente: cipSource(`${nombre}: ${F(v, 4)}${unidad}`), advertencia: null };
    }
    if (prc === null || zona === null) return faltante();
    return { valor: prc, origen: "PRC", fuente: norms.zoneSource(zona, prcText ?? `${nombre} ${F(prc, 4)}${unidad}`), advertencia: advertenciaDe(zona, campo) };
  };

  const ocupacion = normativo(a.ocupacion.origen, a.ocupacion.valor, "Coeficiente de ocupación de suelo", "", zona?.landCoverage ?? null, zona?.landCoverageText ?? null, "ocupacion");
  const constructibilidad = normativo(a.constructibilidad.origen, a.constructibilidad.valor, "Coeficiente de constructibilidad", "", zona?.floorAreaRatio ?? null, zona?.floorAreaRatioText ?? null, "constructibilidad");
  const alturaMetros = normativo(a.altura.origen, a.altura.metros, "Altura máxima", " m", zona?.maxHeight ?? null, zona?.heightText ?? null, "altura");
  const alturaPisos = normativo(a.altura.origen, a.altura.pisos, "Pisos máximos", " pisos", zona?.maxFloors ?? null, zona?.heightText ?? null, "altura");
  const alturaLibre = a.altura.origen === "PRC" && zona !== null && zona.heightFree && zona.maxHeight === null;
  // La base normativa no tiene densidad: viene del CIP o el usuario declara que la Ordenanza no la fija.
  const densidadLibre = a.densidad.origen === "Libre";
  const densidad = densidadLibre ? { valor: null, origen: "CIP" as const, fuente: cipSource("Densidad: la Ordenanza no fija densidad máxima para la zona"), advertencia: null } : normativo(a.densidad.origen, a.densidad.valor, "Densidad máxima", " hab/ha", null, null, "densidad");
  const antejardin = normativo("PRC", "", "Antejardín", " m", zona?.frontYard ?? null, zona?.frontYardText ?? null, "antejardin");
  // La base normativa no tiene el estándar de estacionamientos: solo el CIP (0 es válido si la Ordenanza no exige).
  const razonValor = a.razonEstacionamientos.trim() === "" ? null : leer(a.razonEstacionamientos, "Estacionamientos por departamento", 0, Number.POSITIVE_INFINITY, true);
  const razon: DatoCabida = razonValor === null ? faltante() : { valor: razonValor, origen: "CIP", fuente: cipSource(`Estacionamientos por departamento: ${F(razonValor, 4)}`), advertencia: null };

  const pisoAPiso = leer(pisoAPisoTexto, "Piso a piso (m)", 0);
  const m2Departamento = leer(a.m2Departamento, "m² útiles promedio por departamento", 0);
  const mezcla = a.mezcla.map((t, i) => leer(t, `Mezcla ${i + 1}D (%)`, 0, 100, true));
  const circulaciones = leer(a.circulaciones, "Circulaciones y muros (%)", 0, 90, true);
  const habPorVivienda = leer(a.habPorVivienda, "Habitantes por vivienda", 0);
  const m2Estacionamiento = leer(a.m2Estacionamiento, "m² por estacionamiento", 0);
  if (mezcla.every((m) => m !== null) && Math.abs((mezcla as number[]).reduce((s, m) => s + m, 0) - 100) > 0.5) {
    errores.push(`La mezcla 1D/2D/3D debe sumar 100 % (hoy suma ${F((mezcla as number[]).reduce((s, m) => s + m, 0), 1)} %).`);
  }
  if (errores.length > 0 || pisoAPiso === null || m2Departamento === null || circulaciones === null || habPorVivienda === null || m2Estacionamiento === null || mezcla.some((m) => m === null)) {
    return { entrada: null, errores };
  }

  const angulo = norms.rasanteAngle(ctx.region);
  const rasanteAdvertencia =
    zona !== null && zona.rasanteDegrees !== null && angulo !== null && Math.abs(zona.rasanteDegrees - angulo) > 0.01
      ? `La ficha fija una rasante de ${F(zona.rasanteDegrees)}° («${zona.rasanteText}») y la región, ${F(angulo)}°: se usa la de la región; verifíquelo en el CIP.`
      : advertenciaDe(zona, "rasante");
  const notasZona = [...ctx.notas];
  if (zona !== null && zona.landCoverageMax !== null) notasZona.push(`La ficha admite una ocupación de suelo de hasta ${F(zona.landCoverageMax)} si ${zona.landCoverageCondition ?? "se cumple su condición"}: se usa la cifra base.`);
  if (zona !== null && zona.floorAreaRatioMax !== null) notasZona.push(`La ficha admite una constructibilidad de hasta ${F(zona.floorAreaRatioMax)} si ${zona.floorAreaRatioCondition ?? "se cumple su condición"}: se usa la cifra base.`);
  if (zona !== null && zona.incentiveHeight !== null && a.altura.origen === "PRC") notasZona.push("La ficha admite más altura con un incentivo condicionado: se usa la altura base.");

  return {
    errores,
    entrada: {
      superficiePredio: ctx.superficiePredio,
      zona: zona?.zone ?? ctx.zonaCodigo,
      ocupacion,
      constructibilidad,
      alturaMetros,
      alturaPisos,
      alturaLibre,
      densidad,
      densidadLibre,
      antejardin,
      razonEstacionamientos: razon,
      pisoAPiso,
      m2Departamento,
      mezcla: mezcla as [number, number, number],
      circulaciones: circulaciones / 100,
      habPorVivienda,
      m2Estacionamiento,
      rasante: {
        angulo,
        region: ctx.region,
        fuentes: angulo !== null ? [norms.rasante, norms.rasanteTable] : [norms.rasanteTable],
        advertencia: rasanteAdvertencia,
        anchoMaximoFrente: norms.maxFrontWidth,
      },
      distanciamientos: { tabla: norms.setbacks.map((r) => ({ ...r })), fuente: norms.setbackSource },
      adosamiento: { largoPct: norms.adosamientoLengthPercent, altura: norms.adosamientoHeight, angulo: norms.adosamientoAngle, fuentes: norms.adosamientoSources },
      definiciones: {
        ocupacion: norms.definitions.get("Coeficiente de ocupación del suelo") ?? null,
        constructibilidad: norms.definitions.get("Coeficiente de constructibilidad") ?? null,
      },
      alturaMinimaPisoCielo: { metros: norms.minCeilingHeight, fuente: norms.minCeilingSource },
      volumen: volumen && volumen.length > 0 ? volumen.map((f) => ({ numero: f.number, base: f.base, top: f.top, envolvente: f.envelopeArea })) : volumen ? [] : null,
      notasZona,
    },
  };
}

// ---------- Cálculo ----------

/** Fuentes presentes y sin repetir (mismo artículo y texto), en su orden. */
function presentes(fuentes: (NormSource | null)[]): NormSource[] {
  const vistas = new Set<string>();
  return fuentes.filter((s): s is NormSource => {
    if (s === null) return false;
    const clave = `${s.document}\u0000${s.article}\u0000${s.quote}`;
    if (vistas.has(clave)) return false;
    vistas.add(clave);
    return true;
  });
}

/** Reparte total en enteros proporcionales a los pesos (mayor resto): la suma es exactamente total. */
function repartir(total: number, pesos: number[]): number[] {
  const suma = pesos.reduce((s, p) => s + p, 0);
  if (total <= 0 || suma <= 0) return pesos.map(() => 0);
  const cuotas = pesos.map((p) => (total * p) / suma);
  const partes = cuotas.map((c) => piso(c));
  let resto = total - partes.reduce((s, p) => s + p, 0);
  const orden = cuotas.map((c, i) => ({ i, f: c - piso(c) })).sort((x, y) => y.f - x.f || x.i - y.i);
  for (const { i } of orden) {
    if (resto <= 0) break;
    partes[i]++;
    resto--;
  }
  return partes;
}

/** Estado de un resultado: «Revisión requerida» si le falta un dato o la ficha trae una salvedad sobre la cifra. */
const estado = (datos: DatoCabida[], extraRevision = false): RuleState =>
  extraRevision || datos.some((d) => d.origen === "Faltante" || d.advertencia !== null) ? "RevisionRequerida" : "Informativo";

const notasDe = (datos: [string, DatoCabida][]): string[] => {
  const notas: string[] = [];
  for (const [nombre, d] of datos) {
    if (d.origen === "Faltante") notas.push(`${nombre}: ${DATO_FALTANTE}.`);
    else if (d.origen === "CIP") notas.push(`${nombre}: indicado desde el CIP (sustituye a la ficha del PRC).`);
    if (d.advertencia) notas.push(`⚠ ${nombre}: ${d.advertencia}`);
  }
  return notas;
};

const paso = (concepto: string, formula: string, sustitucion: string, resultado: number | null, unidad: string, fuentes: (NormSource | null)[] = [], supuestos: string[] = []): PasoDesarrollo =>
  ({ concepto, formula, sustitucion, resultado, unidad, fuentes: presentes(fuentes), supuestos });

const TOPES: Record<TopeDepartamentos, string> = {
  superficie: "la superficie útil (constructibilidad)",
  densidad: "la densidad máxima",
  altura: "la altura máxima (pisos que caben)",
  volumen: "el volumen teórico de la cabida 3D",
};

/** Cabida preliminar con su desarrollo matemático. Función pura: la misma entrada da siempre el mismo resultado. */
export function cabidaPreliminar(e: EntradaCabidaPreliminar): CabidaPreliminar {
  const S = e.superficiePredio;
  const cc = e.constructibilidad.valor;
  const cos = e.ocupacion.valor;
  const circPct = F(e.circulaciones * 100, 1);
  const supuestoCirc = `Circulaciones y muros: ${circPct} % de la superficie construible (supuesto editable).`;
  const supuestoM2 = `${F(e.m2Departamento)} m² útiles promedio por departamento (supuesto de diseño).`;
  const supuestoPp = `Piso a piso de ${F(e.pisoAPiso)} m (supuesto de diseño, no es una norma).`;
  const supuestoPlanta = "Planta tipo igual a la ocupación máxima de primer piso: la ocupación de suelo solo limita el primer piso; sobre él limitan las rasantes, los distanciamientos y la constructibilidad.";

  // --- CP-01 Superficie máxima construible ---
  const construible = cc !== null ? S * cc : null;
  const cp01: ItemCabida = {
    id: "CP-01",
    titulo: "Superficie máxima construible",
    estado: estado([e.constructibilidad]),
    resumen: construible !== null ? `Hasta ${F(construible)} m² construibles sobre el terreno.` : `Falta el coeficiente de constructibilidad (${DATO_FALTANTE}).`,
    valor: construible,
    unidad: "m²",
    desarrollo: [
      paso("Superficie máxima construible", "Superficie construible = superficie del predio × coeficiente de constructibilidad",
        cc !== null ? `= ${F(S)} m² × ${F(cc, 4)}` : `= ${F(S)} m² × (coeficiente de constructibilidad: ${DATO_FALTANTE})`, construible, "m²",
        [e.constructibilidad.fuente, e.definiciones.constructibilidad]),
    ],
    fuentes: presentes([e.constructibilidad.fuente, e.definiciones.constructibilidad]),
    notas: [
      ...notasDe([["Coeficiente de constructibilidad", e.constructibilidad]]),
      "Se usa la superficie total del predio: si el CIP declara áreas de utilidad pública, se descuentan antes de aplicar el coeficiente (definición del Art. 1.1.2).",
    ],
  };

  // --- CP-02 Ocupación máxima de primer piso ---
  const ocupacion = cos !== null ? S * cos : null;
  const cp02: ItemCabida = {
    id: "CP-02",
    titulo: "Ocupación máxima de primer piso",
    estado: estado([e.ocupacion]),
    resumen: ocupacion !== null ? `Hasta ${F(ocupacion)} m² en el primer piso.` : `Falta el coeficiente de ocupación de suelo (${DATO_FALTANTE}).`,
    valor: ocupacion,
    unidad: "m²",
    desarrollo: [
      paso("Ocupación máxima de primer piso", "Ocupación de primer piso = superficie del predio × coeficiente de ocupación de suelo",
        cos !== null ? `= ${F(S)} m² × ${F(cos, 4)}` : `= ${F(S)} m² × (coeficiente de ocupación de suelo: ${DATO_FALTANTE})`, ocupacion, "m²",
        [e.ocupacion.fuente, e.definiciones.ocupacion]),
    ],
    fuentes: presentes([e.ocupacion.fuente, e.definiciones.ocupacion]),
    notas: notasDe([["Coeficiente de ocupación de suelo", e.ocupacion]]),
  };

  // --- CP-03 Superficie útil ---
  const util = construible !== null ? construible * (1 - e.circulaciones) : null;
  const cp03: ItemCabida = {
    id: "CP-03",
    titulo: "Superficie útil",
    estado: estado([e.constructibilidad]),
    resumen: util !== null ? `${F(util)} m² útiles descontando ${circPct} % de circulaciones y muros.` : "Sin superficie construible no se puede estimar la superficie útil.",
    valor: util,
    unidad: "m²",
    desarrollo: [
      paso("Superficie útil", "Superficie útil = superficie construible × (1 − circulaciones y muros)",
        construible !== null ? `= ${F(construible)} m² × (1 − ${circPct} %)` : `= (superficie construible: ${DATO_FALTANTE}) × (1 − ${circPct} %)`, util, "m²", [], [supuestoCirc]),
    ],
    fuentes: [],
    notas: [],
  };

  // --- Pisos: por altura, por constructibilidad y, con la cabida 3D, dentro del volumen teórico ---
  const pp = e.pisoAPiso;
  const vol = e.volumen;
  const porAlturaM = e.alturaMetros.valor !== null ? piso(e.alturaMetros.valor / pp) : null;
  const porAlturaP = e.alturaPisos.valor !== null ? Math.trunc(e.alturaPisos.valor) : null;
  const porAltura = porAlturaM !== null && porAlturaP !== null ? Math.min(porAlturaM, porAlturaP) : (porAlturaM ?? porAlturaP);
  // Planta posible de cada piso: la ocupación máxima (planta tipo) y, con la cabida 3D, la envolvente de ese piso.
  const tope = (k: number): number | null => {
    const envolvente = vol !== null ? (vol[k - 1]?.envolvente ?? 0) : null;
    if (cos === null) return envolvente;
    return envolvente === null ? (ocupacion as number) : Math.min(ocupacion as number, envolvente);
  };
  const limitePisos = Math.min(porAltura ?? Number.POSITIVE_INFINITY, vol !== null ? vol.length : Number.POSITIVE_INFINITY);
  // Superficie que cabe (sin la constructibilidad): mide si la altura o el volumen limitan los departamentos.
  let cabe: number | null = null;
  if (Number.isFinite(limitePisos) && (cos !== null || vol !== null)) {
    cabe = 0;
    for (let k = 1; k <= limitePisos; k++) cabe += tope(k) ?? 0;
  }
  const porCoeficiente = construible !== null && ocupacion !== null && ocupacion > 0 ? techo(construible / ocupacion) : null;

  const plantas: number[] = [];
  if ((construible !== null || Number.isFinite(limitePisos)) && (cos !== null || vol !== null)) {
    let restante = construible ?? Number.POSITIVE_INFINITY;
    for (let k = 1; k <= limitePisos && restante > 0.01; k++) {
      const planta = Math.min(tope(k) ?? 0, restante);
      if (planta <= 0.01) break;
      plantas.push(planta);
      restante -= planta;
    }
  }
  const numeroPisos = plantas.length > 0 ? plantas.length : null;
  const alturaEdificio = numeroPisos !== null ? numeroPisos * pp : null;

  // --- CP-04 Departamentos ---
  const habitantes = e.habPorVivienda;
  const porSuperficie = util !== null ? piso(util / e.m2Departamento) : null;
  const dens = e.densidad.valor;
  const ha = S / 10000;
  const porDensidad = dens !== null ? piso((dens * ha) / habitantes) : null;
  const cabeUtil = cabe !== null ? cabe * (1 - e.circulaciones) : null;
  const porVolumen = cabeUtil !== null ? piso(cabeUtil / e.m2Departamento) : null;
  const topeVolumen: TopeDepartamentos = vol !== null ? "volumen" : "altura";
  const candidatos: [TopeDepartamentos, number][] = [];
  if (porSuperficie !== null) candidatos.push(["superficie", porSuperficie]);
  if (porVolumen !== null) candidatos.push([topeVolumen, porVolumen]);
  if (porDensidad !== null) candidatos.push(["densidad", porDensidad]);
  const minimo = candidatos.length > 0 ? candidatos.reduce((m, c) => (c[1] < m[1] ? c : m)) : null;
  const departamentos = minimo ? minimo[1] : null;
  const manda = minimo ? minimo[0] : null;
  const densidadFalta = !e.densidadLibre && e.densidad.origen === "Faltante";
  const enterosPorPiso = plantas.reduce((s, p) => s + piso((p * (1 - e.circulaciones)) / e.m2Departamento), 0);

  const pasosDeptos: PasoDesarrollo[] = [
    paso("Por superficie útil", "Departamentos = ⌊superficie útil ÷ m² útiles promedio⌋",
      util !== null ? `= ⌊${F(util)} m² ÷ ${F(e.m2Departamento)} m²⌋ = ⌊${F(util / e.m2Departamento)}⌋` : `= ⌊(superficie útil: ${DATO_FALTANTE}) ÷ ${F(e.m2Departamento)} m²⌋`,
      porSuperficie, "departamentos", [], [supuestoM2]),
    e.densidadLibre
      ? paso("Tope por densidad", "Sin tope por densidad", "La Ordenanza no fija densidad máxima para la zona (indicado desde el CIP).", null, "departamentos", [e.densidad.fuente])
      : paso("Tope por densidad", "Departamentos = ⌊densidad máxima × superficie del predio (ha) ÷ habitantes por vivienda⌋",
        dens !== null ? `= ⌊${F(dens)} hab/ha × ${F(ha, 4)} ha ÷ ${F(habitantes)} hab/viv⌋ = ⌊${F((dens * ha) / habitantes)}⌋` : `= ⌊(densidad máxima: ${DATO_FALTANTE}) × ${F(ha, 4)} ha ÷ ${F(habitantes)} hab/viv⌋`,
        porDensidad, "departamentos", [e.densidad.fuente], [`${F(habitantes)} habitantes por vivienda (supuesto editable; confírmelo con la Ordenanza o el CIP).`]),
  ];
  if (cabe !== null) {
    pasosDeptos.push(
      vol !== null
        ? paso("Tope por volumen teórico", "Departamentos = ⌊superficie que admite el volumen teórico × (1 − circulaciones) ÷ m² útiles promedio⌋",
          `= ⌊${F(cabe)} m² × (1 − ${circPct} %) ÷ ${F(e.m2Departamento)} m²⌋ = ⌊${F(porVolumen !== null && cabeUtil !== null ? cabeUtil / e.m2Departamento : 0)}⌋`,
          porVolumen, "departamentos", [], [supuestoCirc, supuestoM2, "Superficie que admite el volumen: suma de las plantas de la cabida 3D, cada una hasta la ocupación máxima de primer piso."])
        : paso("Tope por altura", "Departamentos = ⌊pisos que caben en la altura × planta tipo × (1 − circulaciones) ÷ m² útiles promedio⌋",
          `= ⌊${F(limitePisos)} × ${F(ocupacion ?? 0)} m² × (1 − ${circPct} %) ÷ ${F(e.m2Departamento)} m²⌋ = ⌊${F(cabeUtil !== null ? cabeUtil / e.m2Departamento : 0)}⌋`,
          porVolumen, "departamentos", [e.alturaMetros.fuente ?? e.alturaPisos.fuente], [supuestoPp, supuestoPlanta]),
    );
  }
  pasosDeptos.push(
    paso("Departamentos", "Departamentos = mín(topes)", candidatos.length > 0 ? `= mín(${candidatos.map(([t, v]) => `${v} por ${t}`).join("; ")})` : "Sin datos para estimar los departamentos.", departamentos, "departamentos"),
  );
  const cp04: ItemCabida = {
    id: "CP-04",
    titulo: "Departamentos",
    estado: estado([e.constructibilidad, e.densidad], densidadFalta),
    resumen: departamentos !== null && manda !== null ? `${departamentos} departamentos; manda ${TOPES[manda]}.` : "Faltan datos para estimar los departamentos.",
    valor: departamentos,
    unidad: "departamentos",
    desarrollo: pasosDeptos,
    fuentes: presentes([e.densidad.fuente]),
    notas: [
      ...notasDe([["Densidad máxima", e.densidad]]),
      ...(dens !== null ? ["Densidad aplicada sobre la superficie del predio; si el CIP la fija como densidad bruta, la superficie de cálculo puede incluir parte del espacio público que enfrenta: verifíquelo."] : []),
      `Mezcla sugerida: ${F(e.mezcla[0])} % 1D, ${F(e.mezcla[1])} % 2D y ${F(e.mezcla[2])} % 3D (supuesto de diseño).`,
      ...(departamentos !== null && enterosPorPiso < departamentos
        ? [`Por piso caben ${enterosPorPiso} departamentos completos de ${F(e.m2Departamento)} m²: el total supone tamaños distintos según la mezcla (reparto proporcional a la superficie útil de cada piso).`]
        : []),
    ],
  };

  // --- CP-05 Pisos y tabla por piso ---
  const pasosPisos: PasoDesarrollo[] = [];
  if (porAlturaM !== null) {
    pasosPisos.push(paso("Pisos por altura", "Pisos = ⌊altura máxima ÷ piso a piso⌋", `= ⌊${F(e.alturaMetros.valor!)} m ÷ ${F(pp)} m⌋ = ⌊${F(e.alturaMetros.valor! / pp)}⌋`, porAlturaM, "pisos", [e.alturaMetros.fuente], [supuestoPp]));
  }
  if (porAlturaP !== null) pasosPisos.push(paso("Pisos de la norma", "Pisos = pisos máximos que fija la norma", `= ${porAlturaP}`, porAlturaP, "pisos", [e.alturaPisos.fuente]));
  if (porAltura === null) {
    pasosPisos.push(paso("Pisos por altura", "Pisos = ⌊altura máxima ÷ piso a piso⌋",
      e.alturaLibre ? "La ficha no fija altura máxima: la limitan las rasantes (calcule la cabida 3D)." : `= ⌊(altura máxima: ${DATO_FALTANTE}) ÷ ${F(pp)} m⌋`, null, "pisos", [], [supuestoPp]));
  }
  pasosPisos.push(paso("Pisos por constructibilidad", "Pisos = ⌈superficie construible ÷ ocupación máxima de primer piso⌉",
    porCoeficiente !== null ? `= ⌈${F(construible!)} m² ÷ ${F(ocupacion!)} m²⌉ = ⌈${F(construible! / ocupacion!)}⌉` : `= ⌈(${construible === null ? "superficie construible" : "ocupación de primer piso"}: ${DATO_FALTANTE})⌉`,
    porCoeficiente, "pisos", [], [supuestoPlanta]));
  if (vol !== null) {
    pasosPisos.push(paso("Pisos dentro del volumen teórico", "Pisos = pisos completos bajo la envolvente de altura, rasantes, distanciamientos y antejardín (cabida 3D)",
      `= ${vol.length} pisos de ${F(pp)} m con planta posible`, vol.length, "pisos", [], [supuestoPp]));
  }
  const terminos = [porAltura, porCoeficiente, vol !== null ? vol.length : null].filter((x): x is number => x !== null);
  pasosPisos.push(paso("Pisos", "Pisos = mín(por altura, por constructibilidad" + (vol !== null ? ", dentro del volumen" : "") + ")",
    terminos.length > 0 ? `= mín(${terminos.join("; ")})${numeroPisos !== null && numeroPisos !== Math.min(...terminos) ? ` → ${numeroPisos} con planta (la constructibilidad se agota antes)` : ""}` : "Sin datos para estimar los pisos.",
    numeroPisos, "pisos"));
  const pisosRevision = porAltura === null && vol === null;
  const notasPisos = notasDe([["Altura máxima", e.alturaMetros.origen !== "Faltante" ? e.alturaMetros : e.alturaPisos]]).filter((n) => !(e.alturaLibre && n.includes(DATO_FALTANTE)));
  if (e.alturaLibre && vol === null) notasPisos.push("La ficha no fija altura máxima: la limitan las rasantes. Calcule la cabida 3D para acotar los pisos.");
  if (pp < e.alturaMinimaPisoCielo.metros) notasPisos.push(`⚠ El piso a piso (${F(pp)} m) es menor que la altura mínima de piso a cielo de ${F(e.alturaMinimaPisoCielo.metros)} m.`);
  if (cabe !== null && construible !== null && cabe < construible - 0.01) {
    notasPisos.push(`${vol !== null ? "El volumen teórico" : "La altura"} limita: caben ${F(cabe)} m² de los ${F(construible)} m² construibles.`);
  }

  const utiles = plantas.map((p) => p * (1 - e.circulaciones));
  const porPiso = departamentos !== null ? repartir(departamentos, utiles) : plantas.map(() => 0);
  const pisos: PisoCabidaPreliminar[] = plantas.map((p, i) => {
    const [d1, d2, d3] = repartir(porPiso[i], e.mezcla);
    return { numero: i + 1, base: i * pp, top: (i + 1) * pp, superficie: p, util: utiles[i], departamentos: porPiso[i], mezcla: [d1, d2, d3] };
  });
  const cp05: ItemCabida = {
    id: "CP-05",
    titulo: "Pisos",
    estado: estado([e.constructibilidad, e.ocupacion], pisosRevision || e.alturaMetros.advertencia !== null),
    resumen: numeroPisos !== null && alturaEdificio !== null
      ? `${numeroPisos} piso${numeroPisos === 1 ? "" : "s"} de ${F(pp)} m (${F(alturaEdificio)} m), ${F(plantas.reduce((s, p) => s + p, 0))} m² en total.`
      : "Faltan datos para estimar los pisos.",
    valor: numeroPisos,
    unidad: "pisos",
    desarrollo: pasosPisos,
    fuentes: presentes([e.alturaMetros.fuente, e.alturaPisos.fuente, pp < e.alturaMinimaPisoCielo.metros ? e.alturaMinimaPisoCielo.fuente : null]),
    notas: notasPisos,
  };

  // --- CP-06 Estacionamientos ---
  const razon = e.razonEstacionamientos.valor;
  const estacionamientos = razon !== null && departamentos !== null ? techo(departamentos * razon) : null;
  const superficieEstacionamientos = estacionamientos !== null ? estacionamientos * e.m2Estacionamiento : null;
  const supuestoEst = `${F(e.m2Estacionamiento)} m² por estacionamiento con su circulación (supuesto editable).`;
  const cp06: ItemCabida = {
    id: "CP-06",
    titulo: "Estacionamientos",
    estado: estado([e.razonEstacionamientos], departamentos === null),
    resumen: estacionamientos !== null && superficieEstacionamientos !== null
      ? `${estacionamientos} estacionamientos, unos ${F(superficieEstacionamientos)} m².`
      : razon === null ? `Falta la razón de estacionamientos de la zona (${DATO_FALTANTE}).` : "Sin departamentos no se pueden estimar los estacionamientos.",
    valor: estacionamientos,
    unidad: "estacionamientos",
    desarrollo: [
      paso("Estacionamientos", "Estacionamientos = ⌈departamentos × estacionamientos por departamento⌉",
        razon !== null && departamentos !== null ? `= ⌈${departamentos} × ${F(razon, 4)}⌉ = ⌈${F(departamentos * razon)}⌉` : `= ⌈${departamentos ?? "departamentos"} × (razón de estacionamientos: ${razon === null ? DATO_FALTANTE : F(razon, 4)})⌉`,
        estacionamientos, "estacionamientos", [e.razonEstacionamientos.fuente]),
      paso("Superficie de estacionamientos", "Superficie = estacionamientos × m² por estacionamiento",
        estacionamientos !== null ? `= ${estacionamientos} × ${F(e.m2Estacionamiento)} m²` : `= (estacionamientos) × ${F(e.m2Estacionamiento)} m²`, superficieEstacionamientos, "m²", [], [supuestoEst]),
    ],
    fuentes: presentes([e.razonEstacionamientos.fuente]),
    notas: notasDe([["Razón de estacionamientos", e.razonEstacionamientos]]),
  };

  return {
    entrada: e,
    items: [cp01, cp02, cp03, cp04, cp05, cp06],
    tope: manda,
    pisos,
    restricciones: restricciones(e, alturaEdificio, numeroPisos),
    construible,
    ocupacion,
    util,
    departamentos,
    numeroPisos,
    alturaEdificio,
    estacionamientos,
    superficieEstacionamientos,
  };
}

/** Distanciamiento con o sin vano a la altura h (tabla del art. 2.6.3). */
export function distanciamiento(tabla: EntradaCabidaPreliminar["distanciamientos"]["tabla"], h: number, conVano: boolean): number {
  for (const row of tabla) if (row.upTo === null || h <= row.upTo) return conVano ? row.withOpening : row.withoutOpening;
  const last = tabla[tabla.length - 1];
  return conVano ? last.withOpening : last.withoutOpening;
}

function restricciones(e: EntradaCabidaPreliminar, alturaEdificio: number | null, numeroPisos: number | null): RestriccionCabida[] {
  const out: RestriccionCabida[] = [];
  const r = e.rasante;
  out.push(
    r.angulo !== null
      ? {
          id: "CR-01",
          titulo: "Rasantes",
          estado: r.advertencia ? "RevisionRequerida" : "Informativo",
          texto: `Rasante de ${F(r.angulo)}° (región de ${r.region}) levantada desde los deslindes con otros predios y desde el punto medio entre líneas oficiales del espacio público que enfrenta el predio (o desde el deslinde, si colinda con un área verde pública).${r.advertencia ? ` ${r.advertencia}` : ""}`,
          fuentes: r.fuentes,
        }
      : { id: "CR-01", titulo: "Rasantes", estado: "RevisionRequerida", texto: `La región ${r.region ?? "del predio"} no está en la tabla de ángulos de rasante: ${DATO_FALTANTE}.`, fuentes: r.fuentes },
  );

  const tabla = e.distanciamientos.tabla;
  const tramos = tabla.map((row, i) => (row.upTo !== null ? `hasta ${F(row.upTo)} m` : `sobre ${F(tabla[i - 1]?.upTo ?? 0)} m`));
  const sinVano = tabla.map((row) => F(row.withoutOpening)).join(" / ");
  const conVano = tabla.map((row) => F(row.withOpening)).join(" / ");
  const aplicado = alturaEdificio !== null && numeroPisos !== null
    ? ` Con ${numeroPisos} piso${numeroPisos === 1 ? "" : "s"} (${F(alturaEdificio)} m): ${F(distanciamiento(tabla, alturaEdificio, true))} m con vano y ${F(distanciamiento(tabla, alturaEdificio, false))} m sin vano.`
    : "";
  const a = e.adosamiento;
  out.push({
    id: "CR-02",
    titulo: "Distanciamientos y adosamientos",
    estado: "Informativo",
    texto:
      `Distanciamientos a los deslindes según la altura: ${sinVano} m sin vano y ${conVano} m con vano (${tramos.join(", ")}).${aplicado} ` +
      `Adosamiento: hasta el ${F(a.largoPct)} % del deslinde común, ${F(a.altura)} m de altura en el deslinde y dentro de ${F(a.angulo)}°; no puede ocupar el antejardín.`,
    fuentes: [e.distanciamientos.fuente, ...a.fuentes],
  });

  const y = e.antejardin;
  out.push(
    y.valor !== null
      ? {
          id: "CR-03",
          titulo: "Antejardín",
          estado: y.advertencia ? "RevisionRequerida" : "Informativo",
          texto: `Antejardín de ${F(y.valor)} m desde la línea oficial en cada frente (ficha de la zona ${e.zona ?? ""}).${y.advertencia ? ` ⚠ ${y.advertencia}` : ""}`,
          fuentes: presentes([y.fuente]),
        }
      : { id: "CR-03", titulo: "Antejardín", estado: "RevisionRequerida", texto: `La ficha de la zona no fija antejardín o no está cargada: ${DATO_FALTANTE}.`, fuentes: [] },
  );

  out.push({
    id: "CR-04",
    titulo: "Áreas verdes y cesiones",
    estado: "RevisionRequerida",
    texto: `La base normativa no tiene áreas verdes ni cesiones de la Ordenanza Local para esta zona: ${DATO_FALTANTE}.`,
    fuentes: [],
  });

  const razon = e.razonEstacionamientos;
  out.push(
    razon.valor !== null
      ? { id: "CR-05", titulo: "Estacionamientos de la zona", estado: "Informativo", texto: `${F(razon.valor, 4)} estacionamiento${razon.valor === 1 ? "" : "s"} por departamento, según el CIP indicado por el usuario.`, fuentes: presentes([razon.fuente]) }
      : { id: "CR-05", titulo: "Estacionamientos de la zona", estado: "RevisionRequerida", texto: `La base normativa no tiene el estándar de estacionamientos de la zona: ${DATO_FALTANTE}.`, fuentes: [] },
  );
  return out;
}

/** Origen de un dato para la tabla «Datos de entrada» del informe y de la pestaña. */
export const ORIGEN_LABELS: Record<DatoCabida["origen"], string> = {
  PRC: "PRC (ficha de la zona)",
  OGUC: "OGUC",
  CIP: "CIP (indicado por el usuario)",
  Supuesto: "Supuesto editable",
  Predio: "Polígono del predio",
  Cabida3D: "Cabida 3D",
  Faltante: "Falta (indíquelo desde el CIP)",
};

/** Entradas de la cabida con su valor y origen, en el orden del informe. */
export function datosDeEntrada(e: EntradaCabidaPreliminar): { label: string; value: string; origen: DatoCabida["origen"]; fuente: NormSource | null }[] {
  const dato = (label: string, d: DatoCabida, unidad: string, decimales = 2) => ({
    label,
    value: d.valor !== null ? `${F(d.valor, decimales)}${unidad}` : d.origen === "Faltante" ? DATO_FALTANTE : "—",
    origen: d.origen,
    fuente: d.fuente,
  });
  const supuesto = (label: string, value: string) => ({ label, value, origen: "Supuesto" as const, fuente: null });
  return [
    { label: "Superficie del predio", value: `${F(e.superficiePredio)} m²`, origen: "Predio", fuente: null },
    { label: "Zona del PRC", value: e.zona ?? "sin zona con normas", origen: e.zona ? "PRC" : "Faltante", fuente: null },
    dato("Coeficiente de ocupación de suelo", e.ocupacion, "", 4),
    dato("Coeficiente de constructibilidad", e.constructibilidad, "", 4),
    e.alturaLibre ? { label: "Altura máxima", value: "sin tope en la ficha (la limitan las rasantes)", origen: "PRC", fuente: null } : dato("Altura máxima", e.alturaMetros, " m"),
    // Si la norma fija la altura solo en metros, que no traiga pisos no es un dato faltante.
    e.alturaPisos.origen === "Faltante" && e.alturaMetros.valor !== null
      ? { label: "Pisos máximos", value: "no los fija (rige la altura en metros)", origen: e.alturaMetros.origen, fuente: null }
      : dato("Pisos máximos", e.alturaPisos, " pisos", 0),
    e.densidadLibre ? { label: "Densidad máxima", value: "libre (la Ordenanza no la fija)", origen: "CIP", fuente: e.densidad.fuente } : dato("Densidad máxima", e.densidad, " hab/ha"),
    dato("Antejardín", e.antejardin, " m"),
    dato("Estacionamientos por departamento", e.razonEstacionamientos, "", 4),
    { label: "Ángulo de rasante", value: e.rasante.angulo !== null ? `${F(e.rasante.angulo)}° (región de ${e.rasante.region})` : DATO_FALTANTE, origen: e.rasante.angulo !== null ? "OGUC" : "Faltante", fuente: e.rasante.fuentes[0] ?? null },
    supuesto("Piso a piso", `${F(e.pisoAPiso)} m (supuesto de diseño)`),
    supuesto("m² útiles promedio por departamento", `${F(e.m2Departamento)} m² (supuesto de diseño)`),
    supuesto("Mezcla 1D / 2D / 3D", `${F(e.mezcla[0])} / ${F(e.mezcla[1])} / ${F(e.mezcla[2])} %`),
    supuesto("Circulaciones y muros", `${F(e.circulaciones * 100, 1)} %`),
    supuesto("Habitantes por vivienda", F(e.habPorVivienda)),
    supuesto("m² por estacionamiento", `${F(e.m2Estacionamiento)} m²`),
    ...(e.volumen !== null ? [{ label: "Volumen teórico", value: `${e.volumen.length} pisos con planta en la cabida 3D`, origen: "Cabida3D" as const, fuente: null }] : []),
  ];
}
