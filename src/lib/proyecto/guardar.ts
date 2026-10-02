// Proyecto en Supabase (tablas proyectos, modelos, predios, revisiones con RLS por propietario). El IFC no se sube:
// se guardan su nombre, tamaño y SHA-256 para reconocerlo al volver a abrirlo. Porte de lo que el .bnc guarda en el escritorio.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { GeoPoint } from "@/lib/territorio/utm";
import type { UserPlacement } from "@/lib/territorio/colocacion";
import type { CabidaEvaluation, Parcel, RuleEvaluation, RuleResult } from "@/lib/reglas/tipos";
import type { AjustesCabida } from "@/lib/reglas/cabidaPreliminar";

export interface ModeloGuardado {
  nombre_archivo: string;
  disciplina: string;
  condicion: "Proyectado" | "Existente";
  sha256: string;
  bytes: number;
  esquema: string | null;
  elementos: number | null;
}

/** Campos libres del proyecto (jsonb `campos`): georreferencia del usuario, ubicación manual y supuestos del estudio. */
export interface CamposProyecto {
  georef?: UserPlacement | null;
  ubicacion_manual?: GeoPoint | null;
  piso_a_piso?: string;
  /** Entradas de la pestaña Cabida (cifras del CIP y supuestos), tal como se escribieron. */
  cabida?: AjustesCabida;
}

export interface ProyectoGuardado {
  id: string;
  nombre: string;
  tramite: string | null;
  campos: CamposProyecto;
  ubicacion: GeoPoint | null;
  ubicacion_fuente: string | null;
  modelos: ModeloGuardado[];
  predio: Parcel | null;
  revision: RevisionGuardada | null;
}

export interface RevisionGuardada {
  tipo: "revision" | "cabida";
  comuna: string | null;
  zona: string | null;
  resultados: RuleResult[];
  creado_en: string;
}

export const VERSION_REGLAS = "web-w2";

const ewktPoint = (p: GeoPoint) => `SRID=4326;POINT(${p.longitude} ${p.latitude})`;

function ewktPolygon(vertices: GeoPoint[]): string {
  const ring = [...vertices, vertices[0]].map((v) => `${v.longitude} ${v.latitude}`).join(", ");
  return `SRID=4326;POLYGON((${ring}))`;
}

export interface DatosAGuardar {
  id: string | null;
  nombre: string;
  tramite: string | null;
  campos: CamposProyecto;
  ubicacion: GeoPoint | null;
  ubicacion_fuente: string | null;
  modelos: ModeloGuardado[];
  predio: Parcel | null;
  revision: { tipo: "revision" | "cabida"; comuna: string | null; zona: string | null; versionNormas: string; evaluation: RuleEvaluation | CabidaEvaluation } | null;
}

/** Crea o actualiza el proyecto completo. Devuelve el id. */
export async function guardarProyecto(supabase: SupabaseClient, datos: DatosAGuardar): Promise<string> {
  const { data: userData } = await supabase.auth.getUser();
  const propietario = userData.user?.id;
  if (!propietario) throw new Error("Inicie sesión para guardar el proyecto.");

  const fila = {
    propietario,
    nombre: datos.nombre.trim(),
    tramite: datos.tramite,
    campos: datos.campos,
    ubicacion: datos.ubicacion ? ewktPoint(datos.ubicacion) : null,
    ubicacion_fuente: datos.ubicacion_fuente,
  };
  let id = datos.id;
  if (id) {
    const { error } = await supabase.from("proyectos").update(fila).eq("id", id);
    if (error) throw new Error(`No se pudo guardar el proyecto: ${error.message}`);
  } else {
    const { data, error } = await supabase.from("proyectos").insert(fila).select("id").single();
    if (error || !data) throw new Error(`No se pudo crear el proyecto: ${error?.message ?? "sin respuesta"}`);
    id = data.id as string;
  }

  const borrado = await supabase.from("modelos").delete().eq("proyecto_id", id);
  if (borrado.error) throw new Error(`No se pudieron actualizar los modelos: ${borrado.error.message}`);
  if (datos.modelos.length > 0) {
    const { error } = await supabase.from("modelos").insert(datos.modelos.map((m) => ({ ...m, proyecto_id: id })));
    if (error) throw new Error(`No se pudieron guardar los modelos: ${error.message}`);
  }

  if (datos.predio) {
    const p = datos.predio;
    const { error } = await supabase.from("predios").upsert({
      proyecto_id: id,
      poligono: ewktPolygon(p.vertices),
      deslindes: p.edges,
      suelo_natural_z: p.naturalGroundZ,
      fuente: p.source,
      cota_confirmada: p.groundConfirmed,
      posicion_confirmada: p.positionConfirmed,
    });
    if (error) throw new Error(`No se pudo guardar el predio: ${error.message}`);
  } else {
    const { error } = await supabase.from("predios").delete().eq("proyecto_id", id);
    if (error) throw new Error(`No se pudo quitar el predio: ${error.message}`);
  }

  if (datos.revision) {
    const r = datos.revision;
    const volumen = r.evaluation.volume
      ? { x0: r.evaluation.volume.x0, y0: r.evaluation.volume.y0, step: r.evaluation.volume.step, columns: r.evaluation.volume.columns, rows: r.evaluation.volume.rows, groundZ: r.evaluation.volume.groundZ, volumeM3: r.evaluation.volume.volumeM3, buildableArea: r.evaluation.volume.buildableArea }
      : null;
    const { error } = await supabase.from("revisiones").insert({
      proyecto_id: id,
      tipo: r.tipo,
      comuna: r.comuna,
      zona: r.zona,
      version_reglas: VERSION_REGLAS,
      version_normas: r.versionNormas,
      resultados: r.evaluation.results,
      volumen,
    });
    if (error) throw new Error(`No se pudo guardar la revisión: ${error.message}`);
  }
  return id;
}

