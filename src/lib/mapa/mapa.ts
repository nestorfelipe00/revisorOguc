// Mapa territorial (porte de viewer/src/map.ts del escritorio, optimizado para la web): capas del PRC desde PostGIS,
// la ubicación del proyecto, su huella, el predio, las porciones de ciudad 3D e «Indicar ubicación en el mapa».
//
// Optimizaciones web: solo se descarga la comuna del proyecto; las demás se listan y sus capas se traen cuando el
// usuario las marca o pulsa «Ir». Cada capa se pide por separado al activarla (zonificación por defecto) y queda en la
// caché del navegador (Cache API) versionada por la fecha de descarga del instrumento.
import L from "leaflet";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { GeoPoint } from "@/lib/territorio/utm";

export interface InstrumentoMapa {
  carpeta: string;
  nombre: string;
  region: string | null;
  tipo: "comunal" | "intercomunal";
  instrumento: string | null;
  caracter: string | null;
  descargado: string | null;
  manifest: { aviso_vigencia?: string; revision_suspendida?: string } | null;
  /** [minLon, minLat, maxLon, maxLat] */
  extension: [number, number, number, number] | null;
}

export interface ProyectoMapa {
  center: GeoPoint | null;
  footprint: GeoPoint[] | null;
  label: string;
  summary: string[];
  /** Porción cargada en la ciudad 3D (rectángulo lon/lat). */
  cityArea: GeoPoint[] | null;
  /** Porciones de ciudad 3D disponibles (rectángulos lon/lat). */
  cityPortions: GeoPoint[][];
  parcel: GeoPoint[] | null;
}

export interface MapaCallbacks {
  onPick(point: GeoPoint): void;
  onPickingChanged(picking: boolean): void;
  onError(message: string): void;
}

interface CapaFila {
  id: number;
  nombre: string;
  rol: string;
}

/** Capa del panel: su geometría se descarga la primera vez que se activa. */
interface PanelLayer {
  id: number;
  name: string;
  rol: string;
  layer: L.GeoJSON | null;
  loading: boolean;
}

const ACCENT = "#43d17a";
const CACHE = "bnc-mapa-capas";
/** Capas que se activan solas al cargar una comuna; el resto se descarga solo si el usuario las marca. */
const DEFAULT_ROLES = new Set(["zonas", "subzonas"]);

const REGION_ORDER = [
  "Arica y Parinacota", "Tarapacá", "Antofagasta", "Atacama", "Coquimbo", "Valparaíso", "Metropolitana de Santiago",
  "Libertador General Bernardo O'Higgins", "Maule", "Ñuble", "Biobío", "La Araucanía", "Los Ríos", "Los Lagos",
  "Aysén del General Carlos Ibáñez del Campo", "Magallanes y de la Antártica Chilena",
];

const plain = (text: string) => text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

const boundsOf = (e: [number, number, number, number]) => L.latLngBounds([e[1], e[0]], [e[3], e[2]]);

function zoneColor(code: string): string {
  let hash = 0;
  for (const c of code) hash = (hash * 31 + c.charCodeAt(0)) | 0;
  return `hsl(${Math.abs(hash) % 360}, 55%, 55%)`;
}

const plainText = (text: string): HTMLElement => Object.assign(document.createElement("span"), { textContent: text });

/** Instrumentos cargados en Supabase con su extensión (del polígono «extension»). Es una lista corta: no trae geometría de capas. */
export async function instrumentosMapa(supabase: SupabaseClient): Promise<InstrumentoMapa[]> {
  const { data, error } = await supabase
    .from("instrumentos")
    .select("carpeta, nombre, region, tipo, instrumento, caracter, descargado, manifest, extension_geojson:extension");
  if (error) throw new Error(`No se pudieron leer los instrumentos: ${error.message}`);
  return ((data ?? []) as (Omit<InstrumentoMapa, "extension"> & { extension_geojson: { coordinates?: number[][][] } | null })[]).map((row) => {
    const ring = row.extension_geojson?.coordinates?.[0];
    const lons = ring?.map((c) => c[0]) ?? [];
    const lats = ring?.map((c) => c[1]) ?? [];
    return {
      carpeta: row.carpeta,
      nombre: row.nombre,
      region: row.region,
      tipo: row.tipo,
      instrumento: row.instrumento,
      caracter: row.caracter,
      descargado: row.descargado,
      manifest: row.manifest,
      extension: ring && ring.length > 0 ? [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)] : null,
    };
  });
}

