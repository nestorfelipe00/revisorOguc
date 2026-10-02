// Edición de la georreferencia desde el visor (colocación rápida y ajuste fino): porte del núcleo de
// GeoreferenceViewModel.cs con valores numéricos y vista previa en vivo por cada cambio.
import { frameToUtm } from "./location";
import { toGeographic } from "./utm";
import { centeredAt, formatNumber, movedAndRotated, normalizeDegrees, placementFrame, type UserPlacement } from "./colocacion";

export type Direccion = "N" | "S" | "E" | "O" | "+X" | "-X" | "+Y" | "-Y";

export class EditorColocacion {
  current: UserPlacement;
  step = 1;
  private readonly undoStack: UserPlacement[] = [];

  /**
   * @param initial georreferencia de partida
   * @param pivot centro del modelo en planta (coordenadas del modelo): pivote de todo giro
   * @param onChange vista previa en vivo con cada georreferencia válida
   */
  constructor(
    readonly initial: UserPlacement,
    readonly pivot: { x: number; y: number },
    private readonly onChange: (placement: UserPlacement) => void,
  ) {
    this.current = initial;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  /** Centro del modelo con los valores actuales, en UTM y lat/lon. */
  centerText(): string {
    const utm = frameToUtm(placementFrame(this.current), this.pivot.x, this.pivot.y);
    const geo = toGeographic(utm);
    return `Centro del modelo: E ${formatNumber(utm.easting, 2)} · N ${formatNumber(utm.northing, 2)} (${formatNumber(geo.latitude, 6)}, ${formatNumber(geo.longitude, 6)})`;
  }

  /** Con estos valores el modelo queda en Chile continental. */
  inChile(): boolean {
    const geo = toGeographic(frameToUtm(placementFrame(this.current), this.pivot.x, this.pivot.y));
    return geo.latitude > -56 && geo.latitude < -17 && geo.longitude > -76 && geo.longitude < -66;
  }

  error(): string | null {
    return this.inChile() ? null : "Con estos valores el modelo queda fuera de Chile: revise Este y Norte.";
  }

  /** Distancia en planta entre el centro de partida y el actual (m). */
  offsetFromStart(): number {
    const start = frameToUtm(placementFrame(this.initial), this.pivot.x, this.pivot.y);
    const now = frameToUtm(placementFrame(this.current), this.pivot.x, this.pivot.y);
    return Math.hypot(now.easting - start.easting, now.northing - start.northing);
  }

  private push(): void {
    this.undoStack.push(this.current);
    if (this.undoStack.length > 50) this.undoStack.shift();
  }

  private commit(next: UserPlacement): void {
    this.current = next;
    this.onChange(next);
  }

  /** Mueve en ejes del mapa (N, S, E, O) o del modelo (+X, −X, +Y, −Y) un paso. */
  move(direction: Direccion): void {
    this.push();
    const r = (this.current.rotationDegrees * Math.PI) / 180;
    const [cos, sin] = [Math.cos(r), Math.sin(r)];
    const s = this.step;
    const delta: Record<Direccion, [number, number]> = {
      N: [0, s], S: [0, -s], E: [s, 0], O: [-s, 0],
      "+X": [s * cos, s * sin], "-X": [-s * cos, -s * sin], "+Y": [-s * sin, s * cos], "-Y": [s * sin, -s * cos],
    };
    const [de, dn] = delta[direction];
    this.commit({ ...this.current, easting: this.current.easting + de, northing: this.current.northing + dn });
  }

  /** Sube (+) o baja (−) un paso; si la cota era automática parte de `base` (cota estimada) o de 0. */
  raise(sign: "+" | "-", base: number | null = null): void {
    this.push();
    const from = this.current.elevation ?? base ?? 0;
    this.commit({ ...this.current, elevation: from + (sign === "+" ? this.step : -this.step) });
  }

  /** Cambia la cota en `delta` m (control vertical de la colocación rápida). */
  elevate(delta: number, base: number | null = null): void {
    if (!Number.isFinite(delta) || delta === 0) return;
    this.push();
    const from = this.current.elevation ?? base ?? 0;
    this.commit({ ...this.current, elevation: Math.round((from + delta) * 1000) / 1000 });
  }

  setElevation(elevation: number | null): void {
    this.push();
    this.commit({ ...this.current, elevation });
  }

  /** Gira un paso (grados) alrededor del centro del modelo. */
  rotate(sign: "+" | "-"): void {
    this.turn(sign === "+" ? this.step : -this.step);
  }

  /** Giro fijo (p. ej. 90°, −90°, 180°) alrededor del centro del modelo. */
  turn(degrees: number): void {
    this.push();
    this.commit(movedAndRotated(this.current, this.pivot.x, this.pivot.y, 0, 0, degrees));
  }

  /** Arrastre y giro del visor: el centro se traslada (dx, dy) en coordenadas del modelo y gira alrededor de él. */
  applyQuick(dx: number, dy: number, rotationDegrees: number): void {
    this.push();
    this.commit(movedAndRotated(this.current, this.pivot.x, this.pivot.y, dx, dy, rotationDegrees));
  }

  /** Lleva el centro del modelo a un punto UTM (p. ej. indicado en el mapa) conservando rotación y cota. */
  centerAt(target: { easting: number; northing: number; zone: number; south: boolean }): void {
    this.push();
    this.commit(centeredAt(this.current, this.pivot.x, this.pivot.y, target));
  }

  setStep(step: number): void {
    this.step = step;
  }

  undo(): void {
    const previous = this.undoStack.pop();
    if (previous) this.commit(previous);
  }

  /** Vuelve a la georreferencia de partida (cancelar). */
  reset(): void {
    this.undoStack.length = 0;
    this.commit(this.initial);
  }

  static normalize = normalizeDegrees;
}
