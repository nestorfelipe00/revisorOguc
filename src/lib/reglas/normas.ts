// Porte de Infrastructure/Rules/NormCatalog.cs: normas verificadas que usa el motor geométrico, OGUC (normas/oguc/geometria.json)
// y Ordenanza Local (normas/<comuna>/normas_zonas.json). Solo contiene cifras extraídas de los textos oficiales.
import type { NormSource } from "./tipos";

/**
 * Cifra de la ficha que el motor no puede aplicar con certeza (remisión dudosa, cifra por piso, rasante propia…).
 * field: altura, rasante, antejardin, ocupacion, constructibilidad, superficie, agrupamiento o zona (todas).
 */
export interface ZoneWarning {
  field: string;
  text: string;
}

/** Normas urbanísticas de una zona del PRC (ficha de la Ordenanza Local), con el texto literal de cada cifra. */
export interface ZoneNorms {
  zone: string;
  page: number;
  section: string;
  maxHeight: number | null;
  maxFloors: number | null;
  heightText: string | null;
  frontYard: number | null;
  frontYardText: string | null;
  landCoverage: number | null;
  landCoverageText: string | null;
  floorAreaRatio: number | null;
  floorAreaRatioText: string | null;
  grouping: string[];
  groupingText: string | null;
  minLotArea: number | null;
  minLotAreaText: string | null;
  warnings: ZoneWarning[];
  /** Altura que permite un incentivo condicionado (Art. 184 LGUC); entre la altura base y esta, la regla queda en revisión. */
  incentiveHeight: number | null;
  /** La Ordenanza no fija altura máxima («libre según rasante», ficha con altura «sin tope»): la limitan las rasantes. */
  heightFree: boolean;
  incentiveText: string | null;
  incentivePage: number | null;
  /**
   * Ocupación de suelo y constructibilidad condicionadas: la cifra base es la más estricta; la Ordenanza permite hasta el máximo si el
   * proyecto cumple la condición (destino, fusión, incentivo…). Entre ambas, la regla queda en revisión.
   */
  landCoverageMax: number | null;
  landCoverageCondition: string | null;
  floorAreaRatioMax: number | null;
  floorAreaRatioCondition: string | null;
  /** Ángulo de rasante que fija la propia ficha (el motor lo compara con el de la región). */
  rasanteDegrees: number | null;
  rasanteText: string | null;
  /** Documento que fija la ficha cuando no es la Ordenanza base (zona creada o reemplazada por una modificación publicada aparte). */
  document: string | null;
  documentUrl: string | null;
}

/** Fila de la tabla de distanciamientos del art. 2.6.3 (null en upTo = sobre el tramo anterior). */
export interface SetbackRow {
  upTo: number | null;
  withOpening: number;
  withoutOpening: number;
}

/** Fila de la tabla de distancia a la línea de edificación para adosamientos de ampliaciones (Ordenanza Local). */
export interface ExtensionAdosamientoRow {
  upTo: number | null;
  distance: number;
}

// ---------- Lectura estricta del JSON (equivalente a JsonElement.GetProperty / TryGetProperty) ----------

type JsonObject = Record<string, unknown>;

const isObject = (v: unknown): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);

function property(e: JsonObject, name: string): unknown {
  if (!(name in e)) throw new Error(`Falta la propiedad «${name}» en el JSON de normas.`);
  return e[name];
}

function object(e: JsonObject, name: string): JsonObject {
  const v = property(e, name);
  if (!isObject(v)) throw new Error(`La propiedad «${name}» del JSON de normas no es un objeto.`);
  return v;
}

function string(e: JsonObject, name: string): string {
  const v = property(e, name);
  if (typeof v !== "string") throw new Error(`La propiedad «${name}» del JSON de normas no es texto.`);
  return v;
}

function number(e: JsonObject, name: string): number {
  const v = property(e, name);
  if (typeof v !== "number") throw new Error(`La propiedad «${name}» del JSON de normas no es un número.`);
  return v;
}

function integer(e: JsonObject, name: string): number {
  return Math.trunc(number(e, name));
}

function array(e: JsonObject, name: string): unknown[] {
  const v = property(e, name);
  if (!Array.isArray(v)) throw new Error(`La propiedad «${name}» del JSON de normas no es una lista.`);
  return v;
}

