// Porte fiel de Infrastructure/Rules/CabidaStudy.cs: estudio de cabida sin modelo IFC. Con el predio y la zona, el volumen teórico
// (altura, rasantes, distanciamientos y antejardín) se corta en pisos de una altura supuesta y cada planta se limita con la ocupación
// de suelo (primer piso) y el total con la constructibilidad. La altura de piso a piso es un supuesto de diseño, no una norma.
import type { NormCatalog, ZoneNorms } from "./normas";
import { isTopologyException, polygonOf, readGeoJson, coordinate } from "./jsts";
import { F, GeometricRuleEngine } from "./motor";
import type { CabidaEvaluation, CabidaFloor, NormSource, RuleInput, RuleResult } from "./tipos";

interface ZoneArea {
  code: string | null;
  norms: ZoneNorms | null;
  area: number;
}

export class CabidaStudy {
  constructor(private readonly norms: NormCatalog) {}

  evaluate(input: RuleInput, floorHeight: number): CabidaEvaluation {
    const evaluation = new GeometricRuleEngine(this.norms).evaluate({ ...input, models: [] });
    const lotArea = evaluation.lotArea;
    const parts = this.zoneAreas(input, lotArea);
    const byId = new Map(evaluation.results.map((r) => [r.id, r]));

    const cosLimit = parts.every((p) => p.norms?.landCoverage != null) ? parts.reduce((sum, p) => sum + (p.norms?.landCoverage ?? 0) * p.area, 0) : null;
    const ccLimit = parts.every((p) => p.norms?.floorAreaRatio != null) ? parts.reduce((sum, p) => sum + (p.norms?.floorAreaRatio ?? 0) * p.area, 0) : null;
    const floorLimits = parts.map((p) => p.norms?.maxFloors ?? null).filter((f): f is number => f !== null);
    const minFloors = floorLimits.length === 0 ? 0 : Math.min(...floorLimits);
    const maxFloors = minFloors > 0 ? minFloors : null;

    // Pisos: la planta de cada uno es la parte del volumen teórico donde cabe completo (altura permitida ≥ su techo).
    const floors: CabidaFloor[] = [];
    const v = evaluation.volume;
    if (v !== null && floorHeight > 0) {
      const cell = v.step * v.step;
      for (let k = 1; maxFloors === null || k <= maxFloors; k++) {
        const top = k * floorHeight;
        let cells = 0;
        for (const h of v.heights) if (h >= top - 0.01) cells++;
        const envelope = cells * cell;
        if (envelope <= 0) break;
        const area = k === 1 && cosLimit !== null ? Math.min(envelope, cosLimit) : envelope;
        floors.push({ number: k, base: top - floorHeight, top, envelopeArea: envelope, area });
      }
    }
    const geometric = floors.reduce((sum, f) => sum + f.area, 0);
    const buildable = ccLimit !== null ? Math.min(geometric, ccLimit) : geometric;

    const pick = (id: string): RuleResult => {
      const r = byId.get(id);
      if (!r) throw new Error(`Falta el resultado ${id} del motor de reglas.`);
      return r;
    };
    const results: RuleResult[] = [
      this.zoneNormsResult(parts, lotArea, input),
      this.capacityResult(parts, floors, floorHeight, geometric, buildable, cosLimit, ccLimit, maxFloors, lotArea, evaluation.volume !== null),
      pick("R-08"),
      pick("R-09"),
      pick("R-11"),
    ];
    return { results, volume: evaluation.volume, lotArea, rasantes: evaluation.rasantes, floors, buildableArea: buildable };
  }

  private zoneAreas(input: RuleInput, lotArea: number): ZoneArea[] {
    const lot = polygonOf([...input.lotRing.map((p) => coordinate(p.x, p.y)), coordinate(input.lotRing[0].x, input.lotRing[0].y)]);
    const parts: ZoneArea[] = [];
    for (const part of input.zoneParts ?? []) {
      const geometry = readGeoJson(part.area);
      let area: number;
      try {
        area = geometry.intersection(lot).getArea();
      } catch (error) {
        if (!isTopologyException(error)) throw error;
        area = geometry.buffer(0).intersection(lot).getArea();
      }
      if (area >= lotArea * 0.005) parts.push({ code: part.code, norms: this.norms.zone(part.code), area });
    }
    if (parts.length === 0) parts.push({ code: input.zoneCode, norms: this.norms.zone(input.zoneCode), area: lotArea });
    return parts.sort((a, b) => b.area - a.area);
  }

