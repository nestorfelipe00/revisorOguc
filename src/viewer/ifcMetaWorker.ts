// Metadatos del IFC leídos con web-ifc en un Web Worker: esquema, unidades, IfcMapConversion/CRS e IfcSite.
// Reemplaza lo que en el escritorio escribe el motor IfcOpenShell en model_meta (write_meta de bnc_ifc.py).
import * as WebIFC from "web-ifc";
import type { Georeference, ModelGeolocation } from "@/lib/territorio/location";

export interface IfcMeta {
  schema: string;
  /** Metros por unidad de longitud del proyecto (0,001 si el IFC está en mm). */
  lengthScale: number;
  geolocation: ModelGeolocation;
  /** Advertencias de lectura (p. ej. unidad de longitud no reconocida). */
  warnings: string[];
}

export type MetaRequest = { bytes: Uint8Array; wasmPath: string };
export type MetaResponse = { type: "done"; meta: IfcMeta } | { type: "error"; message: string };

type Handle = { type: number; value: unknown } | null | undefined;

const val = (h: unknown): unknown => (h && typeof h === "object" && "value" in (h as object) ? (h as { value: unknown }).value : h);
const num = (h: unknown, fallback = 0): number => {
  const v = val(h);
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
};
const str = (h: unknown): string | null => {
  const v = val(h);
  return typeof v === "string" && v.length > 0 ? v : null;
};

/** IfcCompoundPlaneAngleMeasure [grados, minutos, segundos, millonésimas] → grados decimales, con el signo del primer componente no nulo. */
function compoundAngle(h: unknown): number | null {
  const v = val(h);
  if (typeof v === "number") return v;
  if (!Array.isArray(v) || v.length === 0) return null;
  const parts = v.map((p) => num(p));
  const sign = parts.find((p) => p !== 0) ?? 0;
  const s = sign < 0 ? -1 : 1;
  const [d = 0, m = 0, sec = 0, micro = 0] = parts.map(Math.abs);
  return s * (d + m / 60 + sec / 3600 + micro / 3_600_000_000);
}

const PREFIXES: Record<string, number> = { EXA: 1e18, PETA: 1e15, TERA: 1e12, GIGA: 1e9, MEGA: 1e6, KILO: 1e3, HECTO: 1e2, DECA: 10, DECI: 0.1, CENTI: 0.01, MILLI: 0.001, MICRO: 1e-6, NANO: 1e-9 };

function lengthScale(api: WebIFC.IfcAPI, modelID: number, warnings: string[]): number {
  // Unidad de longitud del proyecto: IfcSIUnit (METRE con prefijo) o IfcConversionBasedUnit (pies, pulgadas).
  const assignments = api.GetLineIDsWithType(modelID, WebIFC.IFCUNITASSIGNMENT);
  for (let i = 0; i < assignments.size(); i++) {
    const assignment = api.GetLine(modelID, assignments.get(i)) as { Units?: Handle[] };
    for (const unitRef of assignment.Units ?? []) {
      const id = num(unitRef, -1);
      if (id < 0) continue;
      const unit = api.GetLine(modelID, id) as { UnitType?: Handle; Prefix?: Handle; Name?: Handle; ConversionFactor?: Handle };
      if (str(unit.UnitType) !== "LENGTHUNIT") continue;
      const name = str(unit.Name);
      if (name === "METRE") return PREFIXES[str(unit.Prefix) ?? ""] ?? 1;
      if (unit.ConversionFactor) {
        const factor = api.GetLine(modelID, num(unit.ConversionFactor, -1), true) as { ValueComponent?: Handle; UnitComponent?: { Prefix?: Handle; Name?: Handle } };
        const base = PREFIXES[str(factor.UnitComponent?.Prefix) ?? ""] ?? 1;
        const value = num(factor.ValueComponent, 0);
        if (value > 0) return value * base;
      }
      warnings.push(`Unidad de longitud «${name ?? "desconocida"}» no reconocida: se asumen metros.`);
      return 1;
    }
  }
  warnings.push("El IFC no declara unidad de longitud: se asumen metros.");
  return 1;
}

