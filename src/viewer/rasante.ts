// Rasantes proyectadas (SRS-NOR-001 R-02): un plano inclinado desde cada línea de rasante (deslinde con vecino o área verde,
// eje entre líneas oficiales en un frente) hacia el interior del predio, y los puntos del edificio que la sobrepasan.
// Todo llega del host en coordenadas del modelo.
import * as THREE from "three";
import type { BncViewer } from "./viewer";
import type { RasanteScene } from "./protocol";

export const RASANTE_COLORS: Record<string, string> = { Vecino: "#e8590c", Frente: "#1c7ed6", AreaVerde: "#2f9e44" };
const EXCESS = "#e5534b";

export class RasantePlanes {
  readonly group = new THREE.Group();
  private scene: RasanteScene | null = null;

  constructor(private readonly viewer: BncViewer) {
    this.group.name = "rasantes";
  }

  get loaded(): boolean {
    return this.scene !== null;
  }

  get visible(): boolean {
    return this.loaded && this.group.visible;
  }

  get angle(): number {
    return this.scene?.angle ?? 0;
  }

  /** Cuántos puntos críticos sobrepasan su rasante. */
  get excesses(): number {
    return this.scene?.critical.filter((c) => c.height - c.limit > 0.01).length ?? 0;
  }

  set(scene: RasanteScene | null): void {
    this.dispose();
    this.scene = scene;
    if (!scene) return;
    const { angle, groundZ, topHeight } = scene;
    const run = topHeight / Math.tan((angle * Math.PI) / 180);
    // Modelo (X este, Y norte, Z arriba) → visor (X, Z, −Y).
    const v = (x: number, y: number, z: number) => new THREE.Vector3(x, groundZ + z, -y);

    for (const line of scene.lines) {
      const color = RASANTE_COLORS[line.kind] ?? RASANTE_COLORS.Vecino;
      const a0 = v(line.ax, line.ay, 0);
      const b0 = v(line.bx, line.by, 0);
      const a1 = v(line.ax + line.inwardX * run, line.ay + line.inwardY * run, topHeight);
      const b1 = v(line.bx + line.inwardX * run, line.by + line.inwardY * run, topHeight);
      const geometry = new THREE.BufferGeometry().setFromPoints([a0, b0, b1, a0, b1, a1]);
      geometry.computeVertexNormals();
      const plane = new THREE.Mesh(
        geometry,
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false }),
      );
      plane.renderOrder = 3;
      const outline = new THREE.LineSegments(
        new THREE.BufferGeometry().setFromPoints([a0, b0, a0, a1, b0, b1, a1, b1]),
        new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9 }),
      );
      this.group.add(plane, outline);
    }

    // Puntos que sobrepasan: esfera en el punto y trazo vertical desde la rasante hasta él.
    const marks: THREE.Vector3[] = [];
    for (const c of scene.critical) {
      if (c.height - c.limit <= 0.01) continue;
      const sphere = new THREE.Mesh(new THREE.SphereGeometry(0.18, 16, 12), new THREE.MeshBasicMaterial({ color: EXCESS, depthTest: false }));
      sphere.position.copy(v(c.x, c.y, c.height));
      sphere.renderOrder = 4;
      this.group.add(sphere);
      marks.push(v(c.x, c.y, Math.max(0, c.limit)), v(c.x, c.y, c.height));
    }
    if (marks.length) {
      const excess = new THREE.LineSegments(
        new THREE.BufferGeometry().setFromPoints(marks),
        new THREE.LineBasicMaterial({ color: EXCESS, depthTest: false }),
      );
      excess.renderOrder = 4;
      this.group.add(excess);
    }

    const [bx, by, bz] = this.viewer.fragments.core.baseCoordinates ?? [0, 0, 0];
    this.group.position.set(bx, by, bz);
    if (!this.group.parent) this.viewer.world.scene.three.add(this.group);
    this.group.visible = true;
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible && this.loaded;
  }

  dispose(): void {
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments) {
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      }
    });
    this.group.clear();
    this.scene = null;
  }
}
