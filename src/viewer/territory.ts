// Contexto territorial 3D (three.js): terreno con el plano base como textura, edificios de la ciudad,
// árboles y volúmenes de altura máxima del PRC. Todo llega del host en coordenadas del modelo.
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { BncViewer } from "./viewer";
import type { TerritoryScene } from "./protocol";

export type GroundStyle = "plano" | "blanco";

const COLORS = {
  land: "#e6e4df",
  white: "#f1f1ef",
  green: "#cfe3bf",
  water: "#aecfe8",
  road: "#fbfbfa",
  path: "#f4f3f0",
  zoneLine: "#7a5fc0",
  project: "#1fb6c9",
  parcel: { Vecino: "#e8590c", Frente: "#1c7ed6", AreaVerde: "#2f9e44" } as Record<string, string>,
  building: "#c3c6ca",
  buildingEstimated: "#d9dbde",
  edges: "#8c9197",
  tree: "#8fbf78",
};

/** Metros por píxel de la textura del suelo (con tope de 4096 px por lado). */
const GROUND_RESOLUTION = 0.3;
const TREE_HEIGHT = 5;

interface Layers {
  ground: THREE.Mesh;
  buildings: THREE.Group;
  trees: THREE.InstancedMesh | null;
  heights: THREE.Group;
}

/**
 * Escena de ciudad alrededor del proyecto. Las coordenadas del modelo (X este, Y norte, Z arriba,
 * relativas a scene.origin) pasan al visor (Y arriba) como (X, Z, −Y) dentro de un grupo ubicado en
 * el origen + las coordenadas base de Fragments, para no perder precisión en float32.
 */
export class TerritoryContext {
  readonly group = new THREE.Group();
  private scene: TerritoryScene | null = null;
  private layers: Layers | null = null;
  private groundStyle: GroundStyle = "plano";
  private showZones = true;
  private savedFar: number[] = [];

  constructor(private readonly viewer: BncViewer) {
    this.group.name = "contexto-territorial";
    this.group.visible = false;
  }

  get loaded(): boolean {
    return this.scene !== null;
  }

  get visible(): boolean {
    return this.group.visible;
  }

  get notes(): string[] {
    return this.scene?.notes ?? [];
  }

  /** Una línea por capa: fuente y licencia. */
  get sources(): string[] {
    return this.scene?.attribution.split(" · ") ?? [];
  }

  /** Hay predio dibujado en el suelo. */
  get parcelShown(): boolean {
    return (this.scene?.parcel?.length ?? 0) >= 6;
  }

  get zones(): TerritoryScene["zones"] {
    return this.scene?.zones ?? [];
  }

  /**
   * Muestra la escena. Con <paramref name="keepView"/> (el usuario está moviendo el modelo) la cámara recibe la
   * misma transformación que la ciudad: en pantalla la ciudad queda quieta y lo que se mueve es el modelo.
   */
  setScene(scene: TerritoryScene, keepView = false): void {
    const previous = this.scene?.modelToWorld ?? null;
    if (keepView && previous && scene.modelToWorld) this.followCity(previous, scene.modelToWorld);
    this.dispose();
    this.scene = scene;
    const [bx, by, bz] = this.viewer.fragments.core.baseCoordinates ?? [0, 0, 0];
    const [ox, oy] = scene.origin;
    this.group.position.set(ox + bx, by, bz - oy);

    const ground = this.buildGround(scene);
    const buildings = this.buildBuildings(scene);
    const trees = this.buildTrees(scene);
    const heights = this.buildHeights(scene);
    heights.visible = false;
    this.group.add(ground, buildings, heights);
    if (trees) this.group.add(trees);
    this.layers = { ground, buildings, trees, heights };

    if (!this.group.parent) this.viewer.world.scene.three.add(this.group);
    // Las mediciones y el punto bajo el cursor también funcionan sobre el terreno y los edificios.
    this.viewer.world.meshes.add(ground);
    for (const child of buildings.children) if (child instanceof THREE.Mesh) this.viewer.world.meshes.add(child);
    this.setVisible(true);
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible && this.loaded;
    this.viewer.setGridVisible(!this.group.visible);
    const cameras = [this.viewer.world.camera.threePersp, this.viewer.world.camera.threeOrtho];
    if (this.group.visible) {
      // El plano lejano por defecto (1 km) cortaría el entorno.
      this.savedFar = cameras.map((c) => c.far);
      for (const c of cameras) c.far = Math.max(c.far, 20000);
    } else if (this.savedFar.length) {
      cameras.forEach((c, i) => (c.far = this.savedFar[i]));
    }
    for (const c of cameras) c.updateProjectionMatrix();
  }