  // --- C-01 Normas del predio ------------------------------------------------------------------------

  private zoneNormsResult(parts: ZoneArea[], lotArea: number, input: RuleInput): RuleResult {
    const id = "C-01";
    const title = "Normas urbanísticas del predio";
    if (parts.every((p) => p.norms === null)) {
      return { id, title, state: "NoVerificable", summary: "El predio no está en una zona del PRC con normas cargadas.", required: null, measured: null, sources: [], elements: [], notes: [] };
    }
    const sources: NormSource[] = [];
    const lines: string[] = [];
    for (const part of parts) {
      const z = part.norms;
      if (z === null) continue;
      const figure = (value: number | null, unit: string, text: string | null): string => {
        if (text !== null) sources.push(this.norms.zoneSource(z, text));
        return value !== null ? `${F(value)}${unit}` : "sin límite en la ficha";
      };
      const share = parts.length > 1 ? ` (${F(part.area)} m², ${F((part.area / lotArea) * 100, 1)} %)` : "";
      const height = figure(z.maxHeight, " m", z.heightText);
      const floors = z.maxFloors !== null ? ` y ${z.maxFloors} pisos` : "";
      const coverage = figure(z.landCoverage, "", z.landCoverageText);
      const ratio = figure(z.floorAreaRatio, "", z.floorAreaRatioText);
      const yard = figure(z.frontYard, " m", z.frontYardText);
      lines.push(
        `Zona ${z.zone}${share}: altura ${height}${floors}; ocupación de suelo ${coverage}; constructibilidad ${ratio}; antejardín ${yard}; ` +
          `agrupamiento ${z.groupingText ?? z.grouping.join(", ")}.`,
      );
      if (z.groupingText !== null) sources.push(this.norms.zoneSource(z, z.groupingText));
    }
    const angle = this.norms.rasanteAngle(input.region);
    const notes = [...lines];
    if (angle !== null) {
      notes.push(`Rasante de ${F(angle)}° (región de ${input.region}) desde los deslindes con vecinos y áreas verdes, y desde el eje entre líneas oficiales en los frentes.`);
      sources.push(this.norms.rasante, this.norms.rasanteTable);
    }
    notes.push("Distanciamientos según la altura: 1,4 / 2,5 / 4,0 m sin vano y 3,0 / 3,0 / 4,0 m con vano (hasta 3,5 m, hasta 7 m y más de 7 m).");
    sources.push(this.norms.setbackSource);
    if (parts.length > 1) sources.push(this.norms.multiZoneEach);
    const principal = parts[0].norms ?? parts.find((p) => p.norms !== null)?.norms;
    if (!principal) throw new Error("Sin zona con normas.");
    const summary = parts.length > 1
      ? `El predio de ${F(lotArea)} m² abarca ${parts.length} zonas: ${parts.map((p) => p.code ?? "").join(", ")}.`
      : `Predio de ${F(lotArea)} m² en la zona ${principal.zone}: altura máxima ${principal.maxHeight !== null ? `${F(principal.maxHeight)} m` : "sin límite en la ficha"}, ` +
        `ocupación ${principal.landCoverage !== null ? F(principal.landCoverage) : "sin límite"}, constructibilidad ${principal.floorAreaRatio !== null ? F(principal.floorAreaRatio) : "sin límite"}.`;
    return { id, title, state: "Informativo", summary, required: null, measured: `predio ${F(lotArea)} m²`, sources: distinctSources(sources), elements: [], notes };
  }

  // --- C-02 Cabida ---------------------------------------------------------------------------------------

