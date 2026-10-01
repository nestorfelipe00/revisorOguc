// Volumen teórico (cabida, SRS-NOR-001 R-08): grilla de alturas máximas edificables sobre el predio, calculada
// por el host con la altura de la zona, las rasantes y los distanciamientos. Llega en coordenadas del modelo.
import * as THREE from "three";
import type { BncViewer } from "./viewer";
import type { EnvelopeGrid } from "./protocol";

const COLOR = "#3fb950";

export class TheoreticalVolume {
  readonly group = new THREE.Group();
  private grid: EnvelopeGrid | null = null;
  private mesh: THREE.Mesh | null = null;
  private edges: THREE.LineSegments | null = null;

  constructor(private readonly viewer: BncViewer) {
    this.group.name = "volumen-teorico";
  }

  get loaded(): boolean {
    return this.grid !== null;
  }

  get visible(): boolean {
    return this.loaded && this.group.visible;
  }

  get volume(): number {
    return this.grid?.volumeM3 ?? 0;
  }

  /** Reemplaza (o quita, con null) el volumen teórico. */
  set(grid: EnvelopeGrid | null): void {
    this.dispose();
    this.grid = grid;
    if (!grid) return;
    const geometry = heightfieldGeometry(grid);
    if (!geometry) return;
    const material = new THREE.MeshLambertMaterial({ color: COLOR, transparent: true, opacity: 0.3, depthWrite: false, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.renderOrder = 2;
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geometry, 30), new THREE.LineBasicMaterial({ color: COLOR, transparent: true, opacity: 0.55 }));
    this.mesh = mesh;
    this.edges = edges;

    const [bx, by, bz] = this.viewer.fragments.core.baseCoordinates ?? [0, 0, 0];
    this.group.position.set(bx, by, bz);
    this.group.add(mesh, edges);
    if (!this.group.parent) this.viewer.world.scene.three.add(this.group);
    this.group.visible = true;
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible && this.loaded;
  }

  dispose(): void {
    for (const object of [this.mesh, this.edges]) {
      if (!object) continue;
      object.geometry.dispose();
      (object.material as THREE.Material).dispose();
    }
    this.group.clear();
    this.mesh = null;
    this.edges = null;
    this.grid = null;
  }
}

/**
 * Superficie exterior del volumen (techos de cada celda y muros donde la celda vecina es más baja), sin caras
 * interiores: con transparencia se ve como un solo sólido escalonado.
 */
function heightfieldGeometry(grid: EnvelopeGrid): THREE.BufferGeometry | null {
  const { x0, y0, step, columns, rows, heights, groundZ } = grid;
  const at = (i: number, j: number) => (i < 0 || j < 0 || i >= columns || j >= rows ? 0 : Math.max(0, heights[j * columns + i]));
  const positions: number[] = [];
  // Modelo (X este, Y norte, Z arriba) → visor (X, Z, −Y).
  const quad = (a: number[], b: number[], c: number[], d: number[]) => {
    for (const p of [a, b, c, a, c, d]) positions.push(p[0], groundZ + p[2], -p[1]);
  };
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < columns; i++) {
      const h = at(i, j);
      if (h <= 0.01) continue;
      const xa = x0 + i * step;
      const xb = xa + step;
      const ya = y0 + j * step;
      const yb = ya + step;
      quad([xa, ya, h], [xb, ya, h], [xb, yb, h], [xa, yb, h]);
      const west = at(i - 1, j);
      const east = at(i + 1, j);
      const south = at(i, j - 1);
      const north = at(i, j + 1);
      if (west < h) quad([xa, yb, west], [xa, ya, west], [xa, ya, h], [xa, yb, h]);
      if (east < h) quad([xb, ya, east], [xb, yb, east], [xb, yb, h], [xb, ya, h]);
      if (south < h) quad([xa, ya, south], [xb, ya, south], [xb, ya, h], [xa, ya, h]);
      if (north < h) quad([xb, yb, north], [xa, yb, north], [xa, yb, h], [xb, yb, h]);
    }
  }
  if (positions.length === 0) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}
