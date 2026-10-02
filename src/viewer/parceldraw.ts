// Dibujo del predio en planta (SRS-NOR-001): clic en cada vértice sobre el modelo y la ciudad, largo por teclado como en un CAD,
// Mayús para ángulos de 15° respecto del tramo anterior (esquinas de 90° exactas). El resultado viaja al host en coordenadas
// del modelo y el host propone el tipo de cada deslinde.
import * as THREE from "three";
import CameraControls from "camera-controls";
import type { BncViewer } from "./viewer";
import type { ViewerMessage } from "./protocol";
import { overUi } from "./quickplace";

type Send = (message: ViewerMessage) => void;

const FRAME_MARGIN = 40;
const COLOR = "#e8590c";
const CLOSE_PIXELS = 12;
const CLICK_PIXELS = 4;
const SNAP_DEGREES = 15;

interface SavedCamera {
  orthographic: boolean;
  buttons: CameraControls["mouseButtons"];
  minPolar: number;
  maxPolar: number;
}

const es = (value: number, decimals = 2) => value.toLocaleString("es-CL", { minimumFractionDigits: 0, maximumFractionDigits: decimals });

export class ParcelDrawing {
  private readonly bar = document.createElement("div");
  private readonly readout = document.createElement("div");
  private readonly group = new THREE.Group();
  private readonly raycaster = new THREE.Raycaster();
  private readonly plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private active = false;
  private saved: SavedCamera | null = null;
  /** Vértices en coordenadas del modelo (X este, Y norte). */
  private points: THREE.Vector2[] = [];
  private cursor: THREE.Vector2 | null = null;
  private reference: number[] | null = null;
  private typed = "";
  private down: { x: number; y: number; id: number } | null = null;

  constructor(
    private readonly viewer: BncViewer,
    container: HTMLElement,
    private readonly send: Send,
  ) {
    this.bar.className = "quick-bar";
    this.readout.className = "quick-readout parcel-readout";
    this.bar.hidden = this.readout.hidden = true;
    container.append(this.readout, this.bar);
    this.group.name = "dibujo del predio";
    this.group.renderOrder = 10;
    this.container = container;
    container.addEventListener("pointerdown", this.onPointerDownBound, { capture: true });
    window.addEventListener("pointermove", this.onPointerMoveBound);
    window.addEventListener("pointerup", this.onPointerUpBound);
    window.addEventListener("keydown", this.onKeyBound, true);
  }

  private readonly container: HTMLElement;
  private readonly onPointerDownBound = (e: PointerEvent) => this.onPointerDown(e);
  private readonly onPointerMoveBound = (e: PointerEvent) => this.onPointerMove(e);
  private readonly onPointerUpBound = (e: PointerEvent) => this.onPointerUp(e);
  private readonly onKeyBound = (e: KeyboardEvent) => this.onKey(e);

  /** Quita los elementos y los escuchadores globales (al desmontar el visor). */
  dispose(): void {
    this.container.removeEventListener("pointerdown", this.onPointerDownBound, { capture: true });
    window.removeEventListener("pointermove", this.onPointerMoveBound);
    window.removeEventListener("pointerup", this.onPointerUpBound);
    window.removeEventListener("keydown", this.onKeyBound, true);
    this.bar.remove();
    this.readout.remove();
  }

  get isActive(): boolean {
    return this.active;
  }

  /** Entra al dibujo; <paramref name="current"/> es el predio vigente (coordenadas del modelo) como referencia. */
  async start(current: number[] | null): Promise<void> {
    if (this.active) return;
    this.active = true;
    this.points = [];
    this.typed = "";
    this.reference = current && current.length >= 6 ? current : null;
    const camera = this.viewer.world.camera;
    const controls = camera.controls;
    this.saved = {
      orthographic: camera.projection.current === "Orthographic",
      buttons: { ...controls.mouseButtons },
      minPolar: controls.minPolarAngle,
      maxPolar: controls.maxPolarAngle,
    };
    if (!this.saved.orthographic) await camera.projection.set("Orthographic");
    controls.mouseButtons.left = CameraControls.ACTION.TRUCK;
    controls.mouseButtons.middle = CameraControls.ACTION.TRUCK;
    controls.mouseButtons.right = CameraControls.ACTION.NONE;
    controls.mouseButtons.wheel = CameraControls.ACTION.ZOOM;
    controls.minPolarAngle = 0;
    controls.maxPolarAngle = 0;
    await this.frame();
    const [bx, by, bz] = this.viewer.fragments.core.baseCoordinates ?? [0, 0, 0];
    this.group.position.set(bx, by, bz);
    this.plane.constant = -by;
    this.viewer.world.scene.three.add(this.group);
    // Los clics dibujan vértices: no seleccionan elementos mientras tanto.
    this.viewer.highlighter.enabled = false;
    document.body.classList.add("quick-active");
    this.render();
  }

