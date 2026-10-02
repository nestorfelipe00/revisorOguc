// Porte fiel de Infrastructure/Rules/GeometricRuleEngine.cs: evalúa las reglas geométricas R-01 a R-11 (SRS-NOR-001) sobre la
// geometría del IFC y el predio, con las cifras del NormCatalog. Todas las distancias se miden en planta contra los segmentos reales
// de los deslindes. Sin DOM: corre en un Web Worker y en Node. Geometría con jsts (el mismo JTS que NetTopologySuite).
import type { NormCatalog, ZoneNorms } from "./normas";
import {
  coordinate, isTopologyException, lineOf, pointOf, polygonOf, prepare, readGeoJson, unionAll,
  type Coordinate, type Geometry, type PointInArea, type Polygon,
} from "./jsts";
import {
  fireRatingKey, isOpening, isVoid,
  type ElementFinding, type ElementGeometry, type NormSource, type ParcelEdge, type RasanteGeometry, type RasanteLine, type RasanteSection,
  type RuleEvaluation, type RuleInput, type RuleResult, type RuleState, type SectionBlock, type TheoreticalVolume,
} from "./tipos";

const TOLERANCE = 0.01;
/** Distancia bajo la cual un punto se considera en el deslinde («contigua a los deslindes»). */
const CONTACT_DISTANCE = 0.1;
/** Franja detrás de la línea de edificación donde se mide el largo de la fachada. */
const FACADE_BAND = 1.0;

// Elementos que el art. 2.6.3 permite sobre la altura máxima (hasta el 25 % de la azotea) si cumplen rasantes.
const ROOF_EQUIPMENT = new Set([
  "IfcChimney", "IfcFlowTerminal", "IfcUnitaryEquipment", "IfcTank", "IfcSolarDevice", "IfcFan", "IfcAirTerminal", "IfcDistributionElement",
  "IfcFlowMovingDevice", "IfcEnergyConversionDevice", "IfcRailing",
]);

/** Clases que forman un volumen cerrado: sobre el 1° piso no son balcones (Art. 6º b de la Ordenanza Local). */
const ENCLOSING_CLASSES = new Set([
  "IfcWall", "IfcWallStandardCase", "IfcCurtainWall", "IfcWindow", "IfcWindowStandardCase", "IfcDoor", "IfcDoorStandardCase", "IfcRoof",
]);

// ---------- Formato (Math.Round de .NET redondea al par; "0.##" en es-CL) ----------

/** Math.Round(value, decimals) de .NET: redondeo a la mitad par sobre el valor escalado. */
export function roundEven(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  const scaled = value * factor;
  const floor = Math.floor(scaled);
  const diff = scaled - floor;
  const rounded = diff < 0.5 ? floor : diff > 0.5 ? floor + 1 : floor % 2 === 0 ? floor : floor + 1;
  return rounded / factor;
}

/** Math.Round(value, decimals).ToString("0.##", es-CL): coma decimal, sin separador de miles, hasta dos decimales. */
export const F = (value: number, decimals = 2): string =>
  roundEven(value, decimals).toLocaleString("es-CL", { minimumFractionDigits: 0, maximumFractionDigits: 2, useGrouping: false });

// ---------- Estructuras internas ----------

/** Deslinde del anillo antihorario; number es su número en el predio (1 = primero, como en la ventana Deslindes). */
interface Edge {
  a: Coordinate;
  b: Coordinate;
  info: ParcelEdge;
  length: number;
  nx: number;
  ny: number;
  number: number;
}

/** Parte del predio en una zona (art. 2.1.21). */
interface Part {
  code: string | null;
  norms: ZoneNorms | null;
  area: Geometry;
  prepared: PointInArea;
  areaM2: number;
}

class ElementTrack {
  maxHeight = Number.NEGATIVE_INFINITY;
  heightExcess = Number.NEGATIVE_INFINITY;
  heightZone = 0;
  readonly zones = new Set<number>();
  rasanteExcess = 0;
  setbackDeficit = 0;
  setbackDetail: string | null = null;
  openingUnknown = false;
  frontIntrusion = 0;
  yardFront = -1;
  yardT0 = Number.POSITIVE_INFINITY;
  yardT1 = Number.NEGATIVE_INFINITY;
  extensionDeficit = 0;
  adosado = false;
  private footprintGeometry: Geometry | null | undefined;

  constructor(readonly modelId: string, readonly element: ElementGeometry) {}

  /** Huella en planta como geometría jsts (null si no tiene o no se puede leer). */
  get footprint(): Geometry | null {
    if (this.footprintGeometry === undefined) {
      try {
        this.footprintGeometry = this.element.footprint === null ? null : readGeoJson(this.element.footprint);
      } catch {
        this.footprintGeometry = null;
      }
    }
    return this.footprintGeometry;
  }
}

/** Lo que toca cada deslinde con vecino: cuerpos sobre la altura de adosamiento (pareo o continuidad) y muros en el deslinde. */
class EdgeContact {
  pareoHeight = Number.NEGATIVE_INFINITY;
  readonly tall = new Set<ElementTrack>();
  readonly walls = new Map<ElementTrack, [number, number]>();
  bodyHeight = 0;
}

interface StoreyArea {
  name: string;
  elevation: number;
  area: number;
  filled: Geometry;
}

interface GroupingResult {
  type: string | null;
  contact: number[];
  detail: string;
}

type Span = [number, number];

interface Line {
  a: Coordinate;
  b: Coordinate;
}

const code = (p: Part): string => p.code ?? "";

/** Qué cifras de la ficha usa cada regla (las advertencias «zona» afectan a todas las que usan la ficha). */
const WARNING_FIELDS: Record<string, string[]> = {
  "R-01": ["altura", "zona"],
  "R-02": ["rasante"],
  "R-03": ["distanciamiento"],
  "R-05": ["antejardin", "zona"],
  "R-06": ["ocupacion", "zona"],
  "R-07": ["constructibilidad", "zona"],
  "R-08": ["altura", "rasante", "antejardin", "zona"],
  "R-09": ["superficie", "zona"],
  "R-10": ["agrupamiento", "zona"],
};

export class GeometricRuleEngine {
  constructor(private readonly norms: NormCatalog) {}