interface FilaProyecto {
  id: string;
  nombre: string;
  tramite: string | null;
  campos: CamposProyecto | null;
  ubicacion_fuente: string | null;
  ubicacion_geojson: { coordinates: [number, number] } | null;
}

interface FilaPredio {
  poligono_geojson: { coordinates: number[][][] } | null;
  deslindes: Parcel["edges"];
  suelo_natural_z: number;
  fuente: string;
  cota_confirmada: boolean;
  posicion_confirmada: boolean;
}

/** Abre un proyecto guardado (el usuario vuelve a abrir sus IFC desde el disco). */
export async function cargarProyecto(supabase: SupabaseClient, id: string): Promise<ProyectoGuardado> {
  const { data: proyecto, error } = await supabase
    .from("proyectos")
    .select("id, nombre, tramite, campos, ubicacion_fuente, ubicacion_geojson:ubicacion")
    .eq("id", id)
    .single<FilaProyecto>();
  if (error || !proyecto) throw new Error(`No se pudo abrir el proyecto: ${error?.message ?? "no existe"}`);

  const [modelos, predio, revision] = await Promise.all([
    supabase.from("modelos").select("nombre_archivo, disciplina, condicion, sha256, bytes, esquema, elementos").eq("proyecto_id", id),
    supabase.from("predios").select("poligono_geojson:poligono, deslindes, suelo_natural_z, fuente, cota_confirmada, posicion_confirmada").eq("proyecto_id", id).maybeSingle<FilaPredio>(),
    supabase.from("revisiones").select("tipo, comuna, zona, resultados, creado_en").eq("proyecto_id", id).order("creado_en", { ascending: false }).limit(1).maybeSingle(),
  ]);

  let parcel: Parcel | null = null;
  const ring = predio.data?.poligono_geojson?.coordinates?.[0];
  if (predio.data && ring && ring.length >= 4) {
    const vertices = ring.slice(0, -1).map(([lon, lat]) => ({ latitude: lat, longitude: lon }));
    parcel = {
      vertices,
      edges: predio.data.deslindes,
      naturalGroundZ: predio.data.suelo_natural_z,
      source: predio.data.fuente,
      groundConfirmed: predio.data.cota_confirmada,
      positionConfirmed: predio.data.posicion_confirmada,
    };
  }
  const ubicacion = proyecto.ubicacion_geojson?.coordinates
    ? { latitude: proyecto.ubicacion_geojson.coordinates[1], longitude: proyecto.ubicacion_geojson.coordinates[0] }
    : null;
  return {
    id: proyecto.id,
    nombre: proyecto.nombre,
    tramite: proyecto.tramite,
    campos: proyecto.campos ?? {},
    ubicacion,
    ubicacion_fuente: proyecto.ubicacion_fuente,
    modelos: (modelos.data ?? []) as ModeloGuardado[],
    predio: parcel,
    revision: revision.data ? (revision.data as RevisionGuardada) : null,
  };
}
