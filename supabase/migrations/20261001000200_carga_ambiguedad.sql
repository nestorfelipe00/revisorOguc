-- Los parámetros de las funciones de carga se llaman como las columnas (clave, archivo…): en ON CONFLICT plpgsql los
-- considera ambiguos. Se nombra la restricción en vez de las columnas y se resuelve a favor de la variable.

create or replace function public.cargar_capa_meta(token text, carpeta_prc text, archivo text, nombre text, rol text, origen text, elementos integer)
returns bigint language plpgsql security definer set search_path = public, extensions as $$
#variable_conflict use_variable
declare capa bigint;
begin
  if not public.carga_autorizada(token) then raise exception 'Token de carga inválido'; end if;
  insert into public.capas_prc as c (carpeta, archivo, nombre, rol, origen, elementos)
  values (carpeta_prc, archivo, nombre, rol, origen, elementos)
  on conflict on constraint capas_prc_carpeta_archivo_key do update set nombre = excluded.nombre, rol = excluded.rol, origen = excluded.origen, elementos = excluded.elementos
  returning c.id into capa;
  return capa;
end $$;

create or replace function public.cargar_normas(token text, carpeta_prc text, clave text, contenido jsonb, version text)
returns integer language plpgsql security definer set search_path = public, extensions as $$
#variable_conflict use_variable
declare n integer := 0;
begin
  if not public.carga_autorizada(token) then raise exception 'Token de carga inválido'; end if;
  insert into public.normas_documentos (carpeta, clave, contenido, version) values (carpeta_prc, clave, contenido, version)
  on conflict on constraint normas_documentos_pkey do update set contenido = excluded.contenido, version = excluded.version;
  if clave = 'normas_zonas' and jsonb_typeof(contenido -> 'zonas') = 'array' then
    insert into public.normas_zonas (carpeta, zona, ficha)
    select carpeta_prc, z ->> 'zona', z from jsonb_array_elements(contenido -> 'zonas') z where z ->> 'zona' is not null
    on conflict on constraint normas_zonas_pkey do update set ficha = excluded.ficha;
    get diagnostics n = row_count;
  end if;
  return n;
end $$;

create or replace function public.cargar_oguc(token text, clave text, contenido jsonb, version text)
returns void language plpgsql security definer set search_path = public, extensions as $$
#variable_conflict use_variable
begin
  if not public.carga_autorizada(token) then raise exception 'Token de carga inválido'; end if;
  insert into public.normas_oguc (clave, contenido, version) values (clave, contenido, version)
  on conflict on constraint normas_oguc_pkey do update set contenido = excluded.contenido, version = excluded.version;
end $$;