  evaluate(input: RuleInput): RuleEvaluation {
    const norms = this.norms;
    const { ring, infos, numbers } = counterClockwise(input.lotRing.map((p) => coordinate(p.x, p.y)), input.edges);
    const lot = polygonOf([...ring, ring[0]]);
    const lotArea = lot.getArea();
    const edges: Edge[] = ring.map((a, i) => {
      const b = ring[(i + 1) % ring.length];
      const length = Math.sqrt((b.x - a.x) * (b.x - a.x) + (b.y - a.y) * (b.y - a.y));
      return { a, b, info: infos[i], length, nx: (b.y - a.y) / length, ny: -(b.x - a.x) / length, number: numbers[i] };
    });
    const ground = input.groundZ;
    const parts = this.zoneParts(input, lot, lotArea);
    const principal = parts[0];
    const zone = principal.norms;
    const angle = norms.rasanteAngle(input.region);
    const tan = angle !== null ? Math.tan((angle * Math.PI) / 180) : Number.NaN;
    const neighbours = edges.filter((e) => e.info.kind === "Vecino");
    const fronts = edges.filter((e) => e.info.kind === "Frente");

    const commonNotes: string[] = [];
    if (!input.groundConfirmed) commonNotes.push(`Supuesto: suelo natural horizontal a Z = ${F(ground)} m del modelo (sin levantamiento confirmado).`);
    if (!input.positionConfirmed) commonNotes.push("Supuesto: la posición del modelo en el predio es aproximada (colocación sin georreferencia verificada).");
    if (parts.length > 1) {
      commonNotes.push(
        "El predio abarca las zonas " + parts.map((p) => `${code(p)} (${F((p.areaM2 / lotArea) * 100, 1)} %)`).join(", ") +
          ": cada parte se revisa con las normas de su zona (art. 2.1.21).",
      );
    }

    const tracks = input.models.flatMap((m) => m.elements.map((e) => new ElementTrack(m.modelId, e)));

    // --- Contactos con los deslindes (agrupamiento, R-10, y muro de adosamiento, R-04) -------------
    const contacts = neighbours.map(() => new EdgeContact());
    for (const track of tracks) {
      const element = track.element;
      if (isVoid(element) || neighbours.length === 0) continue;
      const isWall = element.ifcClass.startsWith("IfcWall");
      const p = element.points;
      for (let i = 0; i + 2 < p.length; i += 3) {
        const x = p[i];
        const y = p[i + 1];
        const h = p[i + 2] - ground;
        if (h <= TOLERANCE) continue;
        const [dn, k] = nearest(x, y, neighbours);
        if (dn > CONTACT_DISTANCE) continue;
        const c = contacts[k];
        c.bodyHeight = Math.max(c.bodyHeight, h);
        if (h > norms.adosamientoHeight + TOLERANCE) {
          c.pareoHeight = Math.max(c.pareoHeight, h);
          c.tall.add(track);
        }
        if (isWall) {
          const t = projection(x, y, neighbours[k]);
          const r = c.walls.get(track);
          c.walls.set(track, r ? [Math.min(r[0], t), Math.max(r[1], t)] : [t, t]);
        }
      }
    }
    const grouping = classify(neighbours, fronts, contacts);
    // En la edificación pareada o continua, el cuerpo que está en el deslinde no se revisa con rasantes ni distanciamientos
    // desde ese deslinde hasta su altura: solo las partes aisladas (art. 2.6.3, ámbito; definición de edificación pareada).
    const pareo = contacts.map((c) => (grouping.type === "pareado" || grouping.type === "continuo" ? c.pareoHeight : Number.NEGATIVE_INFINITY));
    const excluded = (k: number, h: number): boolean => k >= 0 && pareo[k] >= h - TOLERANCE;
    const pareoNotes = neighbours
      .map((e, k) => ({ e, k }))
      .filter((x) => pareo[x.k] > Number.NEGATIVE_INFINITY)
      .map(
        (x) =>
          `Deslinde ${x.e.number}: cuerpo ${grouping.type === "pareado" ? "pareado" : "continuo"} de ${F(pareo[x.k])} m; hasta esa altura no se aplican rasantes ni distanciamientos desde ese deslinde.`,
      );

    // Fuentes de rasante: deslindes con vecinos y áreas verdes; en frentes, la línea media entre líneas oficiales.
    const rasanteLines: Line[] = [];
    const rasanteNeighbour: number[] = [];
    const rasanteInfo: RasanteLine[] = [];
    const rasanteNotes: string[] = [];
    let frontsWithoutWidth = 0;
    for (const e of edges) {
      const kind = e.info.kind;
      if (kind === "Vecino" || kind === "AreaVerde") {
        rasanteLines.push({ a: e.a, b: e.b });
        rasanteNeighbour.push(neighbours.indexOf(e));
        rasanteInfo.push({ number: e.number, kind, ax: e.a.x, ay: e.a.y, bx: e.b.x, by: e.b.y, offset: 0, inwardX: -e.nx, inwardY: -e.ny });
      } else if (kind === "Frente") {
        const width = e.info.officialLinesWidth ?? null;
        if (width === null) {
          frontsWithoutWidth++;
          rasanteNotes.push(`Frente de ${F(e.length)} m sin ancho entre líneas oficiales: no se aplicó su rasante (dato del CIP).`);
        } else if (width > norms.maxFrontWidth) {
          rasanteNotes.push(`Frente con ${F(width)} m entre líneas oficiales (> ${F(norms.maxFrontWidth)} m): sin rasante en ese frente.`);
        } else {
          const off = width / 2;
          const a = coordinate(e.a.x + e.nx * off, e.a.y + e.ny * off);
          const b = coordinate(e.b.x + e.nx * off, e.b.y + e.ny * off);
          rasanteLines.push({ a, b });
          rasanteNeighbour.push(-1);
          rasanteInfo.push({ number: e.number, kind, ax: a.x, ay: a.y, bx: b.x, by: b.y, offset: off, inwardX: -e.nx, inwardY: -e.ny });
        }
      }
    }

    // Antejardín: franja entre el deslinde de frente (línea oficial) y la línea de edificación, con la profundidad de cada zona.
    let yard: Geometry | null = null;
    if (fronts.length > 0) {
      const pieces: Geometry[] = [];
      for (const part of parts) {
        const depth = part.norms?.frontYard ?? null;
        if (depth === null || !(depth > 0)) continue;
        const strips = fronts.map((e) =>
          polygonOf([e.a, e.b, coordinate(e.b.x - e.nx * depth, e.b.y - e.ny * depth), coordinate(e.a.x - e.nx * depth, e.a.y - e.ny * depth), e.a]),
        );
        pieces.push(unionAll(strips).intersection(part.area));
      }
      if (pieces.length > 0) yard = unionAll(pieces).intersection(lot);
    }
    const yardPrepared = yard !== null && !yard.isEmpty() ? prepare(yard) : null;

    // --- Recorrido de puntos ----------------------------------------------------------------------
    const adosamiento = neighbours.map((): { t: number; track: ElementTrack }[] => []);
    const adoTan = Math.tan((norms.adosamientoAngle * Math.PI) / 180);
    const zoneFrontYard = zone?.frontYard ?? null;
    let extensionDistance: number | null = null;
    if (input.isExtension && norms.extensionAdosamiento !== null && zoneFrontYard !== null) {
      const row = norms.extensionAdosamientoTable.find((r) => r.upTo === null || zoneFrontYard < r.upTo);
      extensionDistance = row?.distance ?? 0;
    }
    const facade = fronts.map((): Span => [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]);
    const point = coordinate(0, 0);
    const pointGeom = pointOf(point);
    const critical = rasanteLines.map(() => ({ excess: Number.NEGATIVE_INFINITY, x: 0, y: 0, h: 0, track: null as ElementTrack | null }));
    for (const track of tracks) {
      const element = track.element;
      const elementIsVoid = isVoid(element);
      const elementIsOpening = isOpening(element);
      const p = element.points;
      for (let i = 0; i + 2 < p.length; i += 3) {
        const x = p[i];
        const y = p[i + 1];
        const h = p[i + 2] - ground;
        // Un hueco solo cuenta como vano en los distanciamientos: no es altura, rasante, antejardín ni superficie.
        if (!elementIsVoid && h > track.maxHeight) track.maxHeight = h;
        if (h <= TOLERANCE) continue;
        point.x = x;
        point.y = y;
        pointGeom.geometryChanged();
        const zk = parts.length === 1 ? 0 : zoneAt(parts, pointGeom, x, y);
        const pointZone = parts[zk].norms;
        if (!elementIsVoid) {
          track.zones.add(Math.min(zk, 63));
          const maxHeight = pointZone?.maxHeight ?? null;
          if (maxHeight !== null && h - maxHeight > track.heightExcess) {
            track.heightExcess = h - maxHeight;
            track.heightZone = zk;
          }
        }

        // Antejardín y fachada hacia cada frente.
        let inYard = false;
        if (fronts.length > 0) {
          const [distFront, fi] = nearest(x, y, fronts);
          const depth = pointZone?.frontYard ?? 0;
          if (yardPrepared !== null && yardPrepared.contains(x, y)) {
            inYard = true;
            if (!elementIsVoid && depth - distFront > track.frontIntrusion) {
              track.frontIntrusion = depth - distFront;
              track.yardFront = fi;
            }
            if (!elementIsVoid && track.yardFront === fi) {
              const t = projection(x, y, fronts[fi]);
              track.yardT0 = Math.min(track.yardT0, t);
              track.yardT1 = Math.max(track.yardT1, t);
            }
          } else if (!elementIsVoid && distFront >= depth - TOLERANCE && distFront <= depth + FACADE_BAND) {
            const t = projection(x, y, fronts[fi]);
            facade[fi] = [Math.min(facade[fi][0], t), Math.max(facade[fi][1], t)];
          }
        }

        // Distanciamientos y adosamiento respecto de los deslindes con vecinos (sin el cuerpo pareado o continuo).
        let isAdosamiento = false;
        if (neighbours.length > 0) {
          const [dn, k] = nearest(x, y, neighbours, (kk) => excluded(kk, h));
          if (k >= 0) {
            const required = norms.requiredSetback(h, elementIsOpening);
            if (dn < required - TOLERANCE) {
              if (!inYard && h <= norms.adosamientoHeight + dn * adoTan + TOLERANCE) {
                isAdosamiento = true;
                track.adosado = true;
                adosamiento[k].push({ t: projection(x, y, neighbours[k]), track });
                if (extensionDistance !== null && zoneFrontYard !== null && fronts.length > 0) {
                  const fromFront = Math.min(...fronts.map((e) => segmentDistance(x, y, e.a, e.b)));
                  track.extensionDeficit = Math.max(track.extensionDeficit, zoneFrontYard + extensionDistance - fromFront);
                }
              } else if (required - dn > track.setbackDeficit) {
                track.setbackDeficit = required - dn;
                track.setbackDetail =
                  `a ${F(dn)} m del deslinde con ${F(h)} m de altura; exige ${F(required)} m ` +
                  (elementIsVoid ? "(hueco en muro sin ventana ni puerta: con vano)" : elementIsOpening ? "(con vano)" : "(sin vano)");
              }
            } else if (!elementIsOpening && dn < norms.requiredSetback(h, true) - TOLERANCE) {
              track.openingUnknown = true;
            }
          }
        }

        // Rasantes (las partes acogidas a adosamiento quedan exentas, art. 2.6.2).
        if (!isAdosamiento && !elementIsVoid && !Number.isNaN(tan) && rasanteLines.length > 0) {
          let nearestDistance = Number.POSITIVE_INFINITY;
          for (let l = 0; l < rasanteLines.length; l++) {
            if (excluded(rasanteNeighbour[l], h)) continue;
            const d = segmentDistance(x, y, rasanteLines[l].a, rasanteLines[l].b);
            if (d < nearestDistance) nearestDistance = d;
            if (h - tan * d > critical[l].excess) critical[l] = { excess: h - tan * d, x, y, h, track };
          }
          if (nearestDistance !== Number.POSITIVE_INFINITY) {
            const limit = tan * nearestDistance;
            if (h - limit > track.rasanteExcess) track.rasanteExcess = h - limit;
          }
        }
      }
    }

    const storeys = storeyAreas(tracks, ground);
    let results: RuleResult[] = [
      this.height(parts, tracks, commonNotes, input),
      this.rasantes(tracks, angle, rasanteLines.length, frontsWithoutWidth, rasanteNotes, pareoNotes, commonNotes, input),
      this.setbacks(tracks, neighbours.length, pareoNotes, commonNotes, input),
      this.adosamiento(neighbours, adosamiento, contacts, extensionDistance, tracks, commonNotes, input, ground),
      this.frontYard(parts, fronts, facade, tracks, storeys, commonNotes, input, ground),
      this.coverage(parts, storeys, lotArea),
      this.floorArea(parts, storeys, lotArea),
    ];
    const volume = this.theoreticalVolumeOf(parts, lot, yard, neighbours, rasanteLines, tan, ground);
    results.push(this.volumeResult(parts, volume));
    results.push(this.minimumLot(principal, lotArea, input));
    results.push(this.grouping(parts, grouping, neighbours, contacts, commonNotes, input));
    results.push(this.publicUse(input, lot, tracks, ground));
    results = applyZoneWarnings(results, parts, angle);
    const reason = input.reviewSuspended ?? null;
    if (reason !== null) {
      // La comuna no tiene un documento oficial utilizable (manifest «revision_suspendida»): nada se informa como verificado.
      return {
        results: results.map((r) => ({
          ...r,
          state: "NoVerificable",
          summary: `No verificable: ${reason}`,
          notes: [`Cálculo referencial, sin validez mientras la revisión esté suspendida: ${r.summary}`, ...r.notes],
        })),
        volume: null,
        lotArea,
        rasantes: null,
      };
    }

    let rasantes: RasanteGeometry | null = null;
    if (angle !== null && rasanteInfo.length > 0) {
      const sections: RasanteSection[] = [];
      for (let l = 0; l < rasanteInfo.length; l++) {
        const c = critical[l];
        if (c.track === null) continue;
        sections.push(section(rasanteInfo[l], c.x, c.y, c.h, c.track, lot, tracks, ground));
      }
      rasantes = { angle, groundZ: ground, zoneHeight: zone?.maxHeight ?? null, lines: rasanteInfo, sections };
    }
    return { results, volume, lotArea, rasantes };
  }

