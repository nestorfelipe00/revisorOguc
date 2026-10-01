import type { BncViewer } from "./viewer";
import { VIEW_PRESETS, type PickedPoint, type Storey, type ToolMode, type ViewerTools } from "./tools";
import { formatMeters, HEIGHT_SCALE, type TerritoryContext } from "./territory";
import type { TheoreticalVolume } from "./envelope";
import { RASANTE_COLORS, type RasantePlanes } from "./rasante";

// Íconos Segoe Fluent / MDL2 (fuentes del sistema en Windows 10/11): mismo estilo que la app WPF.
const ICON = {
  fit: "",
  zoom: "",
  camera: "",
  storeys: "",
  cut: "",
  ruler: "",
  xray: "",
  isolate: "",
  hide: "",
  show: "",
  chevron: "",
  city: "",
  move: "",
  fine: "",
  close: "",
};

/** Magnitudes típicas de coordenadas UTM en Chile (Este 160–840 km, Norte 3.700–8.100 km). */
const looksLikeChileanUtm = (x: number, y: number) => x > 160_000 && x < 840_000 && y > 3_700_000 && y < 8_100_000;

const es = (value: number, decimals: number) =>
  value.toLocaleString("es-CL", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });

/** Barra de herramientas flotante dentro del visor (HTML: WPF no puede dibujar sobre WebView2). */
export class Toolbar {
  private readonly bar = element("div", "toolbar");
  private readonly hint = element("div", "hint");
  private readonly coords = element("div", "coords");
  private readonly buttons = new Map<string, HTMLButtonElement>();
  private readonly menus: HTMLElement[] = [];
  private storeysMenu!: HTMLElement;
  private storeys: Storey[] = [];
  private cityMenu!: HTMLElement;
  private city: TerritoryContext | null = null;
  private envelope: TheoreticalVolume | null = null;
  private rasantes: RasantePlanes | null = null;
  private requestCity: () => void = () => {};
  private openQuick: () => void = () => {};
  private openFine: () => void = () => {};
  private cityRequested = false;
  private readonly notice = element("div", "hint notice");
  private readonly legend = element("div", "legend");
  private legendCollapsed = false;
  private readonly info = element("div", "city-info");
  /** Columna de la esquina superior derecha: la leyenda arriba y, si se abre, el panel de fuentes debajo. */
  private readonly rightPanels = element("div", "right-panels");
  private noticeTimer = 0;

  constructor(
    root: HTMLElement,
    private readonly viewer: BncViewer,
    private readonly tools: ViewerTools,
  ) {
    this.build();
    this.hint.hidden = true;
    this.coords.hidden = true;
    this.notice.hidden = true;
    this.legend.hidden = true;
    this.info.hidden = true;
    this.rightPanels.append(this.legend, this.info);
    root.append(this.hint, this.notice, this.bar, this.coords, this.rightPanels);
    document.addEventListener("pointerdown", (e) => {
      if (!(e.target as HTMLElement).closest(".menu, .has-menu")) this.closeMenus();
    });
    this.setEnabled(false);
  }

  setEnabled(enabled: boolean): void {
    for (const button of this.buttons.values()) button.disabled = !enabled;
    if (!enabled) this.closeMenus();
  }

  setMode(mode: ToolMode, hint: string | null): void {
    this.buttons.get("clip")!.classList.toggle("active", mode === "clip");
    this.buttons.get("measure")!.classList.toggle("active", mode === "length" || mode === "area" || mode === "angle");
    this.hint.replaceChildren();
    this.hint.hidden = !hint;
    if (hint) {
      const exit = button(ICON.close, "Salir de la herramienta (Esc)", () => this.tools.setMode("select"));
      this.hint.append(text("span", hint), exit);
    }
  }

  setStoreys(storeys: Storey[]): void {
    this.storeys = storeys;
    this.renderStoreys();
  }

  /** Conecta el menú "Ciudad 3D"; <paramref name="request"/> pide el contexto al host la primera vez. */
  attachCity(city: TerritoryContext, request: () => void): void {
    this.city = city;
    this.requestCity = request;
  }

