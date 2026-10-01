-- BIM Normative Checker Web — esquema inicial (ver docs/PLAN_WEB.md §4 del repo de escritorio).
-- Todo lo del usuario lleva RLS por propietario; la normativa es de solo lectura para usuarios.

create extension if not exists postgis;
create extension if not exists pgcrypto;

-- ---------- Datos del usuario ----------
create table public.perfiles (
  id uuid primary key references auth.users(id) on delete cascade,
  nombre text check (char_length(nombre) <= 120),
  creado_en timestamptz not null default now()
);

create or replace function public.crear_perfil()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.perfiles (id, nombre) values (new.id, new.raw_user_meta_data ->> 'nombre')
  on conflict (id) do nothing;
  return new;
end $$;

create trigger perfil_al_registrarse after insert on auth.users
  for each row execute function public.crear_perfil();

create table public.proyectos (
  id uuid primary key default gen_random_uuid(),
  propietario uuid not null references auth.users(id) on delete cascade,
  nombre text not null check (char_length(nombre) between 1 and 120),
  tramite text check (tramite is null or tramite ~ '^[0-9A-Za-z.-]{1,16}$'),
  campos jsonb not null default '{}'::jsonb check (pg_column_size(campos) < 65536),
  ubicacion geography(point, 4326),
  ubicacion_fuente text,
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now()
);
create index proyectos_propietario_idx on public.proyectos (propietario);

create table public.modelos (
  id uuid primary key default gen_random_uuid(),
  proyecto_id uuid not null references public.proyectos(id) on delete cascade,
  nombre_archivo text not null check (char_length(nombre_archivo) <= 255),
  disciplina text not null,
  condicion text not null check (condicion in ('Proyectado', 'Existente')),
  sha256 char(64) not null check (sha256 ~ '^[0-9a-f]{64}$'),
  bytes bigint not null check (bytes > 0 and bytes <= 314572800),
  esquema text,
  elementos integer,
  ruta_storage text,
  ruta_fragments text,
  creado_en timestamptz not null default now()
);
create index modelos_proyecto_idx on public.modelos (proyecto_id);

create table public.predios (
  proyecto_id uuid primary key references public.proyectos(id) on delete cascade,
  poligono geography(polygon, 4326) not null,
  deslindes jsonb not null,
  suelo_natural_z double precision not null,
  fuente text not null,
  cota_confirmada boolean not null default false,
  posicion_confirmada boolean not null default false,
  actualizado_en timestamptz not null default now(),
  constraint predio_valido check (st_isvalid(poligono::geometry) and st_npoints(poligono::geometry) <= 500)
);

create table public.revisiones (
  id uuid primary key default gen_random_uuid(),
  proyecto_id uuid not null references public.proyectos(id) on delete cascade,
  tipo text not null check (tipo in ('revision', 'cabida')),
  comuna text,
  zona text,
  version_reglas text not null,
  version_normas text not null,
  resultados jsonb not null check (pg_column_size(resultados) < 2097152),
  volumen jsonb,
  creado_en timestamptz not null default now()
);
create index revisiones_proyecto_idx on public.revisiones (proyecto_id, creado_en desc);

create or replace function public.tocar_actualizado_en()
returns trigger language plpgsql as $$
begin
  new.actualizado_en = now();
  return new;
end $$;
create trigger proyectos_actualizado before update on public.proyectos for each row execute function public.tocar_actualizado_en();
create trigger predios_actualizado before update on public.predios for each row execute function public.tocar_actualizado_en();

-- ---------- Normativa (solo lectura para usuarios) ----------
create table public.comunas (
  cut char(5) primary key,
  nombre text not null,
  region text not null,
  carpeta text unique,
  instrumento text,
  tipo text check (tipo in ('comunal', 'intercomunal')),
  fuente text,
  ordenanza_url text,
  descargado date,
  geom geometry(multipolygon, 4326) not null
);
create index comunas_geom_idx on public.comunas using gist (geom);

-- Instrumentos cargados (una fila por carpeta de data/gis, incluido el PRMS sin comuna propia).
create table public.instrumentos (
  carpeta text primary key,
  nombre text not null,
  cut char(5) references public.comunas(cut),
  region text,
  tipo text not null default 'comunal' check (tipo in ('comunal', 'intercomunal')),
  instrumento text,
  fuente text,
  caracter text,
  ordenanza_url text,
  fichas_url text,
  descargado timestamptz,
  extension geometry(polygon, 4326),
  manifest jsonb not null default '{}'::jsonb
);
create index instrumentos_extension_idx on public.instrumentos using gist (extension);