  // --- Zonas (art. 2.1.21) ---------------------------------------------------------------------------

  /** Partes del predio por zona, de la mayor a la menor; la primera es la zona principal. */
  private zoneParts(input: RuleInput, lot: Polygon, lotArea: number): Part[] {
    const parts: Part[] = [];
    for (const part of input.zoneParts ?? []) {
      let area: Geometry;
      try {
        area = readGeoJson(part.area).intersection(lot);
      } catch (error) {
        if (isTopologyException(error)) continue;
        throw error;
      }
      if (area.getArea() < lotArea * 0.005) continue;
      parts.push({ code: part.code, norms: this.norms.zone(part.code), area, prepared: prepare(area), areaM2: area.getArea() });
    }
    if (parts.length === 0) parts.push({ code: input.zoneCode, norms: this.norms.zone(input.zoneCode), area: lot, prepared: prepare(lot), areaM2: lotArea });
    return parts.sort((a, b) => b.areaM2 - a.areaM2);
  }

  private zoneSources(parts: Part[], text: (z: ZoneNorms) => string | null, ...extra: NormSource[]): NormSource[] {
    const sources: NormSource[] = [];
    for (const p of parts) {
      if (p.norms === null) continue;
      const quote = text(p.norms);
      if (quote !== null) sources.push(this.norms.zoneSource(p.norms, quote));
    }
    sources.push(...extra);
    return sources;
  }

  // --- R-01 Altura -----------------------------------------------------------------------------------

  private height(parts: Part[], tracks: ElementTrack[], common: string[], input: RuleInput): RuleResult {
    const id = "R-01";
    const title = "Altura máxima de edificación";
    const withNorms = parts.filter((p) => p.norms !== null);
    const noHeight = parts.every((p) => p.norms?.maxHeight == null);
    if (noHeight && withNorms.length > 0 && withNorms.every((p) => p.norms?.heightFree === true)) {
      // «Libre según rasante»: la Ordenanza no limita la altura; la limitan las rasantes (R-02).
      const free = this.zoneSources(parts, (z) => z.heightText, this.def("Altura de edificación"));
      return result(id, title, "NoAplica",
        "La Ordenanza Local no fija altura máxima para la zona («libre según rasante»): la altura la limitan las rasantes (R-02).",
        null, null, free, [], common);
    }
    if (noHeight) {
      // Zona de la Ordenanza sin cifra en metros (p. ej. Zona Típica: «la existente»): lo dicen sus advertencias.
      return withNorms.length > 0
        ? notVerifiable(id, title, "La Ordenanza Local no fija una altura máxima en metros para la zona: vea las advertencias de la zona.")
        : notVerifiable(id, title, this.missingZone(input.zoneCode, "No hay altura máxima de la zona"));
    }
    const multi = parts.length > 1;
    const sources = this.zoneSources(parts, (z) => z.heightText ?? (z.maxHeight !== null ? `Altura máxima de edificación ${F(z.maxHeight)} m` : null), this.def("Altura de edificación"));
    if (multi) sources.push(this.norms.multiZoneEach, this.norms.multiZoneHeights);
    const measured = tracks.filter((t) => t.maxHeight > Number.NEGATIVE_INFINITY);
    const top = measured.length === 0 ? 0 : Math.max(...measured.map((t) => t.maxHeight));
    const over = tracks.filter((t) => t.heightExcess > TOLERANCE).sort((a, b) => b.heightExcess - a.heightExcess);
    const notes = [...common];

    // Pisos sobre el suelo, por zona: los niveles con elementos en esa parte del predio.
    const byStorey = new Map<string, ElementTrack[]>();
    for (const t of tracks) {
      if (!(t.maxHeight > TOLERANCE) || t.element.storeyName === null) continue;
      const group = byStorey.get(t.element.storeyName);
      if (group) group.push(t);
      else byStorey.set(t.element.storeyName, [t]);
    }
    const aboveGround = [...byStorey.values()].filter((g) => Math.min(...g.map((t) => t.element.zMin)) >= input.groundZ - 0.5);
    const floorsOver: string[] = [];
    for (let k = 0; k < parts.length; k++) {
      const maxFloors = parts[k].norms?.maxFloors ?? null;
      if (maxFloors === null) continue;
      const bit = Math.min(k, 63);
      const floors = aboveGround.filter((g) => g.some((t) => t.zones.has(bit))).length;
      notes.push(`Pisos sobre el suelo en ${multi ? `la zona ${code(parts[k])}` : "el modelo"}: ${floors} (máximo ${maxFloors}).`);
      if (floors > maxFloors) floorsOver.push(`${floors} pisos donde la zona ${code(parts[k])} permite ${maxFloors}`);
    }

    const max = (p: Part): string => (p.norms?.maxHeight != null ? `${F(p.norms.maxHeight)} m` : "sin límite");
    const floorsText = (p: Part): string => (p.norms?.maxFloors != null ? ` y ${p.norms.maxFloors} pisos` : "");
    const required = multi ? parts.map((p) => `${code(p)}: ${max(p)}${floorsText(p)}`).join(" · ") : `${max(parts[0])}${floorsText(parts[0])}`;
    let state: RuleState;
    let summary: string;
    const incentiveOk = (t: ElementTrack): boolean => {
      const z = parts[t.heightZone].norms;
      return z !== null && z.incentiveHeight !== null && z.maxHeight !== null && t.heightExcess + z.maxHeight <= z.incentiveHeight + TOLERANCE;
    };
    if (over.length === 0 && floorsOver.length === 0) {
      state = input.groundConfirmed ? "Cumple" : "RevisionRequerida";
      summary = `El punto más alto está a ${F(top)} m sobre el suelo natural (máximo ${multi ? "por zona: " + required : required}).`;
    } else if (floorsOver.length === 0 && over.every((t) => ROOF_EQUIPMENT.has(t.element.ifcClass))) {
      state = "RevisionRequerida";
      summary = `Solo superan la altura elementos de azotea (${over.length}); el art. 2.6.3 los permite si cumplen rasantes y ocupan hasta el 25 % de la azotea.`;
      sources.push(this.norms.roofElements);
    } else if (floorsOver.length === 0 && over.every(incentiveOk)) {
      // La Ordenanza permite más altura si el proyecto cumple una condición (Art. 184 LGUC) que el modelo no muestra.
      state = "RevisionRequerida";
      const zonesWithIncentive: ZoneNorms[] = [];
      for (const t of over) {
        const z = parts[t.heightZone].norms;
        if (z !== null && !zonesWithIncentive.includes(z)) zonesWithIncentive.push(z);
      }
      const limit = (z: ZoneNorms): string => (z.incentiveHeight === Number.POSITIVE_INFINITY ? "sin tope fijo, dentro de las rasantes" : `${F(z.incentiveHeight ?? 0)} m`);
      summary =
        `${over.length} elemento(s) superan la altura base (exceso máximo ${F(over[0].heightExcess)} m) pero no la que la Ordenanza permite con condición ` +
        `(${zonesWithIncentive.map((z) => `${z.zone}: ${limit(z)}`).join(", ")}): verifique que el proyecto cumple esa condición.`;
      for (const z of zonesWithIncentive) {
        const source = this.norms.incentiveSource(z);
        if (source !== null) sources.push(source);
      }
    } else {
      state = "NoCumple";
      summary = over.length > 0
        ? `${over.length} elemento(s) superan la altura máxima${multi ? " de su zona" : ""}; exceso máximo ${F(over[0].heightExcess)} m.`
        : `El modelo tiene ${floorsOver.join("; ")}.`;
    }
    const findings = over.map((t) =>
      finding(t, t.heightExcess, `alcanza ${F(t.heightExcess + (parts[t.heightZone].norms?.maxHeight ?? 0))} m sobre el suelo${multi ? ` en la zona ${code(parts[t.heightZone])}` : ""}`),
    );
    return result(id, title, state, summary, required, `${F(top)} m`, sources, findings, notes);
  }

  // --- R-02 Rasantes --------------------------------------------------------------------------------

  private rasantes(tracks: ElementTrack[], angle: number | null, lines: number, frontsWithoutWidth: number,
    rasanteNotes: string[], pareoNotes: string[], common: string[], input: RuleInput): RuleResult {
    const id = "R-02";
    const title = "Rasantes";
    const sources = [this.norms.rasante, this.norms.rasanteTable, this.norms.rasanteLevel, this.def("Rasante")];
    if (angle === null) return notVerifiable(id, title, `No se pudo determinar la región del proyecto para el ángulo de rasante (${input.region ?? "sin región"}).`, sources);
    if (lines === 0) return notVerifiable(id, title, "No hay deslindes desde donde aplicar rasantes (defina el tipo de cada deslinde).", sources);

    const over = tracks.filter((t) => t.rasanteExcess > TOLERANCE).sort((a, b) => b.rasanteExcess - a.rasanteExcess);
    const notes = [...common, `Ángulo ${F(angle)}° (región de ${input.region}), aplicado desde el suelo natural.`];
    notes.push(...rasanteNotes);
    notes.push(...pareoNotes);
    if (tracks.some((t) => t.adosado)) notes.push("Las partes acogidas a adosamiento (R-04) no se evalúan con rasantes (art. 2.6.2).");
    let state: RuleState;
    let summary: string;
    if (over.length > 0) {
      state = "NoCumple";
      summary = `${over.length} elemento(s) sobrepasan la rasante de ${F(angle)}°; exceso máximo ${F(over[0].rasanteExcess)} m.`;
    } else {
      state = frontsWithoutWidth > 0 || !input.groundConfirmed || !input.positionConfirmed ? "RevisionRequerida" : "Cumple";
      summary = `Ningún punto sobrepasa las rasantes de ${F(angle)}°.`;
    }
    const findings = over.map((t) => finding(t, t.rasanteExcess, `sobrepasa la rasante en ${F(t.rasanteExcess)} m`));
    return result(id, title, state, summary, `${F(angle)}° desde los deslindes`, over.length > 0 ? `exceso ${F(over[0].rasanteExcess)} m` : "sin excesos", sources, findings, notes);
  }

