// Colocación rápida (SRS-GEO-001): vista plano de ubicación en planta cenital, arrastrar el modelo para moverlo y
// girarlo con el anillo o con giros fijos de 90° y 180°. La vista previa es local (se transforma el objeto del modelo
// en pantalla); al soltar se envía un único cambio al host, que rehace la ciudad con la cámara quieta sobre ella.
import * as THREE from "three";
import CameraControls from "camera-controls";
import type { BncViewer } from "./viewer";
import type { HostMessage, ViewerMessage } from "./protocol";

type PlacementState = Extract<HostMessage, { type: "placementState" }>;
type Send = (message: ViewerMessage) => void;

const FRAME_MARGIN = 60; // m alrededor del modelo en la vista plano de ubicación
const SNAP_DEGREES = 15;
const HANDLE_PIXELS = 18;
const GIZMO_COLOR = "#1fb6c9";

interface Drag {
  kind: "move" | "rotate";
  pointerId: number;
  start: THREE.Vector3;
  startAngle: number;
  dx: number;
  dy: number;
  rot: number;
}

interface SavedCamera {
  orthographic: boolean;
  buttons: CameraControls["mouseButtons"];
  minPolar: number;
  maxPolar: number;
}

export class QuickPlacement {
  private readonly bar = document.createElement("div");
  private readonly readout = document.createElement("div");
  private readonly confirmBox = document.createElement("div");
  private readonly gizmo = new THREE.Group();
  private readonly raycaster = new THREE.Raycaster();
  private state: PlacementState | null = null;
  private active = false;
  private saved: SavedCamera | null = null;
  private drag: Drag | null = null;
  /** Cambio enviado al host que sigue a la vista mientras llega la ciudad recalculada. */
  private pending = false;
  private pendingTimer = 0;
  private readonly originals = new Map<THREE.Object3D, THREE.Matrix4>();
  private pivot = new THREE.Vector3();
  private plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private handle = new THREE.Vector3();
  private footprint: THREE.Vector2[] = [];

  constructor(
    private readonly viewer: BncViewer,
    private readonly container: HTMLElement,
    private readonly send: Send,
  ) {
    this.bar.className = "quick-bar";
    this.readout.className = "quick-readout";
    this.confirmBox.className = "quick-confirm";
    this.bar.hidden = this.readout.hidden = this.confirmBox.hidden = true;
    document.body.append(this.readout, this.confirmBox, this.bar);
    this.gizmo.name = "colocación rápida";
    this.gizmo.renderOrder = 10;

    container.addEventListener("pointerdown", (e) => this.onPointerDown(e), { capture: true });
    window.addEventListener("pointermove", (e) => this.onPointerMove(e));
    window.addEventListener("pointerup", (e) => this.onPointerUp(e));
    window.addEventListener("keydown", (e) => this.onKey(e), true);
  }

  get isActive(): boolean {
    return this.active;
  }

  open(): void {
    this.send({ type: "placementCommand", command: "quick-open", argument: null });
  }

  setState(state: PlacementState): void {
    this.state = state;
    const wanted = state.open && state.mode === "quick";
    if (wanted && !this.active) void this.enter();
    else if (!wanted && this.active) this.exit();
    else if (wanted) this.render();
  }

  /** La ciudad recalculada llegó (con la cámara acompañándola): el modelo vuelve a su transformación real. */
  onSceneApplied(): void {
    if (!this.pending) return;
    this.pending = false;
    window.clearTimeout(this.pendingTimer);
    this.clearPreview();
  }

  // --- Entrar y salir ----------------------------------------------------------------------

  private async enter(): Promise<void> {
    this.active = true;
    const camera = this.viewer.world.camera;
    const controls = camera.controls;
    this.saved = {
      orthographic: camera.projection.current === "Orthographic",
      buttons: { ...controls.mouseButtons },
      minPolar: controls.minPolarAngle,
      maxPolar: controls.maxPolarAngle,
    };
    if (!this.saved.orthographic) await camera.projection.set("Orthographic");
    // En planta: arrastrar el fondo desplaza la vista, la rueda acerca y no se puede inclinar la cámara.
    controls.mouseButtons.left = CameraControls.ACTION.TRUCK;
    controls.mouseButtons.middle = CameraControls.ACTION.TRUCK;
    controls.mouseButtons.right = CameraControls.ACTION.NONE;
    controls.mouseButtons.wheel = CameraControls.ACTION.ZOOM;
    controls.minPolarAngle = 0;
    controls.maxPolarAngle = 0;

    await this.reframe();
    document.body.classList.add("quick-active");
    this.buildGizmo();
    this.viewer.world.scene.three.add(this.gizmo);
    this.render();
  }