const objects = (list: unknown[], what: string): JsonObject[] =>
  list.map((item) => {
    if (!isObject(item)) throw new Error(`Un elemento de «${what}» del JSON de normas no es un objeto.`);
    return item;
  });

/** Número opcional (TryGetProperty con ValueKind.Number). */
const optionalNumber = (e: JsonObject, name: string): number | null => (typeof e[name] === "number" ? (e[name] as number) : null);

/** Texto opcional (TryGetProperty con ValueKind.String). */
const optionalText = (e: JsonObject, name: string): string | null => (typeof e[name] === "string" ? (e[name] as string) : null);

const optionalInteger = (e: JsonObject, name: string): number | null => {
  const n = optionalNumber(e, name);
  return n === null ? null : Math.trunc(n);
};

/**
 * Código de zona comparable entre la Ordenanza y las capas GIS: mayúsculas, sin espacios ni guiones entre letra y número
 * (ZU-1A = ZU1A, ZCH 2 = ZCH2, ZU5-A = ZU5A); el guion entre números se conserva (ZU4-1 ≠ ZU41).
 */
export const zoneKey = (code: string): string => code.toUpperCase().replace(/\s+/g, "").replace(/(?<=[A-Z])-(?=\d)|(?<=\d)-(?=[A-Z])/g, "");

export class NormCatalog {
  private readonly anglesByRegion = new Map<string, number>();
  private readonly zones = new Map<string, ZoneNorms>();

  readonly ogucDocument: string;
  readonly ogucVersion: string;
  readonly ogucUrl: string;
  readonly localDocument: string | null = null;
  readonly localUrl: string | null = null;

  readonly maxFrontWidth: number;
  readonly rasante: NormSource;
  readonly rasanteTable: NormSource;
  readonly rasanteLevel: NormSource;
  readonly setbacks: SetbackRow[];
  readonly setbackSource: NormSource;
  readonly adosamientoLengthPercent: number;
  readonly adosamientoHeight: number;
  readonly adosamientoAngle: number;
  readonly adosamientoSources: NormSource[];
  readonly adosamientoWall: NormSource;
  readonly adosamientoExemption: NormSource;
  readonly adosamientoRoofWall: NormSource;
  readonly adosamientoRain: NormSource;
  readonly adosamientoWallHeight: number;
  readonly adosamientoFireMinutes: number;
  readonly groupingTypes: NormSource;
  readonly pairedSimultaneous: NormSource;
  readonly continuityException: NormSource;
  readonly groupingFree: NormSource;
  readonly continuityExceptionFraction: number;
  readonly multiZoneEach: NormSource;
  readonly multiZoneAverage: NormSource;
  readonly multiZoneHeights: NormSource;
  readonly minCeilingHeight: number;
  readonly minCeilingSource: NormSource;
  readonly roofElements: NormSource;
  readonly definitions: ReadonlyMap<string, NormSource>;
  readonly extensionAdosamiento: NormSource | null = null;
  readonly extensionAdosamientoTable: ExtensionAdosamientoRow[] = [];
  readonly projectionMax: number = 0;
  readonly projections: NormSource | null = null;
  readonly projectionsFirstFloor: NormSource | null = null;
  readonly projectionsUpper: NormSource | null = null;
  readonly projectionsZpt: NormSource | null = null;
  readonly projectionLengthFraction: number = 0;
  readonly projectionMinHeight: number = 0;
  readonly projectionsReviewOnly: boolean = false;
  readonly publicUse: NormSource | null = null;
  readonly frontYardBuildable: NormSource | null = null;
  /** Prefijo de las zonas cuyos cuerpos salientes se rigen por un Plano de Detalle (La Serena: ZPT); null si no hay. */
  readonly detailPlanZonePrefix: string | null = null;