/** GeoJSON de una capa, desde la caché del navegador si ya se descargó con esta versión del instrumento. */
async function capaGeoJson(supabase: SupabaseClient, capa: number, version: string | null): Promise<GeoJSON.FeatureCollection | null> {
  const key = `${location.origin}/__bnc/capa/${capa}?v=${encodeURIComponent(version ?? "")}`;
  const store = typeof caches !== "undefined" ? await caches.open(CACHE).catch(() => null) : null;
  const hit = await store?.match(key);
  if (hit) return (await hit.json()) as GeoJSON.FeatureCollection;
  const { data, error } = await supabase.rpc("capa_geojson", { capa });
  if (error || !data) return null;
  await store?.put(key, new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } })).catch(() => {});
  return data as GeoJSON.FeatureCollection;
}

export class MapaTerritorial {
  private readonly map: L.Map;
  private readonly projectLayer = L.layerGroup();
  private readonly listed = new Map<string, Promise<void>>();
  private readonly layers = new Map<string, PanelLayer[]>();
  private readonly openRegions = new Set<string>();
  private readonly openCommunes = new Set<string>();
  private instruments: InstrumentoMapa[] = [];
  private picking = false;
  private query = "";
  private pending = 0;
  private readonly list = document.createElement("div");
  private readonly search = document.createElement("input");
  private readonly body = document.createElement("div");
  private readonly header = document.createElement("button");
  private readonly disclaimer: HTMLElement;
  private collapsed = true;
  private disposed = false;
  private projectCenter: L.LatLng | null = null;
  /** El mapa se encuadra en el proyecto una sola vez por instancia; después el usuario manda. */
  private fitted = false;

