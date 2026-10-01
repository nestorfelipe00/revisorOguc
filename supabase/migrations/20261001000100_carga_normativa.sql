-- Carga de la normativa (data/gis, data/territorio, data/normas) sin exponer la clave service_role:
-- scripts/cargar-normativa.ts llama a estas funciones con la clave pública más un token de carga de un solo uso,
-- cuyo hash se inserta a mano en carga_tokens y se borra al terminar (cargar_fin).

create table public.carga_tokens (
  token_hash text primary key,
  creado_en timestamptz not null default now(),
  expira timestamptz not null default now() + interval '6 hours'
);
alter table public.carga_tokens enable row level security;   -- sin políticas: nadie la lee por la API

create or replace function public.carga_autorizada(token text)
returns boolean language sql stable security definer set search_path = public, extensions as $$
  select exists (select 1 from public.carga_tokens t where t.token_hash = encode(digest(token, 'sha256'), 'hex') and t.expira > now());
$$;
revoke execute on function public.carga_autorizada(text) from public, anon, authenticated;

create or replace function public.cargar_comunas(token text, features jsonb)
returns integer language plpgsql security definer set search_path = public, extensions as $$
declare n integer;
begin
  if not public.carga_autorizada(token) then raise exception 'Token de carga inválido'; end if;
  insert into public.comunas (cut, nombre, region, geom)
  select f -> 'properties' ->> 'cut', f -> 'properties' ->> 'comuna', f -> 'properties' ->> 'region',
         st_multi(st_makevalid(st_setsrid(st_geomfromgeojson(f -> 'geometry'), 4326)))
  from jsonb_array_elements(features) f
  where f -> 'properties' ->> 'cut' is not null
  on conflict (cut) do update set nombre = excluded.nombre, region = excluded.region, geom = excluded.geom;
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.cargar_instrumento(token text, carpeta_prc text, manifest jsonb)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare ext jsonb := manifest -> 'extension';
begin
  if not public.carga_autorizada(token) then raise exception 'Token de carga inválido'; end if;
  insert into public.instrumentos (carpeta, nombre, cut, region, tipo, instrumento, fuente, caracter, ordenanza_url, fichas_url, descargado, extension, manifest)
  values (
    carpeta_prc,
    coalesce(manifest ->> 'comuna', carpeta_prc),
    case when manifest ->> 'cut' ~ '^[0-9]{5}$' and exists (select 1 from public.comunas c where c.cut = manifest ->> 'cut') then manifest ->> 'cut' end,
    manifest ->> 'region',
    case when manifest ->> 'tipo' = 'intercomunal' then 'intercomunal' else 'comunal' end,
    manifest ->> 'instrumento',
    manifest ->> 'fuente',
    manifest ->> 'caracter',
    manifest ->> 'ordenanza_local',
    manifest ->> 'fichas_url',
    nullif(manifest ->> 'descargado', '')::timestamptz,
    case when jsonb_typeof(ext) = 'array' and jsonb_array_length(ext) = 4
         then st_makeenvelope((ext ->> 0)::double precision, (ext ->> 1)::double precision, (ext ->> 2)::double precision, (ext ->> 3)::double precision, 4326) end,
    manifest - 'capas')
  on conflict (carpeta) do update set
    nombre = excluded.nombre, cut = excluded.cut, region = excluded.region, tipo = excluded.tipo, instrumento = excluded.instrumento,
    fuente = excluded.fuente, caracter = excluded.caracter, ordenanza_url = excluded.ordenanza_url, fichas_url = excluded.fichas_url,
    descargado = excluded.descargado, extension = excluded.extension, manifest = excluded.manifest;
  -- La comuna apunta a su instrumento comunal.
  if manifest ->> 'tipo' is distinct from 'intercomunal' and manifest ->> 'cut' ~ '^[0-9]{5}$' then
    update public.comunas set carpeta = carpeta_prc, instrumento = manifest ->> 'instrumento', tipo = 'comunal',
      fuente = manifest ->> 'fuente', ordenanza_url = manifest ->> 'ordenanza_local',
      descargado = nullif(manifest ->> 'descargado', '')::date
    where cut = manifest ->> 'cut';
  end if;
  -- Se vacían las capas anteriores de esta carpeta: la carga es completa, no incremental.
  delete from public.capas_prc where carpeta = carpeta_prc;
  delete from public.normas_zonas where carpeta = carpeta_prc;
  delete from public.normas_documentos where carpeta = carpeta_prc;
  return carpeta_prc;