  /** oguc y local son los JSON ya parseados (local null si la comuna no tiene Ordenanza incorporada). */
  constructor(ogucJson: unknown, localJson: unknown | null) {
    if (!isObject(ogucJson)) throw new Error("El JSON de la OGUC (normas/oguc/geometria.json) no es un objeto.");
    const oguc = ogucJson;
    this.ogucDocument = string(oguc, "documento");
    this.ogucVersion = string(oguc, "version");
    this.ogucUrl = string(oguc, "url");

    const rasantes = object(oguc, "rasantes");
    for (const row of objects(array(rasantes, "angulos"), "angulos")) {
      const angle = number(row, "angulo_grados");
      for (const region of array(row, "regiones")) {
        if (typeof region !== "string") throw new Error("Una región de la tabla de rasantes no es texto.");
        this.anglesByRegion.set(region.toLowerCase(), angle);
      }
    }
    this.maxFrontWidth = number(rasantes, "ancho_maximo_frente_m");
    this.rasante = this.source("Art. 2.6.3", `${string(rasantes, "aplicacion")}. ${string(rasantes, "area_verde")}. ${string(rasantes, "sin_rasante_frente")}.`);
    this.rasanteTable = this.source("Art. 2.6.3, inciso sexto", string(object(rasantes, "tabla_imagen"), "nota"));
    this.rasanteLevel = this.source("Art. 2.6.3", string(rasantes, "nivel"));

    const setbacks = object(oguc, "distanciamientos");
    this.setbacks = objects(array(setbacks, "tabla"), "tabla").map((r) => ({
      upTo: optionalNumber(r, "hasta_m"),
      withOpening: number(r, "con_vano_m"),
      withoutOpening: number(r, "sin_vano_m"),
    }));
    this.setbackSource = this.source(
      "Art. 2.6.3",
      `Altura de la edificación / Fachada con vano / Fachada sin vano: ${string(setbacks, "texto")}. ${string(setbacks, "tramos")}`,
    );

    const ado = object(oguc, "adosamiento");
    this.adosamientoLengthPercent = number(ado, "largo_maximo_pct");
    this.adosamientoHeight = number(ado, "altura_deslinde_m");
    this.adosamientoAngle = number(ado, "angulo_grados");
    this.adosamientoSources = [
      this.source("Art. 2.6.2 N° 1", string(ado, "largo")),
      this.source("Art. 2.6.2 N° 2", string(ado, "altura")),
      this.source("Art. 2.6.2 N° 3", string(ado, "angulo")),
      this.source("Art. 2.6.2 N° 1", string(ado, "antejardin")),
    ];
    this.adosamientoWall = this.source("Art. 2.6.2", string(ado, "muro"));
    this.adosamientoExemption = this.source("Art. 2.6.2", string(ado, "exencion"));
    this.adosamientoRoofWall = this.source("Art. 2.6.2", string(ado, "muro_cubierta"));
    this.adosamientoRain = this.source("Art. 2.6.2", string(ado, "aguas_lluvia"));
    this.adosamientoWallHeight = number(ado, "muro_minimo_m");
    this.adosamientoFireMinutes = Number.parseInt(string(ado, "resistencia_fuego").replace(/\D/g, ""), 10);

    const grouping = object(oguc, "agrupamiento");
    this.groupingTypes = this.source("Art. 2.6.1", string(grouping, "tipos"));
    this.pairedSimultaneous = this.source("Art. 2.6.1", string(grouping, "pareo_simultaneo"));
    this.continuityException = this.source("Art. 2.6.1", string(grouping, "continuidad"));
    this.groupingFree = this.source("Art. 2.6.1", string(grouping, "libre"));
    this.continuityExceptionFraction = number(grouping, "excepcion_continuidad_fraccion");

    const zones = object(oguc, "zonas_multiples");
    this.multiZoneEach = this.source("Art. 2.1.21", string(zones, "cada_zona"));
    this.multiZoneAverage = this.source("Art. 2.1.21", `${string(zones, "promedio")}. ${string(zones, "sin_limite")}.`);
    this.multiZoneHeights = this.source("Art. 2.1.21", string(zones, "alturas"));

    const habitability = object(oguc, "habitabilidad");
    this.minCeilingHeight = number(habitability, "altura_piso_cielo_m");
    this.minCeilingSource = this.source("Art. 4.1.1", string(habitability, "altura_piso_cielo"));
    this.roofElements = this.source("Art. 2.6.3", string(oguc, "altura_elementos_azotea"));
    const definitions = new Map<string, NormSource>();
    for (const [name, value] of Object.entries(object(oguc, "definiciones"))) {
      if (typeof value !== "string") throw new Error(`La definición «${name}» no es texto.`);
      definitions.set(name, this.source("Art. 1.1.2", `«${name}»: ${value}`));
    }
    this.definitions = definitions;

    if (localJson !== null && localJson !== undefined) {
      if (!isObject(localJson)) throw new Error("El JSON de la Ordenanza Local (normas_zonas.json) no es un objeto.");
      const l = localJson;
      this.localDocument = optionalText(l, "documento");
      this.localUrl = optionalText(l, "url");
      for (const z of objects(array(l, "zonas"), "zonas")) {
        const warnings = Array.isArray(z.advertencias)
          ? objects(z.advertencias, "advertencias").map((x) => ({ field: string(x, "campo"), text: string(x, "texto") }))
          : [];
        const zone: ZoneNorms = {
          zone: string(z, "zona"),
          page: integer(z, "pagina"),
          section: string(z, "seccion"),
          maxHeight: optionalNumber(z, "altura_m"),
          maxFloors: optionalInteger(z, "pisos"),
          heightText: optionalText(z, "altura_texto") ?? optionalText(z, "altura_m_texto"),
          frontYard: optionalNumber(z, "antejardin_m"),
          frontYardText: optionalText(z, "antejardin_m_texto"),
          landCoverage: optionalNumber(z, "coef_ocupacion_suelo"),
          landCoverageText: optionalText(z, "coef_ocupacion_suelo_texto"),
          floorAreaRatio: optionalNumber(z, "coef_constructibilidad"),
          floorAreaRatioText: optionalText(z, "coef_constructibilidad_texto"),
          grouping: Array.isArray(z.agrupamiento) ? z.agrupamiento.map((x) => String(x)) : [],
          groupingText: optionalText(z, "agrupamiento_texto"),
          minLotArea: optionalNumber(z, "superficie_predial_minima_m2"),
          minLotAreaText: optionalText(z, "superficie_predial_minima_m2_texto"),
          warnings,
          // «sin tope»: sobre la altura base solo limitan las rasantes (p. ej. edificación aislada sobre la continua).
          incentiveHeight: optionalText(z, "altura_incentivo_m") === "sin tope" ? Number.POSITIVE_INFINITY : optionalNumber(z, "altura_incentivo_m"),
          heightFree: optionalText(z, "altura_m") === "sin tope",
          landCoverageMax: optionalNumber(z, "coef_ocupacion_suelo_max"),
          landCoverageCondition: optionalText(z, "coef_ocupacion_suelo_condicion"),
          floorAreaRatioMax: optionalNumber(z, "coef_constructibilidad_max"),
          floorAreaRatioCondition: optionalText(z, "coef_constructibilidad_condicion"),
          incentiveText: optionalText(z, "incentivo_texto"),
          incentivePage: optionalInteger(z, "incentivo_pagina"),
          rasanteDegrees: optionalNumber(z, "rasante_grados"),
          rasanteText: optionalText(z, "rasante_texto"),
          document: optionalText(z, "documento"),
          documentUrl: optionalText(z, "url"),
        };
        this.zones.set(zoneKey(zone.zone), zone);
      }
      // Disposiciones generales de la Ordenanza que el motor usa si la comuna las tiene (cada comuna redacta las suyas).
      if (isObject(l.adosamiento_ampliaciones)) {
        const art5 = l.adosamiento_ampliaciones;
        this.extensionAdosamiento = this.localSource(optionalText(art5, "articulo") ?? "Ordenanza Local", string(art5, "texto"), integer(art5, "pagina"));
        this.extensionAdosamientoTable = objects(array(art5, "tabla"), "tabla").map((r) => ({
          upTo: optionalNumber(r, "antejardin_hasta_m"),
          distance: number(r, "distancia_linea_edificacion_m"),
        }));
      }
      if (isObject(l.cuerpos_salientes)) {
        const projections = l.cuerpos_salientes;
        const article = optionalText(projections, "articulo") ?? "Ordenanza Local";
        const page = integer(projections, "pagina");
        this.projectionMax = number(projections, "saliente_max_m");
        this.projections = this.localSource(article, string(projections, "texto"), page);
        // Ordenanzas que distinguen el 1° piso (letra a) de los pisos superiores (letra b), como La Serena.
        const first = optionalText(projections, "primer_piso");
        if (first !== null) this.projectionsFirstFloor = this.localSource(`${article} a)`, first, page);
        const upper = optionalText(projections, "pisos_superiores");
        if (upper !== null) this.projectionsUpper = this.localSource(`${article} b)`, upper, page);
        const detail = optionalText(projections, "zonas_zpt");
        if (detail !== null) {
          this.projectionsZpt = this.localSource(article, detail, page);
          this.detailPlanZonePrefix = optionalText(projections, "zonas_plano_detalle_prefijo") ?? (/Zonas\s+([A-Z]+)/.exec(detail)?.[1] ?? "");
        }
        this.projectionLengthFraction = optionalNumber(projections, "longitud_max_fraccion_fachada") ?? 0;
        this.projectionMinHeight = optionalNumber(projections, "altura_min_sobre_antejardin_m") ?? optionalNumber(projections, "altura_min_m") ?? 0;
        // La Ordenanza admite cuerpos salientes hasta la cifra pero no dice desde qué altura: se revisan, no se dan por buenos.
        this.projectionsReviewOnly = projections.solo_revision === true;
      }
      if (isObject(l.afectaciones)) {
        const art18 = l.afectaciones;
        this.publicUse = this.localSource(string(art18, "articulo"), string(art18, "texto"), integer(art18, "pagina"));
      }
      const yard = l.antejardin_edificable;
      if (typeof yard === "string") {
        this.frontYardBuildable = this.localSource(yard.split(":")[0], yard, null);
      } else if (isObject(yard)) {
        this.frontYardBuildable = this.localSource(optionalText(yard, "articulo") ?? "Ordenanza Local", string(yard, "texto"), optionalInteger(yard, "pagina"));
      }
    }
  }