  /** Conecta los botones "Colocación rápida" y "Ajuste fino". */
  attachPlacement(quick: () => void, fine: () => void): void {
    this.openQuick = quick;
    this.openFine = fine;
  }

  /** Destaca "Colocación rápida" cuando el modelo no trae una ubicación confiable y explica por qué (una vez). */
  setPlacementHint(suggest: boolean, message: string | null): void {
    this.buttons.get("quick")?.classList.toggle("suggest", suggest);
    if (suggest && message) this.notify(message, 10);
  }

  /** El host no pudo armar el contexto: se explica el motivo. */
  cityUnavailable(reason: string): void {
    this.cityRequested = false;
    this.notify(reason, 12);
    this.renderCity();
  }

  /** Volumen teórico de la revisión normativa (se muestra y oculta desde el menú de la ciudad). */
  attachEnvelope(envelope: TheoreticalVolume, rasantes: RasantePlanes): void {
    this.envelope = envelope;
    this.rasantes = rasantes;
  }

  /** El host entregó (o quitó) el volumen teórico o las rasantes. */
  envelopeChanged(announce = true): void {
    const envelope = this.envelope;
    if (announce && envelope?.loaded) {
      this.notify(`Volumen teórico (cabida): ${es(envelope.volume, 0)} m³ sobre el predio. Referencial: altura de la zona, rasantes y distanciamientos.`, 10);
    }
    this.updateCityState();
  }

  /** El host entregó (o actualizó) el contexto territorial. */
  cityLoaded(): void {
    this.cityRequested = false;
    this.notify(null);
    this.updateCityState();
  }

  /** Mensaje temporal sobre la barra (p. ej. por qué no se puede mostrar la ciudad). */
  notify(message: string | null, seconds = 8): void {
    window.clearTimeout(this.noticeTimer);
    this.notice.hidden = !message;
    this.notice.textContent = message ?? "";
    if (message && seconds > 0) this.noticeTimer = window.setTimeout(() => (this.notice.hidden = true), seconds * 1000);
  }

  showPoint(point: PickedPoint | null): void {
    this.coords.hidden = !point;
    if (!point) return;
    const { x, y, z } = point.local;
    const rows = [text("div", `X ${es(x, 3)}   Y ${es(y, 3)}   Z ${es(z, 3)} m`)];
    if (point.map) {
      rows.push(text("div", `E ${es(point.map.easting, 2)}   N ${es(point.map.northing, 2)}   H ${es(point.map.height, 2)}${point.map.crs ? ` · ${point.map.crs}` : ""}`));
    } else if (looksLikeChileanUtm(x, y)) {
      rows.push(text("div", "Sin IfcMapConversion, pero X/Y tienen magnitud UTM (Chile, huso 18S/19S): probablemente coordenadas compartidas o topográficas del modelo. El huso y el datum se confirmarán en Territorio.", "muted"));
    } else {
      rows.push(text("div", "Sin georreferencia en el IFC (IfcMapConversion): coordenadas locales del modelo", "muted"));
    }
    const close = button(ICON.close, "Cerrar", () => (this.coords.hidden = true));
    this.coords.replaceChildren(text("div", "Punto", "label"), ...rows, close);
  }