  /** Planta cenital con el norte hacia arriba, encuadrando el modelo y 60 m alrededor. */
  async reframe(): Promise<void> {
    const controls = this.viewer.world.camera.controls;
    const box = this.modelBox();
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    await controls.setLookAt(center.x, box.max.y + 500, center.z + 0.001, center.x, box.min.y, center.z, false);
    const framed = box.clone();
    framed.min.x -= FRAME_MARGIN;
    framed.max.x += FRAME_MARGIN;
    framed.min.z -= FRAME_MARGIN;
    framed.max.z += FRAME_MARGIN;
    await controls.fitToBox(framed, false).catch(() => {});
  }

  private exit(): void {
    this.active = false;
    document.body.classList.remove("quick-active");
    this.drag = null;
    this.pending = false;
    this.clearPreview();
    this.gizmo.removeFromParent();
    this.disposeGizmo();
    this.bar.hidden = this.readout.hidden = this.confirmBox.hidden = true;
    const camera = this.viewer.world.camera;
    const controls = camera.controls;
    if (this.saved) {
      Object.assign(controls.mouseButtons, this.saved.buttons);
      controls.minPolarAngle = this.saved.minPolar;
      controls.maxPolarAngle = this.saved.maxPolar;
      if (!this.saved.orthographic) void camera.projection.set("Perspective");
    }
    this.saved = null;
  }

  // --- Gizmo ------------------------------------------------------------------------------

  private modelBox(): THREE.Box3 {
    const box = new THREE.Box3();
    for (const [, model] of this.viewer.fragments.list) box.union(model.box);
    return box;
  }