function mapConversion(api: WebIFC.IfcAPI, modelID: number, scale: number): Georeference | null {
  // IFC4 / IFC4X3: IfcMapConversion + IfcProjectedCRS.
  const conversions = api.GetLineIDsWithType(modelID, WebIFC.IFCMAPCONVERSION);
  if (conversions.size() > 0) {
    const c = api.GetLine(modelID, conversions.get(0)) as Record<string, Handle>;
    let crsName: string | null = null;
    const target = num(c.TargetCRS, -1);
    if (target >= 0) {
      const crs = api.GetLine(modelID, target) as { Name?: Handle; MapZone?: Handle };
      crsName = [str(crs.Name), str(crs.MapZone)].filter(Boolean).join(" ") || null;
    }
    return {
      crsName,
      eastings: num(c.Eastings),
      northings: num(c.Northings),
      height: num(c.OrthogonalHeight),
      xAxisAbscissa: num(c.XAxisAbscissa, 1),
      xAxisOrdinate: num(c.XAxisOrdinate, 0),
      scale: num(c.Scale, 1) || 1,
      lengthScale: scale,
    };
  }
  // IFC2X3: ePSet_MapConversion / ePSet_ProjectedCRS sobre el IfcSite o el IfcProject.
  const psets = api.GetLineIDsWithType(modelID, WebIFC.IFCPROPERTYSET);
  const values: Record<string, unknown> = {};
  let found = false;
  for (let i = 0; i < psets.size(); i++) {
    const pset = api.GetLine(modelID, psets.get(i)) as { Name?: Handle; HasProperties?: Handle[] };
    const name = str(pset.Name) ?? "";
    if (!/^ePSet_(MapConversion|ProjectedCRS)$/i.test(name)) continue;
    found = true;
    for (const ref of pset.HasProperties ?? []) {
      const p = api.GetLine(modelID, num(ref, -1)) as { Name?: Handle; NominalValue?: Handle };
      const key = str(p.Name);
      if (key) values[key] = val(p.NominalValue);
    }
  }
  if (!found) return null;
  const n = (k: string, f = 0) => (typeof values[k] === "number" ? (values[k] as number) : f);
  return {
    crsName: [values.Name, values.MapZone].filter((v) => typeof v === "string" && v).join(" ") || null,
    eastings: n("Eastings"),
    northings: n("Northings"),
    height: n("OrthogonalHeight"),
    xAxisAbscissa: n("XAxisAbscissa", 1),
    xAxisOrdinate: n("XAxisOrdinate", 0),
    scale: n("Scale", 1) || 1,
    lengthScale: scale,
  };
}

export function readMeta(api: WebIFC.IfcAPI, modelID: number): IfcMeta {
  const warnings: string[] = [];
  const schema = api.GetModelSchema(modelID) ?? "desconocido";
  const scale = lengthScale(api, modelID, warnings);

  let siteLatitude: number | null = null;
  let siteLongitude: number | null = null;
  const sites = api.GetLineIDsWithType(modelID, WebIFC.IFCSITE);
  if (sites.size() > 0) {
    const site = api.GetLine(modelID, sites.get(0)) as { RefLatitude?: Handle; RefLongitude?: Handle };
    siteLatitude = compoundAngle(site.RefLatitude);
    siteLongitude = compoundAngle(site.RefLongitude);
  }

  return { schema, lengthScale: scale, geolocation: { mapConversion: mapConversion(api, modelID, scale), siteLatitude, siteLongitude }, warnings };
}

const scope = self as unknown as { postMessage(message: MetaResponse): void; onmessage: ((event: MessageEvent<MetaRequest>) => void) | null };

scope.onmessage = async (event) => {
  const api = new WebIFC.IfcAPI();
  let modelID = -1;
  try {
    api.SetWasmPath(event.data.wasmPath, true);
    await api.Init();
    modelID = api.OpenModel(event.data.bytes, { COORDINATE_TO_ORIGIN: false });
    scope.postMessage({ type: "done", meta: readMeta(api, modelID) });
  } catch (error) {
    scope.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) });
  } finally {
    if (modelID >= 0) api.CloseModel(modelID);
  }
};