  // --- R-03 Distanciamientos ------------------------------------------------------------------------

  private setbacks(tracks: ElementTrack[], neighbours: number, pareoNotes: string[], common: string[], input: RuleInput): RuleResult {
    const id = "R-03";
    const title = "Distanciamientos a los deslindes";
    const sources = [this.norms.setbackSource, this.def("Distanciamiento")];
    if (neighbours === 0) return result(id, title, "NoAplica", "El predio no tiene deslindes con otros predios.", null, null, sources, [], common);
    const over = tracks.filter((t) => t.setbackDeficit > TOLERANCE).sort((a, b) => b.setbackDeficit - a.setbackDeficit);
    const unknown = tracks.filter((t) => t.openingUnknown && t.setbackDeficit <= TOLERANCE);
    const notes = [...common, "Ventanas, puertas, muros cortina y huecos en muros se evalúan como fachada con vano; el resto, sin vano."];
    notes.push(...pareoNotes);
    if (tracks.some((t) => t.adosado)) notes.push("Las partes dentro de la envolvente de adosamiento se evalúan en R-04 (art. 2.6.2).");
    let state: RuleState;
    let summary: string;
    if (over.length > 0) {
      state = "NoCumple";
      summary = `${over.length} elemento(s) no cumplen el distanciamiento; el peor ${over[0].setbackDetail}.`;
    } else if (unknown.length > 0) {
      state = "RevisionRequerida";
      summary = `${unknown.length} elemento(s) sin vano modelado quedan a menos de lo exigido para fachadas con vano: confirme que esos tramos no tienen vanos.`;
    } else {
      state = input.groundConfirmed && input.positionConfirmed ? "Cumple" : "RevisionRequerida";
      summary = "Todos los puntos cumplen los distanciamientos de la tabla del art. 2.6.3.";
    }
    const findings = [
      ...over.map((t) => finding(t, t.setbackDeficit, t.setbackDetail ?? "")),
      ...unknown.map((t) => finding(t, 0, "cumple sin vano; confirmar que no tiene vanos")),
    ];
    return result(id, title, state, summary, "1,4 / 2,5 / 4,0 m sin vano · 3,0 / 3,0 / 4,0 m con vano",
      over.length > 0 ? `déficit ${F(over[0].setbackDeficit)} m` : "sin déficit", sources, findings, notes);
  }

  // --- R-04 Adosamiento -----------------------------------------------------------------------------

  private adosamiento(neighbours: Edge[], parts: { t: number; track: ElementTrack }[][], contacts: EdgeContact[],
    extensionDistance: number | null, tracks: ElementTrack[], common: string[], input: RuleInput, ground: number): RuleResult {
    const norms = this.norms;
    const id = "R-04";
    const title = "Adosamiento";
    const sources = [...norms.adosamientoSources, norms.adosamientoWall, norms.adosamientoRoofWall, norms.adosamientoRain, norms.adosamientoExemption];
    if (parts.every((p) => p.length === 0)) {
      return result(id, title, "NoAplica", "No hay partes del edificio más cerca de los deslindes que lo que exigen los distanciamientos.", null, null, sources, [], common);
    }
    const notes = [...common, "Se consideró adosamiento a las partes que no cumplen el distanciamiento pero caben en la envolvente de 3,5 m en el deslinde y 45°."];
    const findings: ElementFinding[] = [];
    let worst = 0;
    const measured: string[] = [];
    const wallProblems: string[] = [];
    const fireMissing: ElementTrack[] = [];
    const fireLow: { track: ElementTrack; minutes: number }[] = [];
    for (let k = 0; k < neighbours.length; k++) {
      if (parts[k].length === 0) continue;
      const edge = neighbours[k];
      const positions = parts[k].map((p) => p.t);
      const covered = coveredLength(positions, edge.length);
      const percent = (covered / edge.length) * 100;
      worst = Math.max(worst, percent);
      measured.push(`${F(covered)} m de ${F(edge.length)} m (${F(percent)} %)`);
      for (const track of distinct(parts[k].map((p) => p.track))) {
        findings.push(finding(track, percent, `adosado al deslinde ${edge.number}: ${F(percent)} % de su largo`));
      }

      // Muro de adosamiento: en el deslinde, en todo el tramo adosado, de 2,0 m como mínimo y hasta la cubierta si el cuerpo está en el deslinde.
      const needed = Math.max(norms.adosamientoWallHeight, contacts[k].bodyHeight);
      const walls: { span: Span; track: ElementTrack }[] = [];
      for (const [track, span] of contacts[k].walls) {
        if (track.element.zMax - ground >= needed - TOLERANCE) walls.push({ span, track });
      }
      const gaps = uncovered(intervalsOf(positions), walls.map((w) => w.span));
      if (gaps > 0.2) {
        wallProblems.push(
          contacts[k].walls.size === 0
            ? `deslinde ${edge.number}: no hay muro en el deslinde`
            : `deslinde ${edge.number}: faltan ${F(gaps)} m de muro de ${F(needed)} m de alto en el tramo adosado`,
        );
      }
      for (const wall of distinct(walls.map((w) => w.track))) {
        const rating = input.fireRatings?.[fireRatingKey(wall.modelId, wall.element.expressId)] ?? null;
        const minutes = fireMinutes(rating);
        if (minutes === null) fireMissing.push(wall);
        else if (minutes < norms.adosamientoFireMinutes) fireLow.push({ track: wall, minutes });
      }
    }
    for (const { track, minutes } of fireLow) findings.push(finding(track, minutes, `muro de adosamiento F-${minutes}: exige F-${norms.adosamientoFireMinutes}`));
    if (fireMissing.length > 0) notes.push(`${fireMissing.length} muro(s) de adosamiento sin resistencia al fuego en el IFC (propiedad FireRating): verifique F-${norms.adosamientoFireMinutes}.`);
    notes.push("Aguas lluvia: el adosamiento debe contemplar su evacuación sin afectar al vecino (art. 2.6.2); el modelo no lo muestra.");

    if (extensionDistance !== null && norms.extensionAdosamiento !== null) {
      sources.push(norms.extensionAdosamiento);
      const close = tracks.filter((t) => t.extensionDeficit > TOLERANCE);
      if (close.length > 0) notes.push(`Ampliación: ${close.length} elemento(s) adosados a menos de ${F(extensionDistance)} m de la línea de edificación (${norms.extensionAdosamiento.article} de la Ordenanza Local).`);
    } else if (norms.extensionAdosamiento !== null) {
      notes.push(`El ${norms.extensionAdosamiento.article} de la Ordenanza Local (distancia a la línea de edificación) se aplica solo a ampliaciones.`);
    }
    const extensionFail = extensionDistance !== null && tracks.some((t) => t.extensionDeficit > TOLERANCE);
    const lengthFail = worst > norms.adosamientoLengthPercent + 0.05;
    const problems: string[] = [];
    if (lengthFail) problems.push(`el adosamiento ocupa hasta el ${F(worst)} % de un deslinde (máximo ${F(norms.adosamientoLengthPercent)} %)`);
    if (extensionFail) problems.push("el adosamiento de la ampliación no respeta la distancia a la línea de edificación");
    problems.push(...wallProblems);
    if (fireLow.length > 0) problems.push(`${fireLow.length} muro(s) de adosamiento bajo F-${norms.adosamientoFireMinutes}`);

    let state: RuleState;
    let summary: string;
    if (problems.length > 0) {
      state = "NoCumple";
      summary = capitalize(problems[0]) + (problems.length > 1 ? "; " + problems.slice(1).join("; ") : "") + ".";
      if (lengthFail) notes.push("El porcentaje puede excederse con autorización del propietario vecino ante Notario (art. 2.6.2 N° 1).");
    } else {
      state = "RevisionRequerida";
      summary =
        `La geometría cabe en la envolvente, ocupa hasta el ${F(worst)} % del deslinde y tiene muro de adosamiento; ` +
        (fireMissing.length > 0 ? "falta verificar su resistencia al fuego y las aguas lluvia." : "falta verificar las aguas lluvia.");
    }
    return result(id, title, state, summary,
      `≤ ${F(norms.adosamientoLengthPercent)} % del deslinde, 3,5 m en el deslinde, 45°; muro en el deslinde ≥ ${F(norms.adosamientoWallHeight)} m, F-${norms.adosamientoFireMinutes}`,
      measured.join(" · "), sources, findings, notes);
  }

  // --- R-05 Antejardín -----------------------------------------------------------------------------