create table public.capas_prc (
  id bigserial primary key,
  carpeta text not null references public.instrumentos(carpeta) on delete cascade,
  archivo text not null,
  nombre text not null,
  rol text not null check (rol in ('zonas', 'subzonas', 'uso', 'anterior', 'especial', 'vialidad', 'referencia')),
  origen text,
  elementos integer,
  unique (carpeta, archivo)
);

create table public.zonas_prc (
  id bigserial primary key,
  capa_id bigint not null references public.capas_prc(id) on delete cascade,
  codigo text,
  nombre text,
  ficha_url text,
  atributos jsonb not null default '{}'::jsonb,
  geom geometry(geometry, 4326) not null
);
create index zonas_prc_geom_idx on public.zonas_prc using gist (geom);
create index zonas_prc_capa_idx on public.zonas_prc (capa_id);

create table public.normas_zonas (
  carpeta text not null references public.instrumentos(carpeta) on delete cascade,
  zona text not null,
  ficha jsonb not null,
  primary key (carpeta, zona)
);

create table public.normas_documentos (
  carpeta text not null references public.instrumentos(carpeta) on delete cascade,
  clave text not null,
  contenido jsonb not null,
  version text not null,
  primary key (carpeta, clave)
);

create table public.normas_oguc (
  clave text primary key,
  contenido jsonb not null,
  version text not null
);

-- ---------- RLS ----------
alter table public.perfiles          enable row level security;
alter table public.proyectos         enable row level security;
alter table public.modelos           enable row level security;
alter table public.predios           enable row level security;
alter table public.revisiones        enable row level security;
alter table public.comunas           enable row level security;
alter table public.instrumentos      enable row level security;
alter table public.capas_prc         enable row level security;
alter table public.zonas_prc         enable row level security;
alter table public.normas_zonas      enable row level security;
alter table public.normas_documentos enable row level security;
alter table public.normas_oguc       enable row level security;

create policy perfil_propio on public.perfiles
  for all to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));

create policy proyectos_propios on public.proyectos
  for all to authenticated using (propietario = (select auth.uid())) with check (propietario = (select auth.uid()));

create policy modelos_propios on public.modelos
  for all to authenticated
  using (exists (select 1 from public.proyectos p where p.id = proyecto_id and p.propietario = (select auth.uid())))
  with check (exists (select 1 from public.proyectos p where p.id = proyecto_id and p.propietario = (select auth.uid())));

create policy predios_propios on public.predios
  for all to authenticated
  using (exists (select 1 from public.proyectos p where p.id = proyecto_id and p.propietario = (select auth.uid())))
  with check (exists (select 1 from public.proyectos p where p.id = proyecto_id and p.propietario = (select auth.uid())));

create policy revisiones_propias on public.revisiones
  for all to authenticated
  using (exists (select 1 from public.proyectos p where p.id = proyecto_id and p.propietario = (select auth.uid())))
  with check (exists (select 1 from public.proyectos p where p.id = proyecto_id and p.propietario = (select auth.uid())));

create policy comunas_lectura      on public.comunas           for select to authenticated using (true);
create policy instrumentos_lectura on public.instrumentos      for select to authenticated using (true);
create policy capas_lectura        on public.capas_prc         for select to authenticated using (true);
create policy zonas_lectura        on public.zonas_prc         for select to authenticated using (true);
create policy normas_zonas_lectura on public.normas_zonas      for select to authenticated using (true);
create policy normas_docs_lectura  on public.normas_documentos for select to authenticated using (true);
create policy normas_oguc_lectura  on public.normas_oguc       for select to authenticated using (true);

-- ---------- RPC de consulta (security invoker: respetan RLS) ----------
create or replace function public.comuna_en_punto(lon double precision, lat double precision)
returns table (cut char(5), nombre text, region text, carpeta text)
language sql stable security invoker set search_path = public as $$
  select c.cut, c.nombre, c.region, c.carpeta
  from public.comunas c
  where lon between -110 and -66 and lat between -56 and -17
    and st_intersects(c.geom, st_setsrid(st_makepoint(lon, lat), 4326))
  limit 3;
$$;

-- Instrumentos (PRC o intercomunal) cuya extensión cubre el punto.
create or replace function public.instrumentos_en_punto(lon double precision, lat double precision)
returns setof public.instrumentos
language sql stable security invoker set search_path = public as $$
  select i.* from public.instrumentos i
  where i.extension is not null and st_intersects(i.extension, st_setsrid(st_makepoint(lon, lat), 4326))
  order by (i.tipo = 'comunal') desc;
$$;

-- Zonas, áreas especiales y fajas de un instrumento que intersectan el predio, con la parte dentro y su porcentaje.
create or replace function public.zonas_en_predio(carpeta_prc text, predio_geojson text)
returns table (capa_id bigint, rol text, nombre_capa text, codigo text, nombre text, ficha_url text, atributos jsonb,
               interseccion_geojson text, porcentaje double precision)