  setGroundStyle(style: GroundStyle): void {
    this.groundStyle = style;
    this.redrawGround();
  }

  get ground(): GroundStyle {
    return this.groundStyle;
  }

  setZoneOutlines(show: boolean): void {
    this.showZones = show;
    this.redrawGround();
  }

  get zoneOutlines(): boolean {
    return this.showZones;
  }

  setHeightsVisible(visible: boolean): void {
    if (this.layers) this.layers.heights.visible = visible;
  }

  get heightsVisible(): boolean {
    return this.layers?.heights.visible ?? false;
  }

  setTreesVisible(visible: boolean): void {
    if (this.layers?.trees) this.layers.trees.visible = visible;
  }

  get treesVisible(): boolean {
    return this.layers?.trees?.visible ?? false;
  }

  /** Mueve la cámara con la ciudad: un punto fijo del mapa conserva su lugar en pantalla. */
  private followCity(before: number[], after: number[]): void {
    const [bx, by, bz] = this.viewer.fragments.core.baseCoordinates ?? [0, 0, 0];
    const controls = this.viewer.world.camera.controls;
    const move = (world: THREE.Vector3): THREE.Vector3 => {
      const model = { x: world.x - bx, y: -(world.z - bz), z: world.y - by };
      const map = modelToMap(before, model);
      const next = mapToModel(after, map);
      return new THREE.Vector3(next.x + bx, next.z + by, bz - next.y);
    };
    const position = move(controls.getPosition(new THREE.Vector3()));
    const target = move(controls.getTarget(new THREE.Vector3()));
    void controls.setLookAt(position.x, position.y, position.z, target.x, target.y, target.z, false);
  }

  /** Vista oblicua de todo el entorno. */
  frame(): void {
    if (!this.scene) return;
    const box = new THREE.Box3().setFromObject(this.layers!.ground);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const d = Math.max(size.x, size.z) * 0.75;
    void this.viewer.world.camera.controls.setLookAt(center.x - d * 0.55, center.y + d * 0.6, center.z + d * 0.75, center.x, center.y, center.z, true);
  }