  private frontYard(parts: Part[], fronts: Edge[], facade: Span[], tracks: ElementTrack[], storeys: StoreyArea[],
    common: string[], input: RuleInput, ground: number): RuleResult {
    const norms = this.norms;
    const id = "R-05";
    const title = "Antejardín";
    if (parts.every((p) => p.norms === null)) return notVerifiable(id, title, this.missingZone(input.zoneCode, "No hay ficha de la zona"));
    const withYard = parts.filter((p) => p.norms !== null && p.norms.frontYard !== null && p.norms.frontYard > 0);
    const sources = this.zoneSources(withYard, (z) => z.frontYardText ?? `Antejardín ${F(z.frontYard ?? 0)} m`, this.def("Antejardín"));
    if (norms.frontYardBuildable !== null) sources.push(norms.frontYardBuildable);
    if (parts.length > 1) sources.push(norms.multiZoneEach);
    if (withYard.length === 0) {
      return result(id, title, "NoAplica", `La ficha de la zona ${code(parts[0])} no fija antejardín.`, null, null, sources, [], common);
    }
    if (fronts.length === 0) return notVerifiable(id, title, "El predio no tiene un deslinde marcado como frente a espacio público.", sources);

    const inside = tracks.filter((t) => t.frontIntrusion > TOLERANCE).sort((a, b) => b.frontIntrusion - a.frontIntrusion);
    const notes = [...common, "Se considera línea oficial al deslinde de frente (verifíquelo en el CIP)."];
    const required = withYard.map((p) => `${parts.length > 1 ? code(p) + ": " : ""}${F(p.norms?.frontYard ?? 0)} m libres desde la línea oficial`).join(" · ");
    if (inside.length === 0) {
      const summary = `Ninguna parte del edificio ocupa el antejardín (${withYard.map((p) => `${F(p.norms?.frontYard ?? 0)} m`).join(", ")}).`;
      const state: RuleState = input.positionConfirmed ? "Cumple" : "RevisionRequerida";
      return result(id, title, state, summary, required, "sin intrusión", sources, [], notes);
    }

    // Cuerpos salientes de la línea de edificación, según la Ordenanza Local de la comuna (saliente máxima, altura mínima sobre el
    // suelo y, si los fija, largo máximo en el 1° piso y solo balcones en los pisos superiores).
    const firstFloor = storeys.length > 0 ? storeys[0].name : null;
    const isFirstFloor = (t: ElementTrack): boolean => (t.element.storeyName !== null ? t.element.storeyName === firstFloor : t.element.zMin - ground < 2.5);
    const invalid: { track: ElementTrack; why: string }[] = [];
    const review: { track: ElementTrack; why: string }[] = [];
    const valid: { track: ElementTrack; why: string }[] = [];
    const firstFloorSpans = fronts.map((): Span[] => []);
    for (const t of inside) {
      if (norms.projections === null || t.frontIntrusion > norms.projectionMax + TOLERANCE) {
        invalid.push({ track: t, why: `entra ${F(t.frontIntrusion)} m en el antejardín` });
        continue;
      }
      const bottom = t.element.zMin - ground;
      if (norms.projectionsReviewOnly) {
        review.push({ track: t, why: `sale ${F(t.frontIntrusion)} m: la Ordenanza admite cuerpos salientes hasta ${F(norms.projectionMax)} m (${norms.projections.article}) sin fijar desde qué altura; verifique que lo sea` });
        continue;
      }
      if (bottom < norms.projectionMinHeight - TOLERANCE) {
        invalid.push({ track: t, why: `sale ${F(t.frontIntrusion)} m a ${F(Math.max(0, bottom))} m del suelo: bajo ${F(norms.projectionMinHeight)} m no es cuerpo saliente (${norms.projections.article})` });
        continue;
      }
      if (isFirstFloor(t)) {
        valid.push({ track: t, why: `cuerpo saliente del 1° piso de ${F(t.frontIntrusion)} m, a ${F(bottom)} m del suelo` });
        if (t.yardFront >= 0 && t.yardT1 >= t.yardT0) firstFloorSpans[t.yardFront].push([t.yardT0, t.yardT1]);
      } else if (norms.projectionsUpper !== null && ENCLOSING_CLASSES.has(t.element.ifcClass)) {
        review.push({ track: t, why: `sale ${F(t.frontIntrusion)} m en un piso superior; el ${norms.projectionsUpper.article} admite ahí solo balcones` });
      } else {
        valid.push({ track: t, why: `balcón o saliente de ${F(t.frontIntrusion)} m en un piso superior` });
      }
    }
    for (const s of [norms.projectionsFirstFloor ?? norms.projections, norms.projectionsUpper]) if (s !== null) sources.push(s);
    const lengthArticle = (norms.projectionsFirstFloor ?? norms.projections)?.article;
    for (let f = 0; f < fronts.length && norms.projectionLengthFraction > 0; f++) {
      if (firstFloorSpans[f].length === 0) continue;
      const length = mergeSpans(firstFloorSpans[f]).reduce((sum, s) => sum + (s[1] - s[0]), 0);
      const facadeLength = facade[f][1] - facade[f][0];
      if (facadeLength <= 0) {
        notes.push(`Frente del deslinde ${fronts[f].number}: no se pudo medir el largo de la fachada para el límite de ${fraction(norms.projectionLengthFraction)} del ${lengthArticle}.`);
        review.push(...valid.filter((v) => v.track.yardFront === f && isFirstFloor(v.track)).map((v) => ({ track: v.track, why: "largo de fachada no medido" })));
      } else if (length > norms.projectionLengthFraction * facadeLength + TOLERANCE) {
        const frac = fraction(norms.projectionLengthFraction);
        notes.push(`Frente del deslinde ${fronts[f].number}: los cuerpos salientes del 1° piso suman ${F(length)} m de ${F(facadeLength)} m de fachada (máximo ${frac} = ${F(norms.projectionLengthFraction * facadeLength)} m).`);
        invalid.push(
          ...valid
            .filter((v) => v.track.yardFront === f && isFirstFloor(v.track))
            .map((v) => ({ track: v.track, why: `los cuerpos salientes del 1° piso ocupan ${F(length)} m de ${F(facadeLength)} m de fachada (máximo ${frac})` })),
        );
      }
    }
    const prefix = norms.detailPlanZonePrefix;
    if (prefix !== null && prefix.length > 0 && norms.projectionsZpt !== null && parts.some((p) => p.code?.toUpperCase().startsWith(prefix.toUpperCase()) === true)) {
      sources.push(norms.projectionsZpt);
      review.push(...valid.map((v) => ({ track: v.track, why: `zona ${prefix}: los cuerpos salientes se rigen por el Plano de Detalle` })));
    }

    const failing = new Set(invalid.map((i) => i.track));
    const doubtful = new Set(review.map((r) => r.track).filter((t) => !failing.has(t)));
    let state: RuleState;
    let text: string;
    if (failing.size > 0) {
      state = "NoCumple";
      text = `${failing.size} elemento(s) ocupan el antejardín sin ser cuerpos salientes permitidos; la mayor intrusión es ${F(inside[0].frontIntrusion)} m.`;
    } else if (doubtful.size > 0 || !input.positionConfirmed || !input.groundConfirmed) {
      state = "RevisionRequerida";
      text = `${inside.length} elemento(s) salen sobre el antejardín hasta ${F(inside[0].frontIntrusion)} m como cuerpos salientes; revise los señalados.`;
    } else {
      state = "Cumple";
      text = `Solo salen sobre el antejardín cuerpos salientes permitidos (hasta ${F(inside[0].frontIntrusion)} m, ${norms.projections?.article}).`;
    }
    const findings = [
      ...invalid.map((i) => finding(i.track, i.track.frontIntrusion, i.why)),
      ...review.filter((r) => !failing.has(r.track)).map((r) => finding(r.track, r.track.frontIntrusion, r.why)),
      ...valid.filter((v) => !failing.has(v.track) && !doubtful.has(v.track)).map((v) => finding(v.track, v.track.frontIntrusion, v.why)),
    ];
    return result(id, title, state, text, required, `intrusión ${F(inside[0].frontIntrusion)} m`, sources, findings, notes);
  }

  // --- R-06 / R-07 Coeficientes --------------------------------------------------------------------

  private coverage(parts: Part[], storeys: StoreyArea[], lotArea: number): RuleResult {
    return this.coefficient("R-06", "Coeficiente de ocupación de suelo", parts, (z) => z.landCoverage, (z) => z.landCoverageText,
      (z) => ({ max: z.landCoverageMax, condition: z.landCoverageCondition }), storeys, lotArea,
      [this.def("Coeficiente de ocupación del suelo"), this.def("Superficie edificada")],
      (s, part) => (s.length === 0 ? 0 : part === null ? s[0].area : areaIn(s[0].filled, part.area)),
      (s, total) => `primer piso (${s[0].name}) ${F(total)} m²`);
  }

  private floorArea(parts: Part[], storeys: StoreyArea[], lotArea: number): RuleResult {
    return this.coefficient("R-07", "Coeficiente de constructibilidad", parts, (z) => z.floorAreaRatio, (z) => z.floorAreaRatioText,
      (z) => ({ max: z.floorAreaRatioMax, condition: z.floorAreaRatioCondition }), storeys, lotArea,
      [this.def("Coeficiente de constructibilidad"), this.def("Superficie edificada")],
      (s, part) => (part === null ? s.reduce((sum, x) => sum + x.area, 0) : s.reduce((sum, x) => sum + areaIn(x.filled, part.area), 0)),
      (s, total) => `${s.map((x) => F(x.area)).join(" + ")} = ${F(total)} m²`);
  }