end $$;

create or replace function public.cargar_capa_meta(token text, carpeta_prc text, archivo text, nombre text, rol text, origen text, elementos integer)
returns bigint language plpgsql security definer set search_path = public, extensions as $$
declare capa bigint;
begin
  if not public.carga_autorizada(token) then raise exception 'Token de carga inválido'; end if;
  insert into public.capas_prc (carpeta, archivo, nombre, rol, origen, elementos)
  values (carpeta_prc, archivo, nombre, rol, origen, elementos)
  on conflict (carpeta, archivo) do update set nombre = excluded.nombre, rol = excluded.rol, origen = excluded.origen, elementos = excluded.elementos
  returning id into capa;
  return capa;
end $$;

drop function if exists public.cargar_capa(bigint, jsonb);
drop function if exists public.cargar_comunas(jsonb);

create or replace function public.cargar_capa(token text, capa bigint, features jsonb)
returns integer language plpgsql security definer set search_path = public, extensions as $$
declare n integer;
begin
  if not public.carga_autorizada(token) then raise exception 'Token de carga inválido'; end if;
  insert into public.zonas_prc (capa_id, codigo, nombre, ficha_url, atributos, geom)
  select capa,
         f -> 'properties' ->> '__codigo',
         f -> 'properties' ->> '__nombre',
         f -> 'properties' ->> '__ficha',
         (f -> 'properties') - '__codigo' - '__nombre' - '__ficha',
         st_makevalid(st_setsrid(st_geomfromgeojson(f -> 'geometry'), 4326))
  from jsonb_array_elements(features) f
  where f -> 'geometry' is not null and jsonb_typeof(f -> 'geometry') = 'object';
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.cargar_normas(token text, carpeta_prc text, clave text, contenido jsonb, version text)
returns integer language plpgsql security definer set search_path = public, extensions as $$
declare n integer := 0;
begin
  if not public.carga_autorizada(token) then raise exception 'Token de carga inválido'; end if;
  insert into public.normas_documentos (carpeta, clave, contenido, version) values (carpeta_prc, clave, contenido, version)
  on conflict (carpeta, clave) do update set contenido = excluded.contenido, version = excluded.version;
  if clave = 'normas_zonas' and jsonb_typeof(contenido -> 'zonas') = 'array' then
    insert into public.normas_zonas (carpeta, zona, ficha)
    select carpeta_prc, z ->> 'zona', z from jsonb_array_elements(contenido -> 'zonas') z where z ->> 'zona' is not null
    on conflict (carpeta, zona) do update set ficha = excluded.ficha;
    get diagnostics n = row_count;
  end if;
  return n;
end $$;

create or replace function public.cargar_oguc(token text, clave text, contenido jsonb, version text)
returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  if not public.carga_autorizada(token) then raise exception 'Token de carga inválido'; end if;
  insert into public.normas_oguc (clave, contenido, version) values (clave, contenido, version)
  on conflict (clave) do update set contenido = excluded.contenido, version = excluded.version;
end $$;

create or replace function public.cargar_fin(token text)
returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  delete from public.carga_tokens where token_hash = encode(digest(token, 'sha256'), 'hex') or expira <= now();
end $$;

grant execute on function public.cargar_comunas(text, jsonb) to anon, service_role;
grant execute on function public.cargar_instrumento(text, text, jsonb) to anon, service_role;
grant execute on function public.cargar_capa_meta(text, text, text, text, text, text, integer) to anon, service_role;
grant execute on function public.cargar_capa(text, bigint, jsonb) to anon, service_role;
grant execute on function public.cargar_normas(text, text, text, jsonb, text) to anon, service_role;
grant execute on function public.cargar_oguc(text, text, jsonb, text) to anon, service_role;
grant execute on function public.cargar_fin(text) to anon, service_role;
