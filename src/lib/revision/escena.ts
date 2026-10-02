// Lo que la revisión entrega al visor y al panel: volumen teórico, planos de rasante y cortes por rasante.
// Porte de RasanteSections / RasanteSceneOf (MainViewModel.Rules.cs) y de RasanteSectionItem.
import type { EnvelopeGrid, RasanteScene } from "@/viewer/protocol";
import { rasanteExcess, rasanteLimit, type RasanteGeometry, type RasanteSection, type TheoreticalVolume } from "@/lib/reglas/tipos";

export function envelopeGrid(v: TheoreticalVolume | null | undefined): EnvelopeGrid | null {
  if (!v) return null;
  return { x0: v.x0, y0: v.y0, step: v.step, columns: v.columns, rows: v.rows, heights: Array.from(v.heights), groundZ: v.groundZ, volumeM3: v.volumeM3 };
}

/** Planos de rasante para el visor: suben hasta la altura de la zona (o un poco sobre el edificio si no se conoce). */
export function rasanteScene(r: RasanteGeometry | null | undefined): RasanteScene | null {
  if (!r) return null;
  const tallest = r.sections.length > 0 ? Math.max(...r.sections.map((s) => s.criticalHeight)) : 0;
  const top = r.zoneHeight ?? Math.max(10, tallest + 3);
  return {
    angle: r.angle,
    groundZ: r.groundZ,
    topHeight: top,
    lines: r.lines.map((l) => ({ number: l.number, kind: l.kind, ax: l.ax, ay: l.ay, bx: l.bx, by: l.by, inwardX: l.inwardX, inwardY: l.inwardY })),
    critical: r.sections.map((s) => ({
      x: s.originX + s.line.inwardX * s.criticalS,
      y: s.originY + s.line.inwardY * s.criticalS,
      height: s.criticalHeight,
      limit: rasanteLimit(s, r.angle),
    })),
  };
}

export interface SectionItem {
  title: string;
  caption: string;
  section: RasanteSection;
}

const f = (value: number) => (Math.round(value * 100) / 100).toLocaleString("es-CL", { maximumFractionDigits: 2 });

/** Un corte por línea de rasante, del más comprometido al más holgado, con el texto del escritorio. */
export function rasanteSections(r: RasanteGeometry | null | undefined): SectionItem[] {
  if (!r) return [];
  return [...r.sections]
    .sort((a, b) => rasanteExcess(b, r.angle) - rasanteExcess(a, r.angle))
    .map((s) => {
      const title =
        s.line.kind === "Frente"
          ? `Corte por el frente (deslinde ${s.line.number}): rasante desde el eje entre líneas oficiales`
          : s.line.kind === "AreaVerde"
            ? `Corte por el deslinde ${s.line.number} con área verde`
            : `Corte por el deslinde ${s.line.number} con vecino`;
      const fromLot = s.criticalS - s.line.offset;
      const where = s.line.offset > 0 ? `a ${f(fromLot)} m de la línea oficial (${f(s.criticalS)} m del eje)` : `a ${f(fromLot)} m del deslinde`;
      const excess = rasanteExcess(s, r.angle);
      const caption =
        `${s.criticalElement ?? "Elemento"}: ${f(s.criticalHeight)} m de altura ${where}. La rasante permite ${f(rasanteLimit(s, r.angle))} m ` +
        (excess > 0.01 ? `→ sobrepasa ${f(excess)} m.` : `→ holgura ${f(-excess)} m.`);
      return { title, caption, section: s };
    });
}