  private capacityResult(parts: ZoneArea[], floors: CabidaFloor[], floorHeight: number, geometric: number, buildable: number,
    cosLimit: number | null, ccLimit: number | null, maxFloors: number | null, lotArea: number, hasVolume: boolean): RuleResult {
    const id = "C-02";
    const title = "Cabida: superficie edificable";
    const sources = [this.def("Coeficiente de ocupación del suelo"), this.def("Coeficiente de constructibilidad"), this.def("Volumen teórico")];
    for (const part of parts) {
      const z = part.norms;
      if (z === null) continue;
      if (z.landCoverageText !== null) sources.push(this.norms.zoneSource(z, z.landCoverageText));
      if (z.floorAreaRatioText !== null) sources.push(this.norms.zoneSource(z, z.floorAreaRatioText));
    }
    if (parts.length > 1) sources.push(this.norms.multiZoneAverage);
    if (!hasVolume) {
      return { id, title, state: "NoVerificable", summary: "Faltan la altura de la zona o las rasantes para calcular el volumen teórico.", required: null, measured: null, sources, elements: [], notes: [] };
    }

    const notes = [`Supuesto de diseño: ${F(floorHeight)} m de piso a piso (no es una norma; se cambia junto a «Calcular cabida»).`];
    if (floorHeight < this.norms.minCeilingHeight) {
      notes.push(`El piso a piso es menor que la altura mínima de piso a cielo de ${F(this.norms.minCeilingHeight)} m.`);
      sources.push(this.norms.minCeilingSource);
    }
    for (const f of floors) {
      const cap = f.area < f.envelopeArea - 0.01 ? ` (el volumen admite ${F(f.envelopeArea)} m²; limita la ocupación de suelo)` : "";
      notes.push(`Piso ${f.number} (${F(f.base)} a ${F(f.top)} m): ${F(f.area)} m²${cap}.`);
    }
    if (maxFloors !== null && floors.length === maxFloors) notes.push(`La ficha limita a ${maxFloors} pisos.`);
    if (ccLimit !== null && geometric > ccLimit + 0.01) {
      notes.push(`La constructibilidad limita la cabida: el volumen admite ${F(geometric)} m² y el coeficiente, ${F(ccLimit)} m².`);
    } else if (ccLimit !== null) {
      notes.push(`El volumen teórico limita la cabida: ${F(geometric)} m², bajo los ${F(ccLimit)} m² de la constructibilidad.`);
    }
    notes.push("Plantas medidas dentro de la envolvente con distanciamientos sin vano (la mayor); con vanos a menos de 3 m de los deslindes la planta es menor.");
    notes.push("No incluye adosamientos ni descuenta afectaciones de utilidad pública, circulaciones ni muros.");

    const required = [
      cosLimit !== null ? `primer piso ≤ ${F(cosLimit)} m² (ocupación)` : null,
      ccLimit !== null ? `total ≤ ${F(ccLimit)} m² (constructibilidad)` : null,
    ].filter((s): s is string => s !== null).join(" · ");
    const summary = floors.length === 0
      ? "El volumen teórico no admite un piso completo con esa altura de piso a piso."
      : `Hasta ${F(buildable)} m² edificables en ${floors.length} piso${floors.length === 1 ? "" : "s"} de ${F(floorHeight)} m, con un primer piso de hasta ${F(floors[0].area)} m².`;
    return {
      id, title, state: "Informativo", summary, required: required.length > 0 ? required : null,
      measured: `cabida ${F(buildable)} m² · ${floors.length} pisos · predio ${F(lotArea)} m²`, sources: distinctSources(sources), elements: [], notes,
    };
  }

  private def(term: string): NormSource {
    return this.norms.definitions.get(term) ?? { document: this.norms.ogucDocument, article: "Art. 1.1.2", quote: term, version: null, url: null, page: null };
  }
}

/** DistinctBy(s => (s.Article, s.Quote)): conserva la primera aparición. */
function distinctSources(sources: NormSource[]): NormSource[] {
  const seen = new Set<string>();
  const unique: NormSource[] = [];
  for (const s of sources) {
    const key = `${s.article}\u0000${s.quote}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(s);
  }
  return unique;
}

/** Estudio de cabida con el predio y la zona (sin modelo), con floorHeight m de piso a piso. */
export const evaluarCabida = (norms: NormCatalog, input: RuleInput, floorHeight: number): CabidaEvaluation => new CabidaStudy(norms).evaluate(input, floorHeight);