  /**
   * Coeficiente contra la superficie del predio. Con varias zonas (art. 2.1.21) el máximo se promedia por superficie; si una zona no
   * tiene límite no se promedia y cada parte con límite se revisa por separado. Si la ficha fija un máximo condicionado (cifra y
   * condición), entre la cifra base y ese máximo la regla queda en revisión, porque el modelo no muestra si el proyecto cumple la condición.
   */
  private coefficient(id: string, title: string, parts: Part[], max: (z: ZoneNorms) => number | null, text: (z: ZoneNorms) => string | null,
    conditional: (z: ZoneNorms) => { max: number | null; condition: string | null }, storeys: StoreyArea[], lotArea: number,
    definitions: NormSource[], built: (s: StoreyArea[], part: Part | null) => number, detail: (s: StoreyArea[], total: number) => string): RuleResult {
    const conditioned = (r: RuleResult, ratio: number, limit: number, zoneParts: Part[], weightedUpper: number | null = null): RuleResult => {
      const conditions: { code: string; value: number; condition: string | null }[] = [];
      for (const p of zoneParts) {
        if (p.norms === null) continue;
        const c = conditional(p.norms);
        if (c.max !== null) conditions.push({ code: code(p), value: c.max, condition: c.condition });
      }
      if (conditions.length === 0 || r.state !== "NoCumple") return r;
      const upper = weightedUpper ?? Math.max(...conditions.map((c) => c.value));
      if (ratio > upper + 0.005) return r;
      const why = conditions.map((c) => `${c.code}: hasta ${F(c.value, 2)}${c.condition !== null ? ` si ${c.condition}` : ""}`).join("; ");
      return {
        ...r,
        state: "RevisionRequerida",
        summary: `${F(ratio, 2)}: sobre la cifra base ${F(limit, 2)}, pero dentro de lo que la Ordenanza permite con condición (${why}). Verifique la condición.`,
        required: `${F(limit, 2)} (hasta ${F(upper, 2)} con condición)`,
      };
    };

    const limited = parts.filter((p) => p.norms !== null && max(p.norms) !== null);
    if (limited.length === 0) return notVerifiable(id, title, "La zona del predio no tiene este coeficiente en el PRC cargado.");
    const sources = this.zoneSources(parts, text, ...definitions);
    if (storeys.length === 0) return notVerifiable(id, title, "El modelo no tiene pisos (IfcBuildingStorey) sobre el suelo para medir la superficie.", sources);
    const notes = [
      "Superficie aproximada desde la geometría: unión de huellas por piso hasta la cara exterior de los muros, incluyendo lo encerrado (revise vacíos, ductos y escaleras de evacuación).",
      "No se descontaron áreas declaradas de utilidad pública del predio.",
    ];
    const limitOf = (p: Part): number => (p.norms === null ? 0 : (max(p.norms) ?? 0));
    const total = built(storeys, null);
    if (parts.length === 1) {
      const limit = limitOf(parts[0]);
      return conditioned(coefficientResult(id, title, total / lotArea, limit, `${detail(storeys, total)} / predio ${F(lotArea)} m²`, sources, notes), total / lotArea, limit, parts);
    }

    sources.push(this.norms.multiZoneAverage);
    if (limited.length === parts.length) {
      const weighted = parts.reduce((sum, p) => sum + limitOf(p) * p.areaM2, 0) / lotArea;
      const weightedUpper = parts.reduce((sum, p) => sum + (p.norms === null ? 0 : (conditional(p.norms).max ?? limitOf(p))) * p.areaM2, 0) / lotArea;
      notes.push(
        "Máximo promediado por superficie de cada zona (art. 2.1.21): " + parts.map((p) => `${F(limitOf(p))} × ${F(p.areaM2)} m²`).join(" + ") +
          ` / ${F(lotArea)} m² = ${F(weighted)}.`,
      );
      return conditioned(coefficientResult(id, title, total / lotArea, weighted, `${detail(storeys, total)} / predio ${F(lotArea)} m²`, sources, notes),
        total / lotArea, weighted, parts, weightedUpper);
    }

    // Una zona sin límite: cada parte con límite se revisa sola.
    notes.push("Una de las zonas no tiene límite para este coeficiente: no se promedia (art. 2.1.21) y cada parte con límite se revisa por separado.");
    let worst: RuleResult | null = null;
    let worstRatio = Number.NEGATIVE_INFINITY;
    for (const part of limited) {
      const limit = limitOf(part);
      const area = built(storeys, part);
      const ratio = area / part.areaM2;
      if (ratio - limit <= worstRatio) continue;
      worstRatio = ratio - limit;
      worst = conditioned(coefficientResult(id, title, ratio, limit, `zona ${code(part)}: ${F(area)} m² / ${F(part.areaM2)} m²`, sources, notes), ratio, limit, [part]);
    }
    if (worst === null) throw new Error("Sin parte con límite para el coeficiente.");
    return worst;
  }

  // --- R-08 Volumen teórico -----------------------------------------------------------------------