  private build(): void {
    this.add("fit", ICON.fit, "Ajustar vista a los modelos (F)", () => this.viewer.fitAll());
    this.add("zoom", ICON.zoom, "Centrar en la selección", () => this.viewer.fitSelection());
    this.separator();

    const views = this.menuButton("views", ICON.camera, "Vistas predefinidas");
    for (const [key, preset] of Object.entries(VIEW_PRESETS)) {
      views.append(menuItem(preset.label, () => void this.tools.viewPreset(key)));
    }
    const projection = this.add("projection", "", "Cambiar entre perspectiva y proyección ortogonal", async () => {
      await this.tools.toggleProjection();
      this.updateProjectionLabel();
    });
    projection.classList.add("text");
    this.updateProjectionLabel();
    this.separator();

    this.storeysMenu = this.menuButton("storeys", ICON.storeys, "Pisos: planta 2D o aislar un nivel");
    this.renderStoreys();

    const clip = this.menuButton("clip", ICON.cut, "Planos de corte");
    clip.append(
      menuItem("Crear cortes (doble clic sobre una cara)", () => this.tools.setMode("clip")),
      menuItem("Quitar todos los cortes", () => this.tools.clearClips()),
    );
    const measure = this.menuButton("measure", ICON.ruler, "Mediciones");
    measure.append(
      menuItem("Distancia", () => this.tools.setMode("length")),
      menuItem("Área", () => this.tools.setMode("area")),
      menuItem("Ángulo", () => this.tools.setMode("angle")),
      menuItem("Borrar mediciones", () => this.tools.clearMeasurements()),
    );
    this.separator();

    this.cityMenu = this.menuButton("city", ICON.city, "Ciudad 3D: entorno, terreno y alturas máximas del PRC");
    this.renderCity();
    this.add("quick", ICON.move, "Colocación rápida: arrastrar y girar el modelo en la planta de ubicación", () => this.openQuick());
    this.add("fine", ICON.fine, "Ajuste fino: mover, subir, bajar y girar con pasos precisos; puntos conocidos", () => this.openFine());
    this.separator();

    const xray = this.add("xray", ICON.xray, "Rayos X: ver elementos ocultos o solapados", () => {
      this.tools.setXray(!this.tools.isXray);
      xray.classList.toggle("active", this.tools.isXray);
    });
    this.add("isolate", ICON.isolate, "Aislar selección", () => void this.viewer.isolateSelection());
    this.add("hide", ICON.hide, "Ocultar selección", () => void this.viewer.hideSelection());
    this.add("show", ICON.show, "Mostrar todo", () => void this.viewer.showAll());
  }

  private renderCity(): void {
    if (!this.cityMenu) return;
    const city = this.city;
    this.cityMenu.replaceChildren();
    const check = (on: boolean, label: string) => `${on ? "✓" : "  "}  ${label}`;
    const envelope = this.envelope;
    const rasantes = this.rasantes;
    const reviewItems = () => [
      ...(envelope?.loaded
        ? [menuItem(check(envelope.visible, "Volumen teórico (cabida)"), () => this.setCity(() => envelope.setVisible(!envelope.visible)))]
        : []),
      ...(rasantes?.loaded
        ? [menuItem(check(rasantes.visible, `Rasantes ${rasantes.angle}°`), () => this.setCity(() => rasantes.setVisible(!rasantes.visible)))]
        : []),
    ];
    if (!city?.loaded) {
      this.cityMenu.append(
        menuItem(this.cityRequested ? "Preparando la ciudad 3D…" : "Mostrar ciudad 3D", () => this.showCity(), "accent"),
        text("div", "Edificios, calles, áreas verdes y terreno alrededor del proyecto, con las alturas máximas del PRC.", "menu-note"),
      );
      if (envelope?.loaded || rasantes?.loaded) this.cityMenu.append(element("div", "menu-separator"), ...reviewItems());
      return;
    }
    this.cityMenu.append(
      menuItem(city.visible ? "Ocultar ciudad 3D" : "Mostrar ciudad 3D", () => {
        city.setVisible(!city.visible);
        this.updateCityState();
      }, "accent"),
      menuItem("Encuadrar el entorno", () => city.frame()),
      menuItem("Colocación rápida del modelo…", () => this.openQuick()),
      menuItem("Ajuste fino de la ubicación…", () => this.openFine()),
      element("div", "menu-separator"),
      menuItem(check(city.ground === "plano", "Suelo: plano base"), () => this.setCity(() => city.setGroundStyle("plano"))),
      menuItem(check(city.ground === "blanco", "Suelo: maqueta blanca"), () => this.setCity(() => city.setGroundStyle("blanco"))),
      menuItem(check(city.zoneOutlines, "Zonas del PRC en el suelo"), () => this.setCity(() => city.setZoneOutlines(!city.zoneOutlines))),
      menuItem(check(city.heightsVisible, "Alturas máximas del PRC"), () => this.setCity(() => city.setHeightsVisible(!city.heightsVisible))),
      menuItem(check(city.treesVisible, "Árboles"), () => this.setCity(() => city.setTreesVisible(!city.treesVisible))),
      ...reviewItems(),
      element("div", "menu-separator"),
      menuItem("Fuentes y supuestos…", () => this.showCityInfo()),
    );
  }