language plpgsql stable security invoker set search_path = public as $$
declare g geometry;
begin
  g := st_setsrid(st_geomfromgeojson(predio_geojson), 4326);
  if g is null or not st_isvalid(g) or st_npoints(g) > 500 or st_area(g::geography) > 1000000 then
    raise exception 'Predio inválido o mayor a 100 ha';
  end if;
  return query
    select z.capa_id, c.rol, c.nombre, z.codigo, z.nombre, z.ficha_url, z.atributos,
           st_asgeojson(st_intersection(z.geom, g)),
           case when st_dimension(z.geom) = 2
                then st_area(st_intersection(z.geom, g)::geography) / nullif(st_area(g::geography), 0) * 100
                else null end
    from public.zonas_prc z join public.capas_prc c on c.id = z.capa_id
    where c.carpeta = carpeta_prc
      and c.rol in ('zonas', 'subzonas', 'uso', 'anterior', 'especial', 'vialidad')
      and st_intersects(z.geom, g);
end $$;

-- Fajas viales (rol vialidad) a menos de 30 m del predio.
create or replace function public.vialidad_cercana(carpeta_prc text, predio_geojson text)
returns table (nombre_capa text, nombre text, atributos jsonb, distancia_m double precision)
language sql stable security invoker set search_path = public as $$
  select c.nombre, z.nombre, z.atributos,
         st_distance(z.geom::geography, st_setsrid(st_geomfromgeojson(predio_geojson), 4326)::geography)
  from public.zonas_prc z join public.capas_prc c on c.id = z.capa_id
  where c.carpeta = carpeta_prc and c.rol = 'vialidad'
    and st_dwithin(z.geom::geography, st_setsrid(st_geomfromgeojson(predio_geojson), 4326)::geography, 30);
$$;

-- Capa simplificada para el mapa (0,5 m), como FeatureCollection.
create or replace function public.capa_geojson(capa bigint)
returns jsonb
language sql stable security invoker set search_path = public as $$
  select jsonb_build_object(
    'type', 'FeatureCollection',
    'features', coalesce(jsonb_agg(jsonb_build_object(
      'type', 'Feature',
      'id', z.id,
      'properties', z.atributos || jsonb_build_object('codigo', z.codigo, 'nombre', z.nombre, 'ficha_url', z.ficha_url),
      'geometry', st_asgeojson(st_simplifypreservetopology(z.geom, 0.000005))::jsonb
    )), '[]'::jsonb))
  from public.zonas_prc z where z.capa_id = capa;
$$;

-- ---------- RPC de carga (solo service_role, desde scripts/cargar-normativa.ts) ----------
create or replace function public.cargar_comunas(features jsonb)
returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  insert into public.comunas (cut, nombre, region, geom)
  select f -> 'properties' ->> 'CUT_COM', f -> 'properties' ->> 'COMUNA', f -> 'properties' ->> 'REGION',
         st_multi(st_makevalid(st_setsrid(st_geomfromgeojson(f -> 'geometry'), 4326)))
  from jsonb_array_elements(features) f
  where f -> 'properties' ->> 'CUT_COM' is not null
  on conflict (cut) do update set nombre = excluded.nombre, region = excluded.region, geom = excluded.geom;
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.cargar_capa(capa bigint, features jsonb)
returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  insert into public.zonas_prc (capa_id, codigo, nombre, ficha_url, atributos, geom)
  select capa,
         f -> 'properties' ->> '__codigo',
         f -> 'properties' ->> '__nombre',
         f -> 'properties' ->> '__ficha',
         (f -> 'properties') - '__codigo' - '__nombre' - '__ficha',
         st_makevalid(st_setsrid(st_geomfromgeojson(f -> 'geometry'), 4326))
  from jsonb_array_elements(features) f
  where f -> 'geometry' is not null and f -> 'geometry' <> 'null'::jsonb;
  get diagnostics n = row_count;
  return n;
end $$;

revoke execute on function public.cargar_comunas(jsonb) from public, anon, authenticated;
revoke execute on function public.cargar_capa(bigint, jsonb) from public, anon, authenticated;
grant execute on function public.cargar_comunas(jsonb) to service_role;
grant execute on function public.cargar_capa(bigint, jsonb) to service_role;

-- ---------- Storage ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('ifc',       'ifc',       false, 314572800, array['application/x-step', 'application/octet-stream', 'model/ifc', 'application/ifc']),
  ('fragments', 'fragments', false, 104857600, array['application/octet-stream']);

create policy archivos_propios on storage.objects
  for all to authenticated
  using (bucket_id in ('ifc', 'fragments') and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id in ('ifc', 'fragments') and (storage.foldername(name))[1] = (select auth.uid())::text);
