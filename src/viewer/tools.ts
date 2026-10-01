import * as THREE from "three";
import * as OBC from "@thatopen/components";
import * as OBF from "@thatopen/components-front";
import * as FRAGS from "@thatopen/fragments";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import type { BncViewer } from "./viewer";
import type { Georeference } from "./protocol";

export type ToolMode = "select" | "clip" | "length" | "area" | "angle";

type Measurer = OBF.LengthMeasurement | OBF.AreaMeasurement | OBF.AngleMeasurement;

export interface Storey {
  name: string;
  /** Altura del plano de la planta en coordenadas del visor (para ordenar). */
  height: number;
}

export interface PickedPoint {
  /** Coordenadas IFC del modelo base (m): X, Y en planta, Z altura. */
  local: THREE.Vector3;
  /** Coordenadas de mapa si el modelo base está georreferenciado (IfcMapConversion). */
  map: { easting: number; northing: number; height: number; crs: string | null } | null;
}

const LEVELS = "Niveles";
const MEASURE_COLOR = new THREE.Color("#f2b84b");

export const VIEW_PRESETS: Record<string, { label: string; direction: THREE.Vector3 }> = {
  iso: { label: "Isométrica", direction: new THREE.Vector3(1, 0.9, 1) },
  top: { label: "Superior (planta)", direction: new THREE.Vector3(0, 1, 0.0001) },
  front: { label: "Frontal (sur)", direction: new THREE.Vector3(0, 0, 1) },
  back: { label: "Posterior (norte)", direction: new THREE.Vector3(0, 0, -1) },
  left: { label: "Izquierda (poniente)", direction: new THREE.Vector3(-1, 0, 0) },
  right: { label: "Derecha (oriente)", direction: new THREE.Vector3(1, 0, 0) },
};

const HINTS: Record<ToolMode, string | null> = {
  select: null,
  clip: "Corte: doble clic sobre una superficie crea un plano · arrastre sus flechas para moverlo · Supr borra el plano bajo el cursor · Esc para salir",
  length: "Distancia: doble clic en el punto inicial y doble clic en el final · Supr borra la cota bajo el cursor · Esc para salir",
  area: "Área: doble clic en cada vértice y doble clic de nuevo en el último para cerrar · Supr borra · Esc para salir",
  angle: "Ángulo: doble clic en tres puntos (el segundo es el vértice) · Supr borra · Esc para salir",
};

/**
 * Herramientas del visor construidas con los componentes de That Open:
 * cortes (Clipper + ClipStyler), plantas por piso (Views + Classifier), mediciones,
 * resaltado al pasar (Hoverer), rayos X, proyección, vistas predefinidas y coordenadas.
 */
export class ViewerTools {
  onModeChanged: (mode: ToolMode, hint: string | null) => void = () => {};
  onStoreysChanged: (storeys: Storey[]) => void = () => {};
  onPointPicked: (point: PickedPoint | null) => void = () => {};

  private mode: ToolMode = "select";
  private xray = false;
  private readonly georefs = new Map<string, Georeference>();
  private readonly components: OBC.Components;
  private readonly world: BncViewer["world"];
  private clipper!: OBC.Clipper;
  private views!: OBC.Views;
  private measurers!: { length: OBF.LengthMeasurement; area: OBF.AreaMeasurement; angle: OBF.AngleMeasurement };
  private openStoreyName: string | null = null;

  constructor(private readonly viewer: BncViewer) {
    this.components = viewer.components;
    this.world = viewer.world;
  }