  private showCity(): void {
    if (this.city?.loaded) {
      this.city.setVisible(true);
      this.city.frame();
      this.updateCityState();
      return;
    }
    if (this.cityRequested) return;
    this.cityRequested = true;
    this.notify("Preparando la ciudad 3D alrededor del proyecto…", 0);
    this.requestCity();
  }

  private setCity(change: () => void): void {
    change();
    this.updateCityState();
  }

  private updateCityState(): void {
    const city = this.city;
    const envelope = this.envelope?.visible ? this.envelope : null;
    const rasantes = this.rasantes?.visible ? this.rasantes : null;
    this.buttons.get("city")?.classList.toggle("active", !!city?.visible);
    this.renderCity();
    this.legend.hidden = !city?.visible && !envelope && !rasantes;
    if (!city?.visible) this.info.hidden = true;
    const swatch = (color: string, label: string, kind = "") => {
      const row = element("div", "legend-row");
      const box = element("span", `swatch ${kind}`);
      box.style.background = color;
      row.append(box, text("span", label));
      return row;
    };
    // Desplegable: el encabezado muestra u oculta el contenido y el estado se mantiene al redibujar.
    const header = document.createElement("button");
    header.className = "legend-header";
    header.setAttribute("aria-expanded", String(!this.legendCollapsed));
    header.title = this.legendCollapsed ? "Mostrar leyenda" : "Ocultar leyenda";
    header.append(text("span", "Leyenda"), text("span", this.legendCollapsed ? "" : "", "chevron"));
    header.addEventListener("click", () => {
      this.legendCollapsed = !this.legendCollapsed;
      this.updateCityState();
    });
    const body = element("div", "legend-body");
    body.hidden = this.legendCollapsed;
    this.legend.replaceChildren(header, body);
    if (envelope) body.append(swatch("rgba(63,185,80,0.45)", `Volumen teórico: ${es(envelope.volume, 0)} m³`));
    if (rasantes) {
      body.append(
        swatch(RASANTE_COLORS.Vecino, `Rasante ${rasantes.angle}° desde deslinde / área verde`),
        swatch(RASANTE_COLORS.Frente, `Rasante ${rasantes.angle}° desde el eje de la calle`),
      );
      if (rasantes.excesses > 0) body.append(swatch("#e5534b", "Punto que sobrepasa la rasante"));
    }
    if (!city?.visible) return;
    body.append(
      text("div", "Ciudad 3D (referencial)", "label"),
      swatch("#c3c6ca", "Edificio con altura de la fuente"),
      swatch("#d9dbde", "Edificio con altura estimada"),
      swatch("transparent", "Zona del PRC", "dashed"),
    );
    if (city.parcelShown) {
      body.append(
        swatch("#e8590c", "Deslinde con vecino"),
        swatch("#1c7ed6", "Frente a espacio público"),
        swatch("#2f9e44", "Frente a área verde"),
      );
    }
    if (city.heightsVisible) {
      body.append(swatch("linear-gradient(90deg, hsl(119,70%,48%), hsl(7,70%,48%))",
        `Altura máxima PRC: ${HEIGHT_SCALE.min} m → ${HEIGHT_SCALE.max} m o más`));
    }
  }