  /** Ángulo de rasante de la región (tabla del art. 2.6.3); null si la región no está en la tabla. */
  rasanteAngle(region: string | null | undefined): number | null {
    if (region === null || region === undefined) return null;
    return this.anglesByRegion.get(region.toLowerCase()) ?? null;
  }

  zone(code: string | null | undefined): ZoneNorms | null {
    if (code === null || code === undefined) return null;
    return this.zones.get(zoneKey(code)) ?? null;
  }

  /** Distanciamiento exigido a la altura height (m sobre el suelo natural). */
  requiredSetback(height: number, withOpening: boolean): number {
    for (const row of this.setbacks) {
      if (row.upTo === null || height <= row.upTo) return withOpening ? row.withOpening : row.withoutOpening;
    }
    const last = this.setbacks[this.setbacks.length - 1];
    return withOpening ? last.withOpening : last.withoutOpening;
  }

  zoneSource(zone: ZoneNorms, text: string): NormSource {
    return zone.document !== null
      ? { document: zone.document, article: `${zone.section}, ficha ${zone.zone}`, quote: text, version: null, url: zone.documentUrl, page: zone.page > 0 ? zone.page : null }
      : this.localSource(`${zone.section}, ficha ${zone.zone}`, text, zone.page > 0 ? zone.page : null);
  }