  /** Huella del modelo, anillo de giro y tirador, alrededor del centro que usa el host como pivote. */
  private buildGizmo(): void {
    this.disposeGizmo();
    const box = this.modelBox();
    const [bx, by, bz] = this.viewer.fragments.core.baseCoordinates ?? [0, 0, 0];
    const s = this.state!;
    const height = box.max.y + 0.5;
    this.pivot.set(s.pivotX + bx, height, bz - s.pivotY);
    this.plane.set(new THREE.Vector3(0, 1, 0), -height);
    void by;

    const corners = [
      new THREE.Vector3(box.min.x, height, box.min.z),
      new THREE.Vector3(box.max.x, height, box.min.z),
      new THREE.Vector3(box.max.x, height, box.max.z),
      new THREE.Vector3(box.min.x, height, box.max.z),
    ];
    this.footprint = corners.map((c) => new THREE.Vector2(c.x, c.z));
    const radius = Math.max(...corners.map((c) => Math.hypot(c.x - this.pivot.x, c.z - this.pivot.z))) * 1.12 + 2;
    const material = (opacity = 1) =>
      new THREE.LineBasicMaterial({ color: GIZMO_COLOR, transparent: true, opacity, depthTest: false, depthWrite: false });

    const outline = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(corners), material());
    const ringPoints = Array.from({ length: 96 }, (_, i) => {
      const a = (i / 96) * Math.PI * 2;
      return new THREE.Vector3(this.pivot.x + Math.cos(a) * radius, height, this.pivot.z + Math.sin(a) * radius);
    });
    const ring = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(ringPoints), material(0.8));
    // Tirador al nororiente del anillo (en pantalla, arriba a la derecha con el norte hacia arriba).
    this.handle.set(this.pivot.x + radius * Math.SQRT1_2, height, this.pivot.z - radius * Math.SQRT1_2);
    const handleMesh = new THREE.Mesh(
      new THREE.CircleGeometry(Math.max(0.6, radius * 0.06), 32).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: GIZMO_COLOR, depthTest: false, depthWrite: false }),
    );
    handleMesh.position.copy(this.handle);
    const center = new THREE.Mesh(
      new THREE.CircleGeometry(Math.max(0.3, radius * 0.025), 24).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: GIZMO_COLOR, depthTest: false, depthWrite: false }),
    );
    center.position.copy(this.pivot);
    for (const object of [outline, ring, handleMesh, center]) {
      object.renderOrder = 10;
      this.gizmo.add(object);
    }
  }

  private disposeGizmo(): void {
    this.gizmo.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.Line) {
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      }
    });
    this.gizmo.clear();
    this.gizmo.position.set(0, 0, 0);
    this.gizmo.quaternion.identity();
  }

  // --- Vista previa local -------------------------------------------------------------------

  /** Traslada (dx, dy en coordenadas del modelo) y gira (grados, antihorario en planta) alrededor del pivote. */
  private applyPreview(dx: number, dy: number, rot: number): void {
    const transform = new THREE.Matrix4()
      .makeTranslation(this.pivot.x + dx, 0, this.pivot.z - dy)
      .multiply(new THREE.Matrix4().makeRotationY((rot * Math.PI) / 180))
      .multiply(new THREE.Matrix4().makeTranslation(-this.pivot.x, 0, -this.pivot.z));
    const targets: THREE.Object3D[] = [this.gizmo, ...[...this.viewer.fragments.list.values()].map((m) => m.object)];
    for (const object of targets) {
      if (!this.originals.has(object)) this.originals.set(object, object.matrix.clone());
      const matrix = transform.clone().multiply(this.originals.get(object)!);
      matrix.decompose(object.position, object.quaternion, object.scale);
      object.updateMatrixWorld(true);
    }
  }

  private clearPreview(): void {
    for (const [object, matrix] of this.originals) {
      matrix.decompose(object.position, object.quaternion, object.scale);
      object.updateMatrixWorld(true);
    }
    this.originals.clear();
    void this.viewer.fragments.core.update(true);
  }

  // --- Puntero ------------------------------------------------------------------------------

  private groundPoint(e: PointerEvent): THREE.Vector3 | null {
    const rect = this.viewer.world.renderer!.three.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.viewer.world.camera.three);
    return this.raycaster.ray.intersectPlane(this.plane, new THREE.Vector3());
  }

  private screenDistance(e: PointerEvent, world: THREE.Vector3): number {
    const rect = this.viewer.world.renderer!.three.domElement.getBoundingClientRect();
    const p = world.clone().project(this.viewer.world.camera.three);
    const x = rect.left + ((p.x + 1) / 2) * rect.width;
    const y = rect.top + ((1 - p.y) / 2) * rect.height;
    return Math.hypot(e.clientX - x, e.clientY - y);
  }

  /** Ángulo antihorario en planta (coordenadas del modelo: x = X, y = −Z) desde el pivote. */
  private planAngle(point: THREE.Vector3): number {
    return (Math.atan2(-(point.z - this.pivot.z), point.x - this.pivot.x) * 180) / Math.PI;
  }

  private insideFootprint(point: THREE.Vector3): boolean {
    let inside = false;
    const f = this.footprint;
    for (let i = 0, j = f.length - 1; i < f.length; j = i++) {
      if (f[i].y > point.z !== f[j].y > point.z && point.x < ((f[j].x - f[i].x) * (point.z - f[i].y)) / (f[j].y - f[i].y) + f[i].x) inside = !inside;
    }
    return inside;
  }

  private onPointerDown(e: PointerEvent): void {
    if (!this.active || e.button !== 0 || this.pending || this.state?.confirmRequired) return;
    const point = this.groundPoint(e);
    if (!point) return;
    let kind: Drag["kind"] | null = null;
    if (this.screenDistance(e, this.handle) <= HANDLE_PIXELS) kind = "rotate";
    else if (this.insideFootprint(point)) kind = "move";
    if (!kind) return; // fuera del modelo: la cámara se desplaza como siempre
    e.stopPropagation();
    e.preventDefault();
    this.drag = { kind, pointerId: e.pointerId, start: point, startAngle: this.planAngle(point), dx: 0, dy: 0, rot: 0 };
    this.container.style.cursor = kind === "move" ? "grabbing" : "crosshair";
  }

  private onPointerMove(e: PointerEvent): void {
    if (!this.active) return;
    if (!this.drag) {
      // Cursor que anticipa la acción.
      const point = this.groundPoint(e);
      if (!point || this.pending) return;
      this.container.style.cursor = this.screenDistance(e, this.handle) <= HANDLE_PIXELS ? "crosshair" : this.insideFootprint(point) ? "grab" : "";
      return;
    }
    if (e.pointerId !== this.drag.pointerId) return;
    const point = this.groundPoint(e);
    if (!point) return;
    if (this.drag.kind === "move") {
      this.drag.dx = point.x - this.drag.start.x;
      this.drag.dy = -(point.z - this.drag.start.z);
    } else {
      let rot = this.planAngle(point) - this.drag.startAngle;
      rot = ((rot + 540) % 360) - 180;
      if (e.shiftKey) rot = Math.round(rot / SNAP_DEGREES) * SNAP_DEGREES;
      this.drag.rot = rot;
    }
    this.applyPreview(this.drag.dx, this.drag.dy, this.drag.rot);
    this.renderReadout();
  }

  private onPointerUp(e: PointerEvent): void {
    const drag = this.drag;
    if (!drag || e.pointerId !== drag.pointerId) return;
    this.drag = null;
    this.container.style.cursor = "";
    if (Math.hypot(drag.dx, drag.dy) < 0.005 && Math.abs(drag.rot) < 0.01) {
      this.clearPreview();
      return;
    }
    this.pending = true;
    // Si la ciudad no llega (sin base de ciudad, error), el modelo vuelve a su lugar real igual.
    this.pendingTimer = window.setTimeout(() => this.onSceneApplied(), 4000);
    this.send({ type: "placementCommand", command: "quick", argument: JSON.stringify({ dx: drag.dx, dy: drag.dy, rot: drag.rot }) });
  }

  private onKey(e: KeyboardEvent): void {
    if (!this.active || (e.target as HTMLElement).closest("input, textarea")) return;
    let command: [string, string | null] | null = null;
    if ((e.key === "r" || e.key === "R") && !e.ctrlKey) command = ["turn", e.shiftKey ? "-90" : "90"];
    else if ((e.key === "z" || e.key === "Z") && e.ctrlKey) command = ["undo", null];
    else if (e.key === "Enter") command = ["accept", null];
    else if (e.key === "Escape") command = ["cancel", null];
    if (!command) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    this.send({ type: "placementCommand", command: command[0], argument: command[1] });
  }

  // --- Interfaz -----------------------------------------------------------------------------

  private render(): void {
    const s = this.state;
    if (!s) return;
    this.renderReadout();
    const button = (label: string, title: string, command: string, argument: string | null = null, className = "", disabled = false) => {
      const b = document.createElement("button");
      b.className = `small ${className}`;
      b.textContent = label;
      b.title = title;
      b.disabled = disabled;
      b.addEventListener("click", () => this.send({ type: "placementCommand", command, argument }));
      return b;
    };
    const locked = s.confirmRequired;
    this.bar.replaceChildren(
      button("⟲ 90°", "Girar 90° antihorario (R)", "turn", "90", "", locked),
      button("⟳ 90°", "Girar 90° horario (Mayús + R)", "turn", "-90", "", locked),
      button("180°", "Girar 180°", "turn", "180", "", locked),
      button("Deshacer", "Deshacer la última acción (Ctrl + Z)", "undo", null, "", locked || !s.canUndo),
      button("Ajuste fino…", "Pasar al ajuste fino: pasos de 0,01 m y 0,01°, subir y bajar, puntos conocidos", "fine"),
      button("Cancelar", "Volver a la ubicación del inicio (Esc)", "cancel"),
      button("Aceptar", "Guardar la ubicación en el proyecto (Enter)", "accept", null, "primary"),
    );
    this.bar.hidden = false;

    this.confirmBox.hidden = !locked;
    if (locked) {
      const text = document.createElement("p");
      text.textContent = "Este IFC ya trae georreferencia (IfcMapConversion). Si lo mueve, se usará una georreferencia definida por usted, guardada en el proyecto. El archivo IFC no cambia.";
      const actions = document.createElement("div");
      actions.className = "placement-actions";
      actions.append(button("Cancelar", "No mover el modelo", "cancel"), button("Continuar", "Mover el modelo con una georreferencia propia", "confirm", null, "primary"));
      this.confirmBox.replaceChildren(text, actions);
    }
  }

  private renderReadout(): void {
    const s = this.state;
    if (!s) return;
    const es = (value: number, decimals: number) => value.toLocaleString("es-CL", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
    const drag = this.drag;
    const rotation = ((s.rotationDegrees + (drag?.rot ?? 0) + 540) % 360) - 180;
    const lines = [
      `Rotación ${es(rotation, 1)}°${drag && drag.rot ? `  (${drag.rot > 0 ? "+" : ""}${es(drag.rot, 1)}°)` : ""}`,
      drag && drag.kind === "move" ? `Arrastre ${es(Math.hypot(drag.dx, drag.dy), 2)} m` : `Desplazamiento desde el inicio ${s.offset}`,
      s.center,
    ];
    const title = document.createElement("div");
    title.className = "label";
    title.textContent = "Colocación rápida";
    const hint = document.createElement("div");
    hint.className = "quick-hint";
    hint.textContent = "Arrastre el modelo para moverlo · arrastre el punto del anillo para girarlo (Mayús: de 15° en 15°) · arrastre el fondo para desplazar la vista";
    this.readout.replaceChildren(title, ...lines.map((line) => Object.assign(document.createElement("div"), { textContent: line })), hint);
    this.readout.hidden = false;
  }
}