  private theoreticalVolumeOf(parts: Part[], lot: Polygon, yard: Geometry | null, neighbours: Edge[], rasanteLines: Line[], tan: number, ground: number): TheoreticalVolume | null {
    if (parts.every((p) => p.norms?.maxHeight == null) && (Number.isNaN(tan) || rasanteLines.length === 0)) return null;
    const env = lot.getEnvelopeInternal();
    const step = Math.max(0.5, Math.sqrt(env.getArea() / 40000));
    const columns = Math.ceil(env.getWidth() / step);
    const rows = Math.ceil(env.getHeight() / step);
    const heights = new Float32Array(columns * rows);
    const prepared = prepare(lot);
    const yardPrepared = yard !== null && !yard.isEmpty() ? prepare(yard) : null;
    const point = coordinate(0, 0);
    const pointGeom = pointOf(point);
    let volume = 0;
    let area = 0;
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < columns; i++) {
        const x = env.getMinX() + (i + 0.5) * step;
        const y = env.getMinY() + (j + 0.5) * step;
        if (!prepared.contains(x, y) || (yardPrepared?.contains(x, y) ?? false)) continue;
        point.x = x;
        point.y = y;
        pointGeom.geometryChanged();
        let h = parts[parts.length === 1 ? 0 : zoneAt(parts, pointGeom, x, y)].norms?.maxHeight ?? Number.POSITIVE_INFINITY;
        if (!Number.isNaN(tan) && rasanteLines.length > 0) h = Math.min(h, tan * Math.min(...rasanteLines.map((l) => segmentDistance(x, y, l.a, l.b))));
        if (neighbours.length > 0) {
          // Distanciamientos sin vano (la envolvente máxima): la altura admisible según la distancia al deslinde.
          const d = Math.min(...neighbours.map((e) => segmentDistance(x, y, e.a, e.b)));
          let cap = 0;
          for (const row of this.norms.setbacks) {
            if (d + TOLERANCE >= row.withoutOpening) cap = row.upTo ?? Number.POSITIVE_INFINITY;
          }
          h = Math.min(h, cap);
        }
        if (!Number.isFinite(h) || h <= 0) continue;
        heights[j * columns + i] = h;
        volume += h * step * step;
        area += step * step;
      }
    }
    return { x0: env.getMinX(), y0: env.getMinY(), step, columns, rows, heights, groundZ: ground, volumeM3: volume, buildableArea: area };
  }

  private volumeResult(parts: Part[], volume: TheoreticalVolume | null): RuleResult {
    const id = "R-08";
    const title = "Volumen teórico (cabida)";
    const sources = [this.def("Volumen teórico")];
    if (volume === null) return notVerifiable(id, title, "Faltan la altura de la zona o las rasantes para calcular el volumen teórico.", sources);
    const notes = [
      "Calculado con altura máxima, rasantes, distanciamientos sin vano (la envolvente mayor) y antejardín, en una grilla de " + F(volume.step) + " m.",
      "No incluye adosamientos, que se suman a la envolvente según el art. 2.6.2.",
    ];
    if (parts.every((p) => p.norms?.landCoverage != null)) {
      notes.push(`Superficie máxima de primer piso por ocupación: ${F(parts.reduce((sum, p) => sum + (p.norms?.landCoverage ?? 0) * p.areaM2, 0))} m².`);
    }
    if (parts.every((p) => p.norms?.floorAreaRatio != null)) {
      notes.push(`Superficie máxima edificable por constructibilidad: ${F(parts.reduce((sum, p) => sum + (p.norms?.floorAreaRatio ?? 0) * p.areaM2, 0))} m².`);
    }
    return result(id, title, "Informativo", `Volumen teórico de ${F(volume.volumeM3, 0)} m³ sobre ${F(volume.buildableArea)} m² edificables en planta.`,
      null, `${F(volume.volumeM3, 0)} m³`, sources, [], notes);
  }

  // --- R-09 Superficie predial mínima --------------------------------------------------------------

  private minimumLot(principal: Part, lotArea: number, input: RuleInput): RuleResult {
    const id = "R-09";
    const title = "Superficie predial mínima";
    const zone = principal.norms;
    if (zone === null) return notVerifiable(id, title, this.missingZone(input.zoneCode, "No hay ficha de la zona"));
    const min = zone.minLotArea;
    if (min === null) return notVerifiable(id, title, `La ficha de la zona ${zone.zone} no fija superficie predial mínima.`);
    const sources = [this.norms.zoneSource(zone, zone.minLotAreaText ?? `Superficie predial mínima ${F(min)} m²`)];
    const measured = `predio ${F(lotArea)} m²`;
    if (!(input.isSubdivision ?? false)) {
      const notes = lotArea < min ? [`El predio (${F(lotArea)} m²) es menor que la superficie de subdivisión mínima de la zona (${F(min)} m²).`] : [];
      return result(id, title, "NoAplica",
        `La ficha fija ${F(min)} m² como superficie de subdivisión predial mínima: rige al subdividir, y este trámite es de edificación.`,
        `${F(min)} m² (subdivisión)`, measured, sources, [], notes);
    }
    const state: RuleState = lotArea + TOLERANCE >= min ? "Cumple" : "NoCumple";
    return result(id, title, state, `El predio tiene ${F(lotArea)} m² (mínimo de subdivisión ${F(min)} m²).`, `${F(min)} m²`, measured, sources, [], []);
  }

  // --- R-10 Sistema de agrupamiento ----------------------------------------------------------------

  private grouping(parts: Part[], grouping: GroupingResult, neighbours: Edge[], contacts: EdgeContact[], common: string[], input: RuleInput): RuleResult {
    const id = "R-10";
    const title = "Sistema de agrupamiento";
    const sources = [this.norms.groupingTypes, this.def("Edificación aislada"), this.def("Edificación pareada"), this.def("Edificación continua")];
    const zone = parts[0].norms;
    if (zone === null) return notVerifiable(id, title, this.missingZone(input.zoneCode, "No hay ficha de la zona"), sources);
    sources.unshift(...this.zoneSources(parts, (z) => z.groupingText));
    if (parts.length > 1) sources.push(this.norms.multiZoneEach);
    const notes = [...common];
    if (zone.groupingText?.toLowerCase().includes("sobre continuidad") === true) {
      notes.push(`La ficha de la zona ${zone.zone} indica «${zone.groupingText}».`);
    }
    const findings: ElementFinding[] = [];
    const seen = new Set<string>();
    for (const k of grouping.contact) {
      for (const t of contacts[k].tall) {
        const f = finding(t, contacts[k].pareoHeight, `en el deslinde ${neighbours[k].number} sobre la altura de adosamiento (${F(contacts[k].pareoHeight)} m)`);
        const key = `${f.modelId}:${f.expressId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        findings.push(f);
      }
    }
    const label = grouping.type === "aislado" ? "aislada" : grouping.type === "pareado" ? "pareada" : grouping.type === "continuo" ? "continua" : "sin clasificar";
    const measured = `edificación ${label}: ${grouping.detail}`;
    const allowedText = zone.groupingText ?? zone.grouping.join(", ");

    if (grouping.type === null) {
      return result(id, title, "RevisionRequerida",
        `El emplazamiento no corresponde claramente a edificación aislada, pareada ni continua: ${grouping.detail}.`, allowedText, measured, sources, findings, notes);
    }
    const type = grouping.type;
    const allowedInAll = parts.filter((p) => p.norms !== null).every((p) => p.norms?.grouping.some((g) => g.toLowerCase() === type.toLowerCase()) === true);
    if (!allowedInAll) {
      return result(id, title, "NoCumple",
        `El proyecto se emplaza como edificación ${label} y la zona ${zone.zone} admite: ${allowedText}.`, allowedText, measured, sources, findings, notes);
    }
    switch (type) {
      case "aislado": {
        const state: RuleState = input.groundConfirmed && input.positionConfirmed ? "Cumple" : "RevisionRequerida";
        notes.push("La edificación aislada debe cumplir rasantes y distanciamientos (R-02, R-03); lo que está en los deslindes se revisa como adosamiento (R-04).");
        return result(id, title, state, `Edificación aislada, admitida en la zona ${zone.zone}.`, allowedText, measured, sources, findings, notes);
      }
      case "pareado":
        sources.push(this.norms.pairedSimultaneous);
        return result(id, title, "RevisionRequerida",
          `Edificación pareada, admitida en la zona ${zone.zone}: verifique que el pareo se ejecute en forma simultánea con el vecino y mantenga la misma línea de fachada, altura y longitud de pareo.`,
          allowedText, measured, sources, findings, notes);
      default:
        sources.push(this.norms.continuityException);
        return result(id, title, "RevisionRequerida",
          `Edificación continua, admitida en la zona ${zone.zone}: verifique que ocupe todo el frente manteniendo el plano de fachada y la altura de la edificación colindante.`,
          allowedText, measured, sources, findings, notes);
    }
  }

  // --- R-11 Afectaciones de utilidad pública -------------------------------------------------------

  private publicUse(input: RuleInput, lot: Polygon, tracks: ElementTrack[], ground: number): RuleResult {
    const id = "R-11";
    const title = "Afectaciones de utilidad pública";
    const layer: NormSource = {
      document: this.norms.localDocument ?? "Plan Regulador Comunal",
      article: "Capas GIS referenciales del PRC",
      quote: input.publicUseLayers ?? "Plazas y parques comunales; fajas de vialidad del PRC.",
      version: null,
      url: this.norms.localUrl,
      page: null,
    };
    const sources: NormSource[] = [];
    if (this.norms.publicUse !== null) sources.push(this.norms.publicUse);
    sources.push(layer);
    const publicUse = input.publicUse ?? null;
    if (publicUse === null) return notVerifiable(id, title, "No hay capas del PRC de plazas, parques ni vialidad para esta ubicación.", sources);

    const notes = ["Las capas del PRC son referenciales: la línea oficial y las afectaciones las fija el Certificado de Informaciones Previas."];
    const areas: { kind: string; name: string; inside: Geometry }[] = [];
    const lines: { kind: string; length: number }[] = [];
    for (const item of publicUse) {
      let inside: Geometry;
      try {
        inside = readGeoJson(item.geometry).intersection(lot);
      } catch (error) {
        if (isTopologyException(error)) continue;
        throw error;
      }
      const polygonal = item.geometry.type === "Polygon" || item.geometry.type === "MultiPolygon";
      const lineal = item.geometry.type === "LineString" || item.geometry.type === "MultiLineString";
      if (polygonal && inside.getArea() > 0.5) areas.push({ kind: item.kind, name: item.name, inside });
      else if (lineal && inside.getLength() > 0.1) lines.push({ kind: item.kind, length: inside.getLength() });
    }
    if (areas.length === 0 && lines.length === 0) {
      return result(id, title, "NoAplica",
        "Las capas del PRC no muestran plazas, parques ni fajas viales de apertura o ensanche sobre el predio.", null, "sin afectaciones en las capas", sources, [], notes);
    }
    const affected = areas.length > 0 ? unionAll(areas.map((a) => a.inside)) : null;
    const findings: ElementFinding[] = [];
    if (affected !== null) {
      for (const t of tracks) {
        const footprint = t.footprint;
        if (isVoid(t.element) || footprint === null || !(t.element.zMax > ground + 0.1) || !footprint.intersects(affected)) continue;
        findings.push(finding(t, areaIn(footprint, affected), "sobre el área afecta a utilidad pública"));
      }
    }
    const parts = [
      ...areas.map((a) => `${F(a.inside.getArea())} m² en ${a.kind} ${a.name}`),
      ...lines.map((l) => `una línea de faja vial (${l.kind}) cruza el predio en ${F(l.length)} m`),
    ];
    if (lines.length > 0) notes.push("Una faja vial de apertura o ensanche que cruza el predio puede dejar parte de él afecta a utilidad pública: la nueva línea oficial la indica el CIP.");
    const summary =
      capitalize(parts[0]) + (parts.length > 1 ? "; " + parts.slice(1).join("; ") : "") + "." +
      (findings.length > 0 ? ` ${findings.length} elemento(s) del proyecto están sobre esa superficie.` : "");
    return result(id, title, "RevisionRequerida", summary, "sin edificación en terrenos afectos (verificar en el CIP)", parts.join(" · "), sources, findings, notes);
  }

  // --- Utilidades ---------------------------------------------------------------------------------

  /** Por qué falta la ficha: la comuna no tiene su Ordenanza incorporada (se conoce la zona) o el predio no está en el PRC. */
  private missingZone(zoneCode: string | null, what: string): string {
    return zoneCode !== null && this.norms.localDocument === null
      ? `${what}: la Ordenanza Local de esta comuna aún no está incorporada (zona ${zoneCode} según las capas del PRC, referenciales).`
      : zoneCode !== null
        ? `${what}: la zona ${zoneCode} no está en la Ordenanza Local cargada.`
        : `${what}: el predio no está en una zona del PRC cargado.`;
  }

  private def(term: string): NormSource {
    return this.norms.definitions.get(term) ?? { document: this.norms.ogucDocument, article: "Art. 1.1.2", quote: term, version: null, url: null, page: null };
  }
}

/** Evalúa las reglas geométricas R-01 a R-11 con el catálogo de normas dado. */
export const evaluarReglas = (norms: NormCatalog, input: RuleInput): RuleEvaluation => new GeometricRuleEngine(norms).evaluate(input);

// ---------- Funciones auxiliares (estáticas en el C#) ----------

const result = (id: string, title: string, state: RuleState, summary: string, required: string | null, measured: string | null,
  sources: NormSource[], elements: ElementFinding[], notes: string[]): RuleResult => ({ id, title, state, summary, required, measured, sources, elements, notes });

const notVerifiable = (id: string, title: string, reason: string, sources: NormSource[] = []): RuleResult =>
  result(id, title, "NoVerificable", reason, null, null, sources, [], []);

const finding = (t: ElementTrack, value: number, detail: string): ElementFinding => ({
  modelId: t.modelId,
  expressId: t.element.expressId,
  globalId: t.element.globalId,
  ifcClass: t.element.ifcClass,
  name: t.element.name,
  value: roundEven(value, 3),
  detail,
});

const capitalize = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

const fraction = (value: number): string =>
  Math.abs(value - 2 / 3) < 0.001 ? "2/3" : Math.abs(value - 0.5) < 0.001 ? "1/2" : `${F(value * 100)} %`;

/** Distinct() de LINQ: conserva el orden de la primera aparición. */
const distinct = <T>(items: T[]): T[] => [...new Set(items)];

/** Minutos de resistencia al fuego en textos como «F-60», «F60», «EI 60», «REI 120», «2 h» o «1HR». */
export function fireMinutes(text: string | null | undefined): number | null {
  if (text === null || text === undefined || text.trim() === "") return null;
  const upper = text.toUpperCase();
  const hours = /(\d+(?:[.,]\d+)?)\s*(?:H|HR|HRS|HORAS?)\b/.exec(upper);
  if (hours) return roundEven(Number.parseFloat(hours[1].replace(",", ".")) * 60, 0);
  const minutes = /(\d{2,3})/.exec(upper);
  return minutes ? Number.parseInt(minutes[1], 10) : null;
}

function zoneAt(parts: Part[], point: Geometry, x: number, y: number): number {
  for (let k = 0; k < parts.length; k++) {
    if (parts[k].prepared.contains(x, y)) return k;
  }
  let best = 0;
  let distance = Number.POSITIVE_INFINITY;
  for (let k = 0; k < parts.length; k++) {
    const d = parts[k].area.distance(point);
    if (d < distance) {
      distance = d;
      best = k;
    }
  }
  return best;
}

/** Superficie por piso sobre el suelo: unión de las huellas de sus elementos, contando todo lo encerrado por el perímetro. */
function storeyAreas(tracks: ElementTrack[], ground: number): StoreyArea[] {
  const groups = new Map<string, ElementTrack[]>();
  for (const t of tracks) {
    if (t.element.storeyName === null || t.element.footprint === null || !(t.element.zMax > ground + 0.1)) continue;
    const group = groups.get(t.element.storeyName);
    if (group) group.push(t);
    else groups.set(t.element.storeyName, [t]);
  }
  const areas: StoreyArea[] = [];
  for (const [name, storey] of groups) {
    const elevation = Math.min(...storey.map((t) => t.element.zMin));
    if (elevation < ground - 0.5) continue; // subterráneo
    const footprints: Geometry[] = [];
    for (const t of storey) {
      const footprint = t.footprint;
      if (footprint !== null) footprints.push(footprint.buffer(0));
    }
    const union = unionAll(footprints);
    const shells: Geometry[] = [];
    for (let g = 0; g < union.getNumGeometries(); g++) {
      const piece = union.getGeometryN(g);
      if (piece.getGeometryType() === "Polygon") shells.push(polygonOf((piece as Polygon).getExteriorRing().getCoordinates()));
    }
    const filled = shells.length > 0 ? unionAll(shells) : polygonOf();
    areas.push({ name, elevation, area: filled.getArea(), filled });
  }
  return areas.sort((a, b) => a.elevation - b.elevation);
}

function areaIn(geometry: Geometry, part: Geometry): number {
  try {
    return geometry.intersection(part).getArea();
  } catch (error) {
    if (!isTopologyException(error)) throw error;
    return geometry.buffer(0).intersection(part.buffer(0)).getArea();
  }
}

function coefficientResult(id: string, title: string, ratio: number, max: number, measured: string, sources: NormSource[], notes: string[]): RuleResult {
  let state: RuleState;
  if (ratio > max + 0.005) state = Math.abs(ratio - max) / max < 0.03 ? "RevisionRequerida" : "NoCumple";
  else state = Math.abs(ratio - max) / max < 0.03 ? "RevisionRequerida" : "Cumple";
  const summary = `${F(ratio, 2)} (${ratio <= max + 0.005 ? "dentro" : "sobre"} del máximo ${F(max, 2)}).`;
  return result(id, title, state, summary, F(max, 2), `${F(ratio, 2)} = ${measured}`, sources, [], notes);
}

/**
 * Aislada si ningún cuerpo de más de 3,5 m está en un deslinde (lo que está en él y es más bajo es adosamiento); pareada si está en un
 * deslinde lateral; continua si está en los dos laterales. Laterales: los deslindes con vecino que comparten un vértice con un frente.
 */
function classify(neighbours: Edge[], fronts: Edge[], contacts: EdgeContact[]): GroupingResult {
  const tall = neighbours.map((_, k) => k).filter((k) => contacts[k].pareoHeight > Number.NEGATIVE_INFINITY);
  if (tall.length === 0) return { type: "aislado", contact: tall, detail: "ningún cuerpo de más de 3,5 m está en los deslindes" };
  const touch = (a: Coordinate, b: Coordinate): boolean => Math.sqrt((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y)) < 1e-6;
  const lateral = new Set(
    neighbours.map((_, k) => k).filter((k) => fronts.some((f) => touch(neighbours[k].a, f.b) || touch(neighbours[k].b, f.a) || touch(neighbours[k].a, f.a) || touch(neighbours[k].b, f.b))),
  );
  const names = tall.map((k) => `${neighbours[k].number}`).join(" y ");
  if (!tall.every((k) => lateral.has(k))) {
    return { type: null, contact: tall, detail: `hay cuerpos de más de 3,5 m en el deslinde ${names}, que no es lateral respecto del frente` };
  }
  return tall.length === 1
    ? { type: "pareado", contact: tall, detail: `cuerpo de ${F(contacts[tall[0]].pareoHeight)} m en el deslinde lateral ${names}` }
    : { type: "continuo", contact: tall, detail: `cuerpos de más de 3,5 m en los deslindes laterales ${names}` };
}

/**
 * Cifras de la ficha que el motor no aplica con certeza (advertencias de la extracción o una rasante propia distinta de la de la
 * región): la regla que las usa nunca queda en «Cumple» ni en «No cumple», sino en revisión, con la advertencia en las notas.
 */
function applyZoneWarnings(results: RuleResult[], parts: Part[], angle: number | null): RuleResult[] {
  const warnings: { zone: string; field: string; text: string }[] = [];
  for (const p of parts) {
    if (p.norms === null) continue;
    for (const w of p.norms.warnings) warnings.push({ zone: p.norms.zone, field: w.field, text: w.text });
  }
  for (const part of parts) {
    const zone = part.norms;
    if (zone !== null && zone.rasanteDegrees !== null && angle !== null && Math.abs(zone.rasanteDegrees - angle) > 0.01) {
      warnings.push({ zone: zone.zone, field: "rasante", text: `La ficha fija una rasante de ${F(zone.rasanteDegrees)}° («${zone.rasanteText}») y la región, ${F(angle)}°: el motor usa la de la región.` });
    }
  }
  if (warnings.length === 0) return results;
  return results.map((r) => {
    const fields = WARNING_FIELDS[r.id];
    if (!fields) return r;
    const applicable = distinct(warnings.filter((w) => fields.includes(w.field)).map((w) => `⚠ Zona ${w.zone}: ${w.text}`));
    if (applicable.length === 0) return r;
    // Un antejardín que la ficha no fija como cifra (depende de la cuadra, del CIP…) tampoco permite decir «no aplica».
    const yardUnknown = r.id === "R-05" && r.state === "NoAplica" && warnings.some((w) => w.field === "antejardin");
    const state: RuleState = r.state === "Cumple" || r.state === "NoCumple" || yardUnknown ? "RevisionRequerida" : r.state;
    return { ...r, state, notes: [...applicable, ...r.notes] };
  });
}

/**
 * Corte por el punto (x, y) perpendicular a la línea de rasante: los elementos cuya huella cruza el corte aparecen como tramos
 * (caja vertical del elemento), para dibujar la rasante proyectada sobre el edificio.
 */
function section(line: RasanteLine, x: number, y: number, h: number, critical: ElementTrack, lot: Polygon, tracks: ElementTrack[], ground: number): RasanteSection {
  // Pie de la perpendicular sobre la línea (sin salir del tramo) y largo del corte hasta el deslinde opuesto.
  const dx = line.bx - line.ax;
  const dy = line.by - line.ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? clamp(((x - line.ax) * dx + (y - line.ay) * dy) / len2, 0, 1) : 0;
  const ox = line.ax + t * dx;
  const oy = line.ay + t * dy;
  const length = Math.max(...lot.getCoordinates().map((c) => (c.x - ox) * line.inwardX + (c.y - oy) * line.inwardY)) + 1;
  const cut = lineOf([coordinate(ox, oy), coordinate(ox + line.inwardX * length, oy + line.inwardY * length)]);
  const envelope = cut.getEnvelopeInternal();
  const blocks: SectionBlock[] = [];
  for (const track of tracks) {
    const e = track.element;
    const footprint = track.footprint;
    if (isVoid(e) || footprint === null || e.zMax - ground <= TOLERANCE) continue;
    if (e.xMax < envelope.getMinX() || e.xMin > envelope.getMaxX() || e.yMax < envelope.getMinY() || e.yMin > envelope.getMaxY()) continue;
    let hit: Geometry;
    try {
      hit = footprint.intersection(cut);
    } catch (error) {
      if (isTopologyException(error)) continue;
      throw error;
    }
    for (let g = 0; g < hit.getNumGeometries(); g++) {
      const part = hit.getGeometryN(g).getCoordinates();
      if (part.length === 0) continue;
      const ss = part.map((c) => (c.x - ox) * line.inwardX + (c.y - oy) * line.inwardY);
      const min = Math.min(...ss);
      blocks.push({ s0: min, s1: Math.max(Math.max(...ss), min + 0.05), bottom: Math.max(0, e.zMin - ground), top: e.zMax - ground });
    }
  }
  const s = (x - ox) * line.inwardX + (y - oy) * line.inwardY;
  const name = critical.element.name;
  const label = name !== null && name.length > 0 ? `${critical.element.ifcClass} «${name}»` : critical.element.ifcClass;
  return { line, originX: ox, originY: oy, length, blocks, criticalS: s, criticalHeight: h, criticalElement: label };
}

function counterClockwise(ring: Coordinate[], edges: ParcelEdge[]): { ring: Coordinate[]; infos: ParcelEdge[]; numbers: number[] } {
  let area = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    area += a.x * b.y - b.x * a.y;
  }
  const n = ring.length;
  if (area > 0) return { ring: [...ring], infos: [...edges], numbers: ring.map((_, i) => i + 1) };
  const reversed = ring.map((_, k) => ring[n - 1 - k]);
  const original = ring.map((_, k) => (((n - 2 - k) % n) + n) % n);
  return { ring: reversed, infos: original.map((i) => edges[i]), numbers: original.map((i) => i + 1) };
}

/** Deslinde más cercano; con skip, sin los que no corresponden (índice −1 si no queda ninguno). */
function nearest(x: number, y: number, edges: Edge[], skip?: (k: number) => boolean): [number, number] {
  let best = Number.POSITIVE_INFINITY;
  let index = -1;
  for (let k = 0; k < edges.length; k++) {
    if (skip?.(k) === true) continue;
    const d = segmentDistance(x, y, edges[k].a, edges[k].b);
    if (d < best) {
      best = d;
      index = k;
    }
  }
  return [best, index];
}

function projection(x: number, y: number, e: Edge): number {
  const t = ((x - e.a.x) * (e.b.x - e.a.x) + (y - e.a.y) * (e.b.y - e.a.y)) / (e.length * e.length);
  return clamp(t, 0, 1) * e.length;
}

/** Largo cubierto por los puntos proyectados sobre el deslinde (los puntos de aristas vienen cada ~1 m). */
const coveredLength = (positions: number[], length: number): number =>
  Math.min(intervalsOf(positions).reduce((sum, s) => sum + (s[1] - s[0]), 0), length);

/** Tramos continuos de posiciones sobre un deslinde (se unen los huecos de hasta 1,2 m). */
function intervalsOf(positions: number[]): Span[] {
  const sorted = [...positions].sort((a, b) => a - b);
  const spans: Span[] = [];
  if (sorted.length === 0) return spans;
  let start = sorted[0];
  let end = sorted[0];
  for (const t of sorted.slice(1)) {
    if (t - end <= 1.2) {
      end = t;
      continue;
    }
    spans.push([start, end]);
    start = end = t;
  }
  spans.push([start, end]);
  return spans;
}

/** Unión de tramos que se tocan o se superponen. */
function mergeSpans(spans: Span[]): Span[] {
  const merged: Span[] = [];
  for (const span of [...spans].sort((a, b) => a[0] - b[0])) {
    const last = merged[merged.length - 1];
    if (last && span[0] <= last[1] + TOLERANCE) merged[merged.length - 1] = [last[0], Math.max(last[1], span[1])];
    else merged.push(span);
  }
  return merged;
}

/** Largo de needed que no queda cubierto por cover. */
function uncovered(needed: Span[], cover: Span[]): number {
  const merged = mergeSpans(cover);
  let missing = 0;
  for (const [t0, t1] of needed) {
    const covered = merged.reduce((sum, c) => sum + Math.max(0, Math.min(t1, c[1] + CONTACT_DISTANCE) - Math.max(t0, c[0] - CONTACT_DISTANCE)), 0);
    missing += Math.max(0, t1 - t0 - covered);
  }
  return missing;
}

function segmentDistance(x: number, y: number, a: Coordinate, b: Coordinate): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : clamp(((x - a.x) * dx + (y - a.y) * dy) / len2, 0, 1);
  const px = a.x + t * dx - x;
  const py = a.y + t * dy - y;
  return Math.sqrt(px * px + py * py);
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