  private async frame(): Promise<void> {
    const box = new THREE.Box3();
    for (const [, model] of this.viewer.fragments.list) box.union(model.box);
    if (box.isEmpty()) {
      // Sin modelo (estudio de cabida): alrededor del punto de referencia, que es el origen de las coordenadas locales.
      const [bx, by, bz] = this.viewer.fragments.core.baseCoordinates ?? [0, 0, 0];
      box.set(new THREE.Vector3(bx - 20, by, bz - 20), new THREE.Vector3(bx + 20, by + 10, bz + 20));
    }
    const controls = this.viewer.world.camera.controls;
    const center = box.getCenter(new THREE.Vector3());
    await controls.setLookAt(center.x, box.max.y + 500, center.z + 0.001, center.x, box.min.y, center.z, false);
    box.min.x -= FRAME_MARGIN;
    box.max.x += FRAME_MARGIN;
    box.min.z -= FRAME_MARGIN;
    box.max.z += FRAME_MARGIN;
    await controls.fitToBox(box, false).catch(() => {});
  }

  private finish(result: THREE.Vector2[] | null): void {
    if (!this.active) return;
    this.active = false;
    this.viewer.highlighter.enabled = true;
    document.body.classList.remove("quick-active");
    this.bar.hidden = this.readout.hidden = true;
    this.clearGroup();
    this.group.removeFromParent();
    const camera = this.viewer.world.camera;
    const controls = camera.controls;
    if (this.saved) {
      Object.assign(controls.mouseButtons, this.saved.buttons);
      controls.minPolarAngle = this.saved.minPolar;
      controls.maxPolarAngle = this.saved.maxPolar;
      if (!this.saved.orthographic) void camera.projection.set("Perspective");
    }
    this.saved = null;
    if (result) this.send({ type: "parcelDrawn", points: result.flatMap((p) => [round(p.x), round(p.y)]) });
  }

  private close(): void {
    if (this.points.length >= 3) this.finish(this.points);
  }

  // --- Entrada ----------------------------------------------------------------------------