  init(container: HTMLElement): void {
    const hoverer = this.components.get(OBF.Hoverer);
    hoverer.world = this.world;
    hoverer.material = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.18, depthTest: false });
    hoverer.enabled = true;

    this.clipper = this.components.get(OBC.Clipper);
    this.clipper.enabled = false;
    this.clipper.config.color = new THREE.Color("#2fa36b");
    this.clipper.config.opacity = 0.15;
    this.setupSectionFill();

    this.views = this.components.get(OBC.Views);
    this.views.world = this.world;

    const length = this.components.get(OBF.LengthMeasurement);
    const area = this.components.get(OBF.AreaMeasurement);
    const angle = this.components.get(OBF.AngleMeasurement);
    this.measurers = { length, area, angle };
    for (const measurer of this.allMeasurers()) {
      measurer.world = this.world;
      measurer.color = MEASURE_COLOR;
      measurer.snappings = [FRAGS.SnappingClass.POINT];
      measurer.enabled = false;
    }

    container.addEventListener("dblclick", () => void this.onDoubleClick());
    this.trackClicks(container);

    // Materiales creados después (p. ej. al cargar otro modelo) respetan el modo rayos X.
    this.viewer.fragments.core.models.materials.list.onItemSet.add(({ value }) => {
      if (this.xray) applyXray(value, true);
    });
  }

  get currentMode(): ToolMode {
    return this.mode;
  }

  get isXray(): boolean {
    return this.xray;
  }

  get isOrthographic(): boolean {
    return this.world.camera.projection.current === "Orthographic";
  }

  setMode(mode: ToolMode): void {
    this.mode = mode;
    this.clipper.enabled = mode === "clip";
    for (const [key, measurer] of Object.entries(this.measurers) as [ToolMode, Measurer][]) {
      if (key !== mode && measurer.enabled) measurer.cancelCreation();
      measurer.enabled = key === mode;
    }
    // Mientras se mide o se corta, el clic no selecciona elementos.
    this.viewer.highlighter.config.selectEnabled = mode === "select";
    this.onModeChanged(mode, HINTS[mode]);
  }

  /** Supr: borra el plano o la medición bajo el cursor, según la herramienta activa. */
  async deleteUnderCursor(): Promise<void> {
    if (this.mode === "clip") await this.clipper.delete(this.world);
    else if (this.mode !== "select") this.measurers[this.mode].delete();
  }

  clearClips(): void {
    this.clipper.deleteAll();
  }

  clearMeasurements(): void {
    for (const measurer of this.allMeasurers()) measurer.list.clear();
  }

  private allMeasurers(): Measurer[] {
    return [this.measurers.length, this.measurers.area, this.measurers.angle];
  }

  private async onDoubleClick(): Promise<void> {
    if (this.mode === "clip") await this.clipper.create(this.world);
    else if (this.mode !== "select") await this.measurers[this.mode].create();
  }

  // --- Relleno de sección en los cortes --------------------------------------------

  private setupSectionFill(): void {
    const styler = this.components.get(OBF.ClipStyler);
    styler.world = this.world;
    // Estilo de sección: relleno gris y contorno oscuro, como en un plano de arquitectura.
    styler.styles.set("Seccion", {
      linesMaterial: new LineMaterial({ color: 0x0b0d0f, linewidth: 1.5 }),
      fillsMaterial: new THREE.MeshBasicMaterial({ color: "#5b626a", side: THREE.DoubleSide }),
    });
    this.clipper.list.onItemSet.add(({ key }) => {
      try {
        styler.createFromClipping(key, { items: { Todo: { style: "Seccion" } } });
      } catch {
        // Sin relleno el corte sigue funcionando; solo se ve hueco.
      }
    });
  }

  // --- Pisos: plantas 2D (Views) y aislamiento (Classifier) --------------------------

  async refreshStoreys(): Promise<void> {
    if (this.openStoreyName) this.closeStorey();
    const styler = this.components.get(OBF.ClipStyler);
    for (const id of [...this.views.list.keys()]) {
      styler.list.delete(`planta-${id}`);
      this.views.list.delete(id);
    }
    const created = this.viewer.modelCount > 0 ? await this.views.createFromIfcStoreys({ offset: 1.2 }) : [];
    for (const view of created) {
      try {
        styler.createFromView(view, { id: `planta-${view.id}`, items: { Todo: { style: "Seccion" } } });
      } catch {
        // Sin relleno la planta sigue funcionando.
      }
    }
    const storeys = new Map<string, Storey>();
    // El plano de cada planta es y = constant (normal hacia abajo).
    for (const view of created) storeys.set(view.id, { name: view.id, height: view.plane.constant });
    this.onStoreysChanged([...storeys.values()].sort((a, b) => a.height - b.height));

    const classifier = this.components.get(OBC.Classifier);
    classifier.list.delete(LEVELS);
    if (this.viewer.modelCount > 0) await classifier.byIfcBuildingStorey({ classificationName: LEVELS });
  }

  /** Planta del piso: vista ortogonal desde arriba cortada a 1,2 m sobre el nivel. */
  openStorey(name: string): void {
    if (!this.views.list.has(name)) return;
    this.views.open(name);
    this.openStoreyName = name;
    this.viewer.fitAll(); // encuadra la planta completa en la cámara de la vista
  }

  closeStorey(): void {
    if (!this.openStoreyName) return;
    this.views.close();
    this.openStoreyName = null;
  }

  get activeStorey(): string | null {
    return this.openStoreyName;
  }

  async isolateStorey(name: string): Promise<boolean> {
    const group = this.components.get(OBC.Classifier).list.get(LEVELS)?.get(name);
    if (!group) return false;
    await this.viewer.isolate(await group.get());
    return true;
  }

  // --- Visualización -------------------------------------------------------------------

  /** Rayos X: todo semitransparente para ver elementos ocultos o solapados; la selección se mantiene opaca. */
  setXray(enabled: boolean): void {
    this.xray = enabled;
    for (const material of this.viewer.fragments.core.models.materials.list.values()) applyXray(material, enabled);
    void this.viewer.fragments.core.update(true);
  }

  async toggleProjection(): Promise<void> {
    await this.world.camera.projection.set(this.isOrthographic ? "Perspective" : "Orthographic");
  }

  async viewPreset(key: string): Promise<void> {
    const preset = VIEW_PRESETS[key];
    if (!preset || this.viewer.modelCount === 0) return;
    this.closeStorey();
    const box = new THREE.Box3();
    for (const [, model] of this.viewer.fragments.list) box.union(model.box);
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const target = sphere.center;
    const position = target.clone().addScaledVector(preset.direction.clone().normalize(), Math.max(sphere.radius, 1) * 3);
    const controls = this.world.camera.controls;
    await controls.setLookAt(position.x, position.y, position.z, target.x, target.y, target.z, false);
    controls.fitToSphere(sphere, true).catch(() => {});
  }

  // --- Coordenadas ----------------------------------------------------------------------

  setGeoreference(modelId: string, georef: Georeference | null): void {
    if (georef) this.georefs.set(modelId, georef);
    else this.georefs.delete(modelId);
  }

  forgetModel(modelId: string): void {
    this.georefs.delete(modelId);
  }

  /** Clic sin arrastre: informa el punto 3D bajo el cursor en coordenadas IFC (y de mapa si hay georreferencia). */
  private trackClicks(container: HTMLElement): void {
    let down: { x: number; y: number } | null = null;
    container.addEventListener("pointerdown", (e) => (down = { x: e.clientX, y: e.clientY }));
    container.addEventListener("pointerup", async (e) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4 || this.mode !== "select") return;
      const hit = await this.components.get(OBC.Raycasters).get(this.world).castRay();
      this.onPointPicked(hit ? this.toPickedPoint(hit.point) : null);
    });
  }

  private toPickedPoint(world: THREE.Vector3): PickedPoint {
    // Fragments traslada cada modelo al origen y guarda sus coordenadas originales; los
    // modelos federados se alinean con el primero. Visor (Y arriba) → IFC (Z arriba).
    const [bx, by, bz] = this.viewer.fragments.core.baseCoordinates ?? [0, 0, 0];
    const local = new THREE.Vector3(world.x - bx, -(world.z - bz), world.y - by);

    const base = [...this.viewer.fragments.list.keys()][0];
    const georef = base ? this.georefs.get(base) : undefined;
    return { local, map: georef ? toMap(local, georef) : null };
  }
}