  constructor(
    container: HTMLElement,
    private readonly supabase: SupabaseClient,
    private readonly callbacks: MapaCallbacks,
  ) {
    this.map = L.map(container, { zoomControl: true, preferCanvas: true }).setView([-29.905, -71.25], 13);
    const baseLayers: Record<string, L.Layer> = {
      "Calles (OpenStreetMap)": L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }),
      "Satélite (Esri)": L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", { maxZoom: 19, attribution: "Esri, Maxar" }),
      "Sin fondo (sin internet)": L.layerGroup(),
    };
    baseLayers["Calles (OpenStreetMap)"].addTo(this.map);
    L.control.layers(baseLayers, {}, { collapsed: true, position: "topright" }).addTo(this.map);
    this.projectLayer.addTo(this.map);
    this.disclaimer = L.DomUtil.create("div", "mapa-disclaimer", container);
    this.addPanel();
    this.map.on("click", (e: L.LeafletMouseEvent) => {
      if (!this.picking) return;
      this.setPicking(false);
      this.callbacks.onPick({ latitude: e.latlng.lat, longitude: e.latlng.lng });
    });
    this.map.on("moveend", () => this.updateDisclaimer());
    void this.loadInstruments();
  }

  /** Leaflet mide el contenedor al crearse: si la ventana aparece después, hay que avisarle. */
  invalidate(): void {
    this.map.invalidateSize();
  }

  dispose(): void {
    this.disposed = true;
    this.map.remove();
    // Leaflet no quita los elementos propios: sin esto quedaría un aviso viejo en el contenedor al volver a montar.
    this.disclaimer.remove();
  }

  get isPicking(): boolean {
    return this.picking;
  }

  setPicking(enabled: boolean): void {
    this.picking = enabled;
    this.map.getContainer().style.cursor = enabled ? "crosshair" : "";
    this.callbacks.onPickingChanged(enabled);
  }

  setProject(project: ProyectoMapa): void {
    const fit = !this.fitted;
    this.fitted = true;
    this.projectLayer.clearLayers();
    for (const portion of project.cityPortions) {
      this.projectLayer.addLayer(
        L.polygon(portion.map((p) => [p.latitude, p.longitude] as [number, number]), { color: "#1fb6c9", weight: 1, dashArray: "3 4", fill: false, interactive: false, opacity: 0.6 }).bindTooltip("Porción de ciudad 3D disponible"),
      );
    }
    if (project.cityArea?.length) {
      this.projectLayer.addLayer(
        L.polygon(project.cityArea.map((p) => [p.latitude, p.longitude] as [number, number]), { color: "#1fb6c9", weight: 1.5, dashArray: "6 5", fill: false, interactive: false }).bindTooltip("Porción cargada en la ciudad 3D"),
      );
    }
    if (project.parcel?.length) {
      this.projectLayer.addLayer(
        L.polygon(project.parcel.map((p) => [p.latitude, p.longitude] as [number, number]), { color: "#e8590c", weight: 2, fillColor: "#e8590c", fillOpacity: 0.15, interactive: false }).bindTooltip("Predio"),
      );
    }
    if (!project.center) {
      this.projectCenter = null;
      if (fit) this.map.setView([-33.45, -70.66], 5);
      return;
    }
    const center = L.latLng(project.center.latitude, project.center.longitude);
    this.projectCenter = center;
    if (project.footprint?.length) {
      const polygon = L.polygon(project.footprint.map((p) => [p.latitude, p.longitude] as [number, number]), { color: ACCENT, weight: 2, fillColor: ACCENT, fillOpacity: 0.25, interactive: false });
      this.projectLayer.addLayer(polygon.bindTooltip(plainText(project.label)));
      if (fit) this.map.fitBounds(polygon.getBounds().pad(2), { maxZoom: 18 });
    } else if (fit) {
      this.map.setView(center, 17);
    }
    this.projectLayer.addLayer(L.circleMarker(center, { radius: 7, color: "#ffffff", weight: 2, fillColor: ACCENT, fillOpacity: 1, interactive: false }).bindTooltip(plainText(project.label)));
    this.loadProjectCommune();
  }

  // --- Instrumentos y capas (bajo demanda) -----------------------------------------------------------------------------

  private async loadInstruments(): Promise<void> {
    try {
      this.instruments = await instrumentosMapa(this.supabase);
    } catch (error) {
      this.callbacks.onError(error instanceof Error ? error.message : String(error));
      return;
    }
    if (this.disposed) return;
    this.render();
    this.loadProjectCommune();
    this.updateDisclaimer();
  }

  /** Solo la comuna del proyecto se carga sola (y, si la cubre, el plan intercomunal queda listado sin descargar). */
  private loadProjectCommune(): void {
    if (!this.projectCenter || this.instruments.length === 0) return;
    const here = this.instrumentAt(this.projectCenter);
    if (!here) return;
    this.openRegions.add(here.region ?? "Sin región");
    this.openCommunes.add(here.carpeta);
    void this.activate(here, true);
  }

  private instrumentAt(point: L.LatLng): InstrumentoMapa | undefined {
    return this.instruments.find((i) => i.tipo === "comunal" && i.extension && boundsOf(i.extension).contains(point)) ?? this.instruments.find((i) => i.extension && boundsOf(i.extension).contains(point));
  }

  /** Lista las capas del instrumento (solo metadatos) y, si se pide, activa las de zonificación. */
  private async activate(instrument: InstrumentoMapa, enableDefaults: boolean): Promise<void> {
    let pending = this.listed.get(instrument.carpeta);
    if (!pending) {
      pending = this.listLayers(instrument).catch((error) => console.warn(`Capas de ${instrument.nombre}:`, error));
      this.listed.set(instrument.carpeta, pending);
    }
    await pending;
    if (this.disposed || !enableDefaults) return;
    const items = (this.layers.get(instrument.carpeta) ?? []).filter((i) => DEFAULT_ROLES.has(i.rol));
    await Promise.all(items.map((i) => this.show(instrument, i, true)));
  }

  private async listLayers(instrument: InstrumentoMapa): Promise<void> {
    const { data, error } = await this.supabase.from("capas_prc").select("id, nombre, rol").eq("carpeta", instrument.carpeta);
    if (error) throw new Error(error.message);
    const order = ["zonas", "subzonas", "uso", "especial", "anterior", "vialidad", "referencia"];
    const capas = ([...(data ?? [])] as CapaFila[]).sort((a, b) => order.indexOf(a.rol) - order.indexOf(b.rol));
    this.layers.set(instrument.carpeta, capas.map((c) => ({ id: c.id, name: c.nombre, rol: c.rol, layer: null, loading: false })));
    this.render();
  }

  /** Muestra u oculta una capa; la primera vez descarga su geometría (o la toma de la caché del navegador). */
  private async show(instrument: InstrumentoMapa, item: PanelLayer, visible: boolean): Promise<void> {
    if (!visible) {
      item.layer?.remove();
      this.render();
      return;
    }
    if (!item.layer && !item.loading) {
      item.loading = true;
      this.render();
      const geojson = await capaGeoJson(this.supabase, item.id, instrument.descargado).catch(() => null);
      item.loading = false;
      if (this.disposed) return;
      if (geojson) item.layer = this.buildLayer(item, geojson);
    }
    item.layer?.addTo(this.map);
    this.render();
    this.updateDisclaimer();
  }

  private buildLayer(item: PanelLayer, geojson: GeoJSON.FeatureCollection): L.GeoJSON {
    return L.geoJSON(geojson, {
      style: (feature) => {
        const p = (feature?.properties ?? {}) as Record<string, unknown>;
        if (item.rol === "zonas" || item.rol === "subzonas") return { color: "#1f2226", weight: 0.6, fillColor: zoneColor(String(p.codigo ?? "")), fillOpacity: 0.35 };
        if (item.rol === "vialidad") {
          const kind = String(p.Descrip ?? "");
          return { color: kind.includes("Apertura") ? "#e5534b" : kind.includes("Ensanche") ? "#d4a72c" : "#8e969e", weight: 1.2 };
        }
        if (item.rol === "especial") return { color: "#b36ae2", weight: 1.2, fillOpacity: 0.15, dashArray: "4 3" };
        if (item.rol === "uso") return { color: "#7f8c99", weight: 0.8, fill: false, dashArray: "2 3" };
        if (item.rol === "anterior") return { color: "#9aa0a6", weight: 0.8, fillColor: "#9aa0a6", fillOpacity: 0.08, dashArray: "6 4" };
        return { color: "#f5f5f5", weight: 2, dashArray: "8 6", fill: false };
      },
      onEachFeature: (feature, l) => {
        if (item.rol === "referencia") return;
        // Sin bindPopup: su apertura detiene el evento y el clic nunca llegaría al mapa en modo «indicar ubicación».
        l.on("click", (e: L.LeafletMouseEvent) => {
          if (this.picking) return;
          L.popup().setLatLng(e.latlng).setContent(this.popup((feature.properties ?? {}) as Record<string, unknown>)).openOn(this.map);
        });
      },
    });
  }

  private popup(properties: Record<string, unknown>): HTMLElement {
    const box = document.createElement("div");
    const name = String(properties.nombre ?? properties.codigo ?? properties.Nombre ?? properties.Descrip ?? "");
    const code = String(properties.codigo ?? "");
    box.append(Object.assign(document.createElement("strong"), { textContent: code && code !== name ? `${code} · ${name}` : name }));
    const sheet = typeof properties.ficha_url === "string" && properties.ficha_url ? properties.ficha_url : null;
    if (sheet) {
      const link = Object.assign(document.createElement("a"), { href: sheet, target: "_blank", rel: "noreferrer noopener", textContent: "Ver ficha de la zona" });
      box.append(document.createElement("br"), link);
    }
    return box;
  }

  private updateDisclaimer(): void {
    const here = this.instrumentAt(this.map.getCenter());
    const shown = here ? (this.layers.get(here.carpeta) ?? []).some((i) => i.layer && this.map.hasLayer(i.layer)) : false;
    const m = here?.manifest ?? null;
    this.disclaimer.textContent = here && shown
      ? `${here.instrumento ?? "PRC"} · ${here.nombre} — ${m?.revision_suspendida ? `⚠ Revisión suspendida: ${m.revision_suspendida} ` : ""}${m?.aviso_vigencia ? `⚠ ${m.aviso_vigencia} ` : ""}${here.caracter ?? ""}`
      : here
        ? `${here.nombre}: active sus capas en «Planes reguladores (PRC)» o pulse «Ir».`
        : "Sin PRC cargado en esta zona del mapa.";
  }

  // --- Panel de capas: región → comuna → capa, con buscador -------------------------------------------------------------

  private addPanel(): void {
    const PanelControl = L.Control.extend({
      onAdd: () => {
        const box = L.DomUtil.create("div", "leaflet-control prc-panel");
        this.header.type = "button";
        this.header.className = "prc-header";
        this.header.addEventListener("click", () => this.setCollapsed(!this.collapsed));
        box.append(this.header, this.body);
        this.setCollapsed(this.collapsed);
        this.search.type = "search";
        this.search.placeholder = "Buscar región, comuna o capa…";
        this.search.setAttribute("aria-label", "Buscar región, comuna o capa del PRC");
        this.search.addEventListener("input", () => {
          this.query = plain(this.search.value.trim());
          this.render();
        });
        this.search.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            const first = this.groups()[0]?.[1][0];
            if (first) this.goTo(first);
          }
        });
        this.body.className = "prc-body";
        this.body.append(this.search, this.list);
        L.DomEvent.disableClickPropagation(box);
        L.DomEvent.disableScrollPropagation(box);
        return box;
      },
    });
    new PanelControl({ position: "topright" }).addTo(this.map);
  }

  private setCollapsed(collapsed: boolean): void {
    this.collapsed = collapsed;
    this.body.hidden = collapsed;
    this.header.setAttribute("aria-expanded", String(!collapsed));
    this.header.replaceChildren(
      Object.assign(document.createElement("span"), { textContent: "Planes reguladores (PRC)" }),
      Object.assign(document.createElement("span"), { className: "chevron", textContent: collapsed ? "▸" : "▾" }),
    );
  }

  /** «Ir»: encuadra la comuna y activa su zonificación (sus demás capas quedan listadas sin descargar). */
  private goTo(instrument: InstrumentoMapa): void {
    if (instrument.extension) this.map.fitBounds(boundsOf(instrument.extension), { maxZoom: 15 });
    this.openRegions.add(instrument.region ?? "Sin región");
    this.openCommunes.add(instrument.carpeta);
    void this.activate(instrument, true);
  }

  private matches(instrument: InstrumentoMapa): boolean {
    if (!this.query) return true;
    const names = [instrument.region ?? "Sin región", instrument.nombre, ...(this.layers.get(instrument.carpeta) ?? []).map((l) => l.name)];
    return names.some((n) => plain(n).includes(this.query));
  }

  private groups(): [string, InstrumentoMapa[]][] {
    const byRegion = new Map<string, InstrumentoMapa[]>();
    for (const instrument of this.instruments.filter((i) => this.matches(i))) {
      const region = instrument.region ?? "Sin región";
      byRegion.set(region, [...(byRegion.get(region) ?? []), instrument]);
    }
    const rank = (region: string) => (REGION_ORDER.indexOf(region) < 0 ? REGION_ORDER.length : REGION_ORDER.indexOf(region));
    return [...byRegion.entries()]
      .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b, "es"))
      .map(([region, list]): [string, InstrumentoMapa[]] => [region, [...list].sort((a, b) => Number(b.tipo === "intercomunal") - Number(a.tipo === "intercomunal") || a.nombre.localeCompare(b.nombre, "es"))]);
  }

  private isShown(item: PanelLayer): boolean {
    return !!item.layer && this.map.hasLayer(item.layer);
  }

  private render(): void {
    if (this.pending++ > 0) return;
    queueMicrotask(() => {
      this.pending = 0;
      this.renderNow();
    });
  }

  private renderNow(): void {
    const groups = this.groups();
    this.list.replaceChildren();
    if (groups.length === 0) {
      this.list.append(Object.assign(document.createElement("div"), { className: "prc-empty", textContent: this.instruments.length ? "Sin resultados." : "Cargando instrumentos…" }));
      return;
    }
    for (const [region, instruments] of groups) {
      const details = this.group("prc-region", region, `${instruments.length} ${instruments.length === 1 ? "comuna" : "comunas"}`, this.openRegions, region, null);
      for (const instrument of instruments) details.append(this.communeNode(instrument));
      this.list.append(details);
    }
  }

  private communeNode(instrument: InstrumentoMapa): HTMLElement {
    const items = this.layers.get(instrument.carpeta) ?? [];
    const label = instrument.tipo === "intercomunal" ? `${instrument.nombre} (plan intercomunal)` : instrument.nombre;
    const shown = items.filter((i) => this.isShown(i)).length;
    const node = this.group("prc-commune", label, items.length === 0 ? "sin cargar" : `${shown}/${items.length}`, this.openCommunes, instrument.carpeta, instrument);
    node.addEventListener("toggle", () => {
      // Al desplegar una comuna se listan sus capas (metadatos); la geometría solo al marcar cada capa.
      if (node.open && items.length === 0) void this.activate(instrument, false);
    });
    for (const item of items) {
      const row = document.createElement("label");
      row.className = "prc-layer";
      const box = Object.assign(document.createElement("input"), { type: "checkbox", checked: this.isShown(item), disabled: item.loading });
      box.addEventListener("change", () => void this.show(instrument, item, box.checked));
      row.append(box, Object.assign(document.createElement("span"), { textContent: item.loading ? `${item.name} (descargando…)` : item.name }));
      node.append(row);
    }
    if (items.length === 0) node.append(Object.assign(document.createElement("div"), { className: "prc-empty", textContent: "Despliegue la comuna o pulse «Ir» para listar sus capas." }));
    return node;
  }

  private group(css: string, name: string, info: string, open: Set<string>, key: string, instrument: InstrumentoMapa | null): HTMLDetailsElement {
    const details = document.createElement("details");
    details.className = css;
    details.open = this.query !== "" || open.has(key);
    details.addEventListener("toggle", () => {
      if (details.open) open.add(key);
      else if (this.query === "") open.delete(key);
    });
    const summary = document.createElement("summary");
    if (instrument) {
      const items = this.layers.get(instrument.carpeta) ?? [];
      const all = Object.assign(document.createElement("input"), { type: "checkbox" });
      const shown = items.filter((i) => this.isShown(i)).length;
      all.checked = items.length > 0 && shown === items.length;
      all.indeterminate = shown > 0 && shown < items.length;
      all.addEventListener("click", (e) => e.stopPropagation());
      all.addEventListener("change", () => {
        if (items.length === 0) void this.activate(instrument, true);
        else for (const item of items) void this.show(instrument, item, all.checked);
      });
      summary.append(all);
    }
    summary.append(Object.assign(document.createElement("span"), { className: "prc-name", textContent: name }), Object.assign(document.createElement("span"), { className: "prc-info", textContent: info }));
    if (instrument?.extension) {
      const go = Object.assign(document.createElement("button"), { type: "button", textContent: "Ir", title: `Ir a ${instrument.nombre} y mostrar su zonificación` });
      go.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.goTo(instrument);
      });
      summary.append(go);
    }
    details.append(summary);
    return details;
  }
}