  dispose(): void {
    if (!this.layers) return;
    for (const mesh of [this.layers.ground, ...this.layers.buildings.children]) this.viewer.world.meshes.delete(mesh as THREE.Mesh);
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.Line || o instanceof THREE.InstancedMesh) {
        o.geometry.dispose();
        const materials = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of materials) {
          (m as THREE.MeshBasicMaterial).map?.dispose();
          m.dispose();
        }
      }
    });
    this.group.clear();
    this.layers = null;
    this.scene = null;
  }

  // --- Terreno ------------------------------------------------------------------------------

  private buildGround(scene: TerritoryScene): THREE.Mesh {
    const { x0, y0, step, columns, rows, z } = scene.terrain;
    const positions = new Float32Array(columns * rows * 3);
    const uvs = new Float32Array(columns * rows * 2);
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < columns; i++) {
        const k = j * columns + i;
        positions.set([x0 + i * step, z[k], -(y0 + j * step)], k * 3);
        uvs.set([i / (columns - 1), j / (rows - 1)], k * 2);
      }
    }
    const index: number[] = [];
    for (let j = 0; j < rows - 1; j++) {
      for (let i = 0; i < columns - 1; i++) {
        const a = j * columns + i;
        const b = a + 1;
        const c = a + columns;
        const d = c + 1;
        index.push(a, b, d, a, d, c);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
    geometry.setIndex(index);
    geometry.computeVertexNormals();

    const material = new THREE.MeshLambertMaterial({ side: THREE.DoubleSide });
    // Por debajo del modelo: evita que el terreno tape losas a nivel de suelo.
    material.polygonOffset = true;
    material.polygonOffsetFactor = 2;
    material.polygonOffsetUnits = 2;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = "terreno";
    mesh.receiveShadow = true;
    this.redrawGround(mesh);
    return mesh;
  }

  /** Dibuja el plano base (áreas verdes, agua, calles, zonas del PRC y huella del proyecto) en la textura del terreno. */
  private redrawGround(target?: THREE.Mesh): void {
    const mesh = target ?? this.layers?.ground;
    const scene = this.scene;
    if (!mesh || !scene) return;
    const { x0, y0, step, columns, rows } = scene.terrain;
    const width = (columns - 1) * step;
    const height = (rows - 1) * step;
    const scale = Math.min(1 / GROUND_RESOLUTION, 4096 / Math.max(width, height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(width * scale);
    canvas.height = Math.ceil(height * scale);
    const ctx = canvas.getContext("2d")!;
    const px = (x: number) => (x - x0) * scale;
    const py = (y: number) => canvas.height - (y - y0) * scale;
    const path = (ring: number[]) => {
      ctx.moveTo(px(ring[0]), py(ring[1]));
      for (let k = 2; k < ring.length; k += 2) ctx.lineTo(px(ring[k]), py(ring[k + 1]));
      ctx.closePath();
    };
    const fillPolygons = (polygons: { rings: number[][] }[], color: string) => {
      ctx.fillStyle = color;
      for (const polygon of polygons) {
        ctx.beginPath();
        for (const ring of polygon.rings) path(ring);
        ctx.fill("evenodd");
      }
    };

    const plain = this.groundStyle === "blanco";
    ctx.fillStyle = plain ? COLORS.white : COLORS.land;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (!plain) {
      fillPolygons(scene.green, COLORS.green);
      fillPolygons(scene.water, COLORS.water);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      // Primero senderos, luego calles de menor a mayor jerarquía (las principales quedan encima).
      for (const road of [...scene.roads].sort((a, b) => a.width - b.width)) {
        ctx.strokeStyle = road.width < 3 ? COLORS.path : COLORS.road;
        ctx.lineWidth = Math.max(1, road.width * scale);
        ctx.beginPath();
        ctx.moveTo(px(road.points[0]), py(road.points[1]));
        for (let k = 2; k < road.points.length; k += 2) ctx.lineTo(px(road.points[k]), py(road.points[k + 1]));
        ctx.stroke();
      }
    }

    if (this.showZones) {
      ctx.setLineDash([6 * scale, 4 * scale]);
      ctx.strokeStyle = COLORS.zoneLine;
      ctx.lineWidth = Math.max(1.5, 0.8 * scale);
      ctx.fillStyle = COLORS.zoneLine;
      ctx.font = `600 ${Math.round(Math.max(12, 5 * scale))}px Segoe UI, sans-serif`;
      ctx.textAlign = "center";
      for (const zone of scene.zones) {
        ctx.beginPath();
        for (const ring of zone.rings) path(ring);
        ctx.stroke();
        const [cx, cy] = ringCenter(zone.rings[0]);
        const label = zone.maxHeight !== null ? `${zone.code} · ${formatMeters(zone.maxHeight)}` : zone.code;
        ctx.fillText(label, px(cx), py(cy));
      }
      ctx.setLineDash([]);
    }
    if (scene.parcel && scene.parcel.length >= 6) {
      // Predio: cada deslinde con el color de su tipo y su número (el mismo de la ventana «Deslindes»).
      const ring = scene.parcel;
      const n = ring.length / 2;
      ctx.lineWidth = Math.max(2.5, 0.35 * scale);
      ctx.font = `700 ${Math.round(Math.max(12, 2.2 * scale))}px Segoe UI, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      for (let k = 0; k < n; k++) {
        const [ax, ay, bx, by] = [ring[2 * k], ring[2 * k + 1], ring[(2 * k + 2) % ring.length], ring[(2 * k + 3) % ring.length]];
        const color = COLORS.parcel[scene.parcelKinds?.[k] ?? "Vecino"] ?? COLORS.parcel.Vecino;
        ctx.strokeStyle = color;
        ctx.beginPath();
        ctx.moveTo(px(ax), py(ay));
        ctx.lineTo(px(bx), py(by));
        ctx.stroke();
        ctx.fillStyle = color;
        ctx.fillText(String(k + 1), px((ax + bx) / 2), py((ay + by) / 2));
      }
      ctx.textBaseline = "alphabetic";
    }
    if (scene.project) {
      ctx.strokeStyle = COLORS.project;
      ctx.lineWidth = Math.max(2, 0.6 * scale);
      ctx.beginPath();
      path(scene.project);
      ctx.stroke();
    }

    const material = mesh.material as THREE.MeshLambertMaterial;
    material.map?.dispose();
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = this.viewer.world.renderer!.three.capabilities.getMaxAnisotropy();
    material.map = texture;
    material.needsUpdate = true;
  }

  // --- Edificios ------------------------------------------------------------------------------

  private buildBuildings(scene: TerritoryScene): THREE.Group {
    const group = new THREE.Group();
    group.name = "edificios";
    const known: THREE.BufferGeometry[] = [];
    const estimated: THREE.BufferGeometry[] = [];
    for (const building of scene.buildings) {
      const shape = toShape(building.rings);
      if (!shape) continue;
      // Se hunde 0,3 m para que no quede aire bajo el edificio en terreno inclinado.
      const geometry = new THREE.ExtrudeGeometry(shape, { depth: building.height + 0.3, bevelEnabled: false });
      geometry.rotateX(-Math.PI / 2);
      geometry.translate(0, building.base - 0.3, 0);
      geometry.deleteAttribute("uv");
      (building.heightSource === "dato" ? known : estimated).push(geometry);
    }
    for (const [geometries, color, name] of [
      [known, COLORS.building, "edificios con altura"],
      [estimated, COLORS.buildingEstimated, "edificios con altura estimada"],
    ] as const) {
      if (geometries.length === 0) continue;
      const merged = mergeGeometries(geometries as THREE.BufferGeometry[], false);
      for (const g of geometries) g.dispose();
      if (!merged) continue;
      const material = new THREE.MeshLambertMaterial({ color });
      material.polygonOffset = true;
      material.polygonOffsetFactor = 1;
      material.polygonOffsetUnits = 1;
      const mesh = new THREE.Mesh(merged, material);
      mesh.name = name;
      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(merged, 30),
        new THREE.LineBasicMaterial({ color: COLORS.edges, transparent: true, opacity: 0.55 }),
      );
      group.add(mesh, edges);
    }
    return group;
  }

  private buildTrees(scene: TerritoryScene): THREE.InstancedMesh | null {
    const count = scene.trees.length / 3;
    if (count === 0) return null;
    const mesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(2.2, 1), new THREE.MeshLambertMaterial({ color: COLORS.tree }), count);
    mesh.name = "árboles";
    const matrix = new THREE.Matrix4();
    const scale = new THREE.Vector3();
    for (let k = 0; k < count; k++) {
      const [x, y, z] = scene.trees.slice(k * 3, k * 3 + 3);
      const s = 0.8 + ((k * 7919) % 100) / 250; // variación estable, sin azar
      scale.set(s, s * 1.15, s);
      matrix.compose(new THREE.Vector3(x, z + TREE_HEIGHT * s * 0.6, -y), new THREE.Quaternion(), scale);
      mesh.setMatrixAt(k, matrix);
    }
    return mesh;
  }

  // --- Alturas máximas del PRC -------------------------------------------------------------------

  /**
   * Superficie translúcida a "terreno + altura máxima" sobre cada zona con cifra verificada, con su
   * contorno. Es una referencia volumétrica: no incluye rasantes ni distanciamientos.
   */
  private buildHeights(scene: TerritoryScene): THREE.Group {
    const group = new THREE.Group();
    group.name = "alturas máximas PRC";
    for (const zone of scene.zones) {
      if (zone.maxHeight === null) continue;
      const shape = toShape(zone.rings);
      if (!shape) continue;
      const geometry = new THREE.ShapeGeometry(shape);
      geometry.rotateX(-Math.PI / 2);
      const position = geometry.getAttribute("position");
      for (let k = 0; k < position.count; k++) {
        const x = position.getX(k);
        const y = -position.getZ(k);
        position.setY(k, this.groundAt(scene, x, y) + zone.maxHeight);
      }
      geometry.computeVertexNormals();
      const color = heightColor(zone.maxHeight);
      const lid = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false }));
      lid.name = `${zone.code} ${zone.maxHeight} m`;
      lid.userData = { code: zone.code, maxHeight: zone.maxHeight, source: zone.source };
      group.add(lid);
      // Contorno a la altura máxima, siguiendo el terreno (cada ~5 m).
      const lineMaterial = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.95 });
      for (const ring of zone.rings) {
        const points: THREE.Vector3[] = [];
        for (let k = 0; k + 3 < ring.length; k += 2) {
          const [ax, ay, bx, by] = [ring[k], ring[k + 1], ring[k + 2], ring[k + 3]];
          const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / 5));
          for (let t = 0; t < steps; t++) {
            const x = ax + ((bx - ax) * t) / steps;
            const y = ay + ((by - ay) * t) / steps;
            points.push(new THREE.Vector3(x, this.groundAt(scene, x, y) + zone.maxHeight, -y));
          }
        }
        group.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(points), lineMaterial));
      }
    }
    return group;
  }

  /** Cota del terreno (interpolación bilineal de la grilla) en coordenadas relativas al origen. */
  private groundAt(scene: TerritoryScene, x: number, y: number): number {
    const { x0, y0, step, columns, rows, z } = scene.terrain;
    const fx = Math.min(Math.max((x - x0) / step, 0), columns - 1.0001);
    const fy = Math.min(Math.max((y - y0) / step, 0), rows - 1.0001);
    const i = Math.floor(fx);
    const j = Math.floor(fy);
    const tx = fx - i;
    const ty = fy - j;
    const at = (a: number, b: number) => z[b * columns + a];
    return (at(i, j) * (1 - tx) + at(i + 1, j) * tx) * (1 - ty) + (at(i, j + 1) * (1 - tx) + at(i + 1, j + 1) * tx) * ty;
  }
}

interface Point3 {
  x: number;
  y: number;
  z: number;
}

/** Modelo → mapa (Este, Norte, cota) con [origenX, origenY, Este, Norte, cos, sen, escala, desfase Z]. */
function modelToMap(f: number[], p: Point3): Point3 {
  const [ox, oy, e, n, cos, sin, scale, offset] = f;
  const dx = (p.x - ox) * scale;
  const dy = (p.y - oy) * scale;
  return { x: e + dx * cos - dy * sin, y: n + dx * sin + dy * cos, z: p.z - offset };
}

function mapToModel(f: number[], p: Point3): Point3 {
  const [ox, oy, e, n, cos, sin, scale, offset] = f;
  const de = (p.x - e) / scale;
  const dn = (p.y - n) / scale;
  return { x: ox + de * cos + dn * sin, y: oy - de * sin + dn * cos, z: p.z + offset };
}

/** Anillos [x, y…] del modelo → Shape de three.js en el plano (x, y); los siguientes anillos son agujeros. */
function toShape(rings: number[][]): THREE.Shape | null {
  const points = (ring: number[]) => {
    const list: THREE.Vector2[] = [];
    for (let k = 0; k + 1 < ring.length; k += 2) list.push(new THREE.Vector2(ring[k], ring[k + 1]));
    if (list.length > 1 && list[0].equals(list[list.length - 1])) list.pop();
    return list;
  };
  const outer = points(rings[0]);
  if (outer.length < 3) return null;
  const shape = new THREE.Shape(outer);
  for (const hole of rings.slice(1)) {
    const h = points(hole);
    if (h.length >= 3) shape.holes.push(new THREE.Path(h));
  }
  return shape;
}

function ringCenter(ring: number[]): [number, number] {
  let sx = 0;
  let sy = 0;
  const n = ring.length / 2;
  for (let k = 0; k < ring.length; k += 2) {
    sx += ring[k];
    sy += ring[k + 1];
  }
  return [sx / n, sy / n];
}

/** Escala fija para comparar entre zonas y lugares: 7 m (verde) → 30 m (rojo anaranjado). */
export const HEIGHT_SCALE = { min: 7, max: 30 };

function heightColor(meters: number): THREE.Color {
  const t = Math.min(Math.max((meters - HEIGHT_SCALE.min) / (HEIGHT_SCALE.max - HEIGHT_SCALE.min), 0), 1);
  return new THREE.Color().setHSL(0.33 - 0.31 * t, 0.7, 0.48);
}

export function formatMeters(value: number): string {
  return `${value.toLocaleString("es-CL", { maximumFractionDigits: 1 })} m`;
}