  private showCityInfo(): void {
    const city = this.city;
    if (!city) return;
    const close = button(ICON.close, "Cerrar", () => (this.info.hidden = true));
    const zones = city.zones
      .filter((z, i, all) => all.findIndex((o) => o.code === z.code) === i)
      .sort((a, b) => a.code.localeCompare(b.code));
    const list = element("div", "city-zones");
    for (const zone of zones) {
      list.append(
        text("div", `${zone.code} · ${zone.maxHeight !== null ? formatMeters(zone.maxHeight) : "sin altura verificada"}`, "zone-title"),
        text("div", zone.source ?? zone.name, "muted"),
      );
    }
    this.info.replaceChildren(
      text("div", "Fuentes y supuestos de la ciudad 3D", "label"),
      ...city.notes.map((note) => text("div", note, "note")),
      text("div", "Fuentes y licencias", "label"),
      ...city.sources.map((source) => text("div", source, "note muted")),
      text("div", "Zonas del PRC en el entorno", "label"),
      list,
      close,
    );
    this.info.hidden = false;
  }

  private renderStoreys(): void {
    if (!this.storeysMenu) return;
    this.storeysMenu.replaceChildren();
    if (this.tools.activeStorey) {
      this.storeysMenu.append(menuItem("← Volver a la vista 3D", () => this.tools.closeStorey(), "accent"));
    }
    if (this.storeys.length === 0) {
      this.storeysMenu.append(text("div", "Sin niveles (IfcBuildingStorey) en los modelos", "menu-empty"));
      return;
    }
    // De arriba hacia abajo, como en un corte del edificio.
    for (const storey of [...this.storeys].reverse()) {
      const row = element("div", "menu-row");
      row.append(
        text("span", storey.name, "menu-label"),
        smallButton("Planta", "Planta 2D del nivel (corte a 1,2 m)", () => {
          this.tools.openStorey(storey.name);
          this.closeMenus();
        }),
        smallButton("Aislar", "Ver solo los elementos de este nivel en 3D", async () => {
          this.tools.closeStorey();
          await this.tools.isolateStorey(storey.name);
          this.closeMenus();
        }),
      );
      this.storeysMenu.append(row);
    }
  }

  private updateProjectionLabel(): void {
    const button = this.buttons.get("projection");
    if (button) button.textContent = this.tools.isOrthographic ? "Orto" : "Persp";
  }

  private add(key: string, icon: string, title: string, onClick: () => void): HTMLButtonElement {
    const b = button(icon, title, onClick);
    this.buttons.set(key, b);
    this.bar.append(b);
    return b;
  }

  private menuButton(key: string, icon: string, title: string): HTMLElement {
    const wrapper = element("div", "has-menu");
    const menu = element("div", "menu");
    menu.hidden = true;
    const b = button(icon, title, () => {
      const wasOpen = !menu.hidden;
      this.closeMenus();
      if (!wasOpen) {
        if (key === "storeys") this.renderStoreys();
        if (key === "city") this.renderCity();
        menu.hidden = false;
      }
    });
    b.append(text("span", ICON.chevron, "chevron"));
    this.buttons.set(key, b);
    menu.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest(".menu-item")) this.closeMenus();
    });
    wrapper.append(menu, b);
    this.bar.append(wrapper);
    this.menus.push(menu);
    return menu;
  }

  private closeMenus(): void {
    for (const menu of this.menus) menu.hidden = true;
  }

  private separator(): void {
    this.bar.append(element("div", "separator"));
  }
}

function element(tag: string, className: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = className;
  return e;
}

function text(tag: string, content: string, className = ""): HTMLElement {
  const e = element(tag, className);
  e.textContent = content;
  return e;
}

function button(icon: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = "tool";
  b.title = title;
  b.setAttribute("aria-label", title);
  b.append(text("span", icon, "icon"));
  b.addEventListener("click", onClick);
  return b;
}

function smallButton(label: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = "small";
  b.textContent = label;
  b.title = title;
  b.addEventListener("click", onClick);
  return b;
}

function menuItem(label: string, onClick: () => void, className = ""): HTMLElement {
  const item = text("button", label, `menu-item ${className}`);
  item.addEventListener("click", onClick);
  return item;
}