/** Fórmula de IfcMapConversion: rotación en planta, escala y traslación a coordenadas de mapa. */
function toMap(local: THREE.Vector3, g: Georeference): PickedPoint["map"] {
  const norm = Math.hypot(g.xAxisAbscissa, g.xAxisOrdinate) || 1;
  const cos = g.xAxisAbscissa / norm;
  const sin = g.xAxisOrdinate / norm;
  // Las coordenadas del visor están en metros; IfcMapConversion opera en unidades del proyecto.
  const factor = g.scale / g.lengthScale;
  const x = local.x * factor;
  const y = local.y * factor;
  return {
    easting: g.eastings + x * cos - y * sin,
    northing: g.northings + x * sin + y * cos,
    height: g.height + local.z * factor,
    crs: g.crsName,
  };
}

type XrayMaterial = THREE.Material & { userData: { bncOriginal?: { transparent: boolean; opacity: number; depthWrite: boolean } } };

function applyXray(material: THREE.Material, enabled: boolean): void {
  const m = material as XrayMaterial;
  if (enabled) {
    // Los materiales de resaltado (selección) no se tocan: la selección debe verse sólida.
    if (m.userData.bncOriginal || (m.opacity === 1 && "color" in m && isSelectionColor(m))) return;
    m.userData.bncOriginal = { transparent: m.transparent, opacity: m.opacity, depthWrite: m.depthWrite };
    m.transparent = true;
    m.opacity = Math.min(m.opacity, 0.15);
    m.depthWrite = false;
  } else if (m.userData.bncOriginal) {
    Object.assign(m, m.userData.bncOriginal);
    delete m.userData.bncOriginal;
  }
  m.needsUpdate = true;
}

function isSelectionColor(material: THREE.Material): boolean {
  const color = (material as THREE.Material & { color?: THREE.Color }).color;
  return !!color && color.getHexString() === "43d17a";
}