  /** Incentivo de altura de la zona (Art. 184 LGUC), si la Ordenanza lo fija. */
  incentiveSource(zone: ZoneNorms): NormSource | null {
    if (zone.incentiveText === null) return null;
    const page = zone.incentivePage ?? zone.page;
    return this.localSource(`${zone.section}, ficha ${zone.zone}: incentivo`, zone.incentiveText, page > 0 ? page : null);
  }

  private source(article: string, quote: string): NormSource {
    return { document: this.ogucDocument, article, quote, version: this.ogucVersion, url: this.ogucUrl, page: null };
  }

  private localSource(article: string, quote: string, page: number | null): NormSource {
    return { document: this.localDocument ?? "Ordenanza Local", article, quote, version: null, url: this.localUrl, page };
  }
}

/**
 * Carga la OGUC y, si existe, la Ordenanza Local de la comuna, con rutas relativas a la raíz pública (normas/oguc/geometria.json y
 * normas/<carpeta>/normas_zonas.json). fetchJson debe resolver null cuando el recurso no existe (404); otros errores se propagan.
 */
export async function cargarNormas(fetchJson: (ruta: string) => Promise<unknown>, carpetaComuna: string | null): Promise<NormCatalog> {
  const oguc = await fetchJson("normas/oguc/geometria.json");
  if (oguc === null || oguc === undefined) throw new Error("No se encontró la OGUC verificada (normas/oguc/geometria.json).");
  let local: unknown | null = null;
  if (carpetaComuna !== null) {
    if (!/^[a-z0-9-]+$/i.test(carpetaComuna)) throw new Error(`Carpeta de comuna no válida: «${carpetaComuna}».`);
    local = (await fetchJson(`normas/${carpetaComuna}/normas_zonas.json`)) ?? null;
  }
  return new NormCatalog(oguc, local);
}