  private modelPoint(e: PointerEvent): THREE.Vector2 | null {
    const rect = this.viewer.world.renderer!.three.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.viewer.world.camera.three);
    const hit = this.raycaster.ray.intersectPlane(this.plane, new THREE.Vector3());
    if (!hit) return null;
    const [bx, , bz] = this.viewer.fragments.core.baseCoordinates ?? [0, 0, 0];
    return new THREE.Vector2(hit.x - bx, -(hit.z - bz));
  }

  private screenOf(p: THREE.Vector2): THREE.Vector2 {
    const [bx, by, bz] = this.viewer.fragments.core.baseCoordinates ?? [0, 0, 0];
    const rect = this.viewer.world.renderer!.three.domElement.getBoundingClientRect();
    const v = new THREE.Vector3(p.x + bx, by, bz - p.y).project(this.viewer.world.camera.three);
    return new THREE.Vector2(rect.left + ((v.x + 1) / 2) * rect.width, rect.top + ((1 - v.y) / 2) * rect.height);
  }

  /** Con Mayús, el tramo gira de 15° en 15° respecto del anterior (o del este si es el primero). */
  private snapped(raw: THREE.Vector2, shift: boolean): THREE.Vector2 {
    const last = this.points[this.points.length - 1];
    if (!shift || !last) return raw;
    const prev = this.points[this.points.length - 2];
    const base = prev ? Math.atan2(last.y - prev.y, last.x - prev.x) : 0;
    const d = raw.clone().sub(last);
    const step = (SNAP_DEGREES * Math.PI) / 180;
    const angle = base + Math.round((Math.atan2(d.y, d.x) - base) / step) * step;
    const length = d.length();
    return new THREE.Vector2(last.x + Math.cos(angle) * length, last.y + Math.sin(angle) * length);
  }

  private nearFirst(e: PointerEvent): boolean {
    if (this.points.length < 3) return false;
    const first = this.screenOf(this.points[0]);
    return Math.hypot(first.x - e.clientX, first.y - e.clientY) <= CLOSE_PIXELS;
  }

  private onPointerDown(e: PointerEvent): void {
    if (!this.active || e.button !== 0 || overUi(e)) return;
    this.down = { x: e.clientX, y: e.clientY, id: e.pointerId };
  }

  private onPointerMove(e: PointerEvent): void {
    if (!this.active) return;
    const p = this.modelPoint(e);
    if (!p) return;
    this.cursor = this.nearFirst(e) ? this.points[0].clone() : this.snapped(p, e.shiftKey);
    this.render();
  }

  private onPointerUp(e: PointerEvent): void {
    const down = this.down;
    this.down = null;
    if (!this.active || !down || down.id !== e.pointerId) return;
    if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > CLICK_PIXELS) return; // fue un desplazamiento de la vista
    if (this.nearFirst(e)) {
      this.close();
      return;
    }
    const p = this.modelPoint(e);
    if (!p) return;
    this.points.push(this.snapped(p, e.shiftKey));
    this.typed = "";
    this.render();
  }

  private onKey(e: KeyboardEvent): void {
    if (!this.active) return;
    const key = e.key;
    let handled = true;
    if (/^[0-9]$/.test(key) || ((key === "," || key === ".") && !/[.,]/.test(this.typed))) {
      this.typed += key === "," ? "." : key;
    } else if (key === "Backspace") {
      if (this.typed) this.typed = this.typed.slice(0, -1);
      else this.points.pop();
    } else if (key === "Enter") {
      if (this.typed) this.addTyped();
      else this.close();
    } else if (key === "Escape") {
      this.finish(null);
    } else {
      handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
      if (this.active) this.render();
    }
  }

  /** Largo escrito: nuevo vértice en la dirección del cursor desde el último vértice. */
  private addTyped(): void {
    const length = parseFloat(this.typed);
    this.typed = "";
    const last = this.points[this.points.length - 1];
    if (!last || !this.cursor || !(length > 0)) return;
    const d = this.cursor.clone().sub(last);
    if (d.lengthSq() < 1e-9) return;
    this.points.push(last.clone().add(d.normalize().multiplyScalar(length)));
  }

  // --- Dibujo -----------------------------------------------------------------------------

  private clearGroup(): void {
    this.group.traverse((o) => {
      if (o instanceof THREE.Line || o instanceof THREE.Points || o instanceof THREE.Mesh) {
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      }
    });
    this.group.clear();
  }

  private render(): void {
    this.clearGroup();
    const z = 0.05;
    const v = (p: THREE.Vector2) => new THREE.Vector3(p.x, z, -p.y);
    if (this.reference) {
      const ref: THREE.Vector3[] = [];
      for (let k = 0; k < this.reference.length; k += 2) ref.push(new THREE.Vector3(this.reference[k], z, -this.reference[k + 1]));
      const line = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(ref), new THREE.LineDashedMaterial({ color: "#8b949e", dashSize: 0.6, gapSize: 0.4, depthTest: false }));
      line.computeLineDistances();
      this.group.add(line);
    }
    const drawn = this.points.map(v);
    if (drawn.length) {
      const path = new THREE.Line(new THREE.BufferGeometry().setFromPoints(drawn), new THREE.LineBasicMaterial({ color: COLOR, depthTest: false }));
      const dots = new THREE.Points(new THREE.BufferGeometry().setFromPoints(drawn), new THREE.PointsMaterial({ color: COLOR, size: 8, sizeAttenuation: false, depthTest: false }));
      this.group.add(path, dots);
      if (this.cursor) {
        const band = [drawn[drawn.length - 1], v(this.cursor)];
        if (drawn.length >= 2) band.push(drawn[0]);
        const rubber = new THREE.Line(new THREE.BufferGeometry().setFromPoints(band), new THREE.LineDashedMaterial({ color: COLOR, dashSize: 0.5, gapSize: 0.3, depthTest: false }));
        rubber.computeLineDistances();
        this.group.add(rubber);
      }
    }
    this.group.traverse((o) => (o.renderOrder = 10));
    this.renderPanel();
  }

  private renderPanel(): void {
    const last = this.points[this.points.length - 1];
    const prev = this.points[this.points.length - 2];
    const lines: string[] = [`${this.points.length} vértice${this.points.length === 1 ? "" : "s"}`];
    if (last && this.cursor) {
      const d = this.cursor.clone().sub(last);
      let text = `Tramo ${es(d.length())} m`;
      if (prev) {
        const turn = (Math.atan2(d.y, d.x) - Math.atan2(last.y - prev.y, last.x - prev.x)) * (180 / Math.PI);
        text += ` · ángulo con el anterior ${es(Math.abs(((turn + 540) % 360) - 180), 1)}°`;
      }
      lines.push(text);
    }
    if (this.points.length >= 3) lines.push(`Superficie ${es(area(this.points))} m²`);
    if (this.typed) lines.push(`Largo: ${this.typed.replace(".", ",")} m ↵`);
    const title = Object.assign(document.createElement("div"), { className: "label", textContent: "Dibujar predio" });
    const hint = Object.assign(document.createElement("div"), {
      className: "quick-hint",
      textContent: "Clic en cada vértice · escriba un largo y Enter para fijar el tramo · Mayús: ángulos de 15° · Retroceso borra · Enter o clic en el primer vértice cierra · Esc cancela",
    });
    this.readout.replaceChildren(title, ...lines.map((line) => Object.assign(document.createElement("div"), { textContent: line })), hint);
    this.readout.hidden = false;

    const button = (label: string, title: string, action: () => void, className = "", disabled = false) => {
      const b = Object.assign(document.createElement("button"), { className: `small ${className}`, textContent: label, title, disabled });
      b.addEventListener("click", () => {
        action();
        if (this.active) this.render();
      });
      return b;
    };
    this.bar.replaceChildren(
      button("Borrar vértice", "Quitar el último vértice (Retroceso)", () => this.points.pop(), "", this.points.length === 0),
      button("Cancelar", "Salir sin cambiar el predio (Esc)", () => this.finish(null)),
      button("Cerrar predio", "Unir el último vértice con el primero (Enter)", () => this.close(), "primary", this.points.length < 3),
    );
    this.bar.hidden = false;
  }
}

function area(points: THREE.Vector2[]): number {
  let a = 0;
  for (let k = 0; k < points.length; k++) {
    const p = points[k];
    const q = points[(k + 1) % points.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

const round = (value: number) => Math.round(value * 1000) / 1000;
