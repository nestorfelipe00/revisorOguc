-- Cierre de la carga de normativa y correcciones del linter de seguridad de Supabase (get_advisors):
-- las funciones de carga quedan solo para service_role, el token se elimina, el tiempo máximo de consulta del rol anónimo
-- vuelve a 3 s y las funciones internas de PostGIS no se exponen por la API.

revoke execute on function public.cargar_comunas(text, jsonb) from public, anon, authenticated;
revoke execute on function public.cargar_instrumento(text, text, jsonb) from public, anon, authenticated;
revoke execute on function public.cargar_capa_meta(text, text, text, text, text, text, integer) from public, anon, authenticated;
revoke execute on function public.cargar_capa(text, bigint, jsonb) from public, anon, authenticated;
revoke execute on function public.cargar_normas(text, text, text, jsonb, text) from public, anon, authenticated;
revoke execute on function public.cargar_oguc(text, text, jsonb, text) from public, anon, authenticated;
revoke execute on function public.cargar_fin(text) from public, anon, authenticated;
revoke execute on function public.crear_perfil() from public, anon, authenticated;
delete from public.carga_tokens;

alter role anon set statement_timeout = '3s';
notify pgrst, 'reload config';

create or replace function public.tocar_actualizado_en()
returns trigger language plpgsql set search_path = public as $$
begin
  new.actualizado_en = now();
  return new;
end $$;

-- PostGIS vive en public (se creó antes de mover extensiones): sus funciones SECURITY DEFINER y la tabla de sistemas de
-- referencia no se exponen por la API.
revoke execute on function public.st_estimatedextent(text, text) from public, anon, authenticated;
revoke execute on function public.st_estimatedextent(text, text, text) from public, anon, authenticated;
revoke execute on function public.st_estimatedextent(text, text, text, boolean) from public, anon, authenticated;
revoke all on table public.spatial_ref_sys from anon, authenticated;

-- Las consultas de normativa solo las hacen usuarios con sesión.
revoke execute on function public.comuna_en_punto(double precision, double precision) from public, anon;
revoke execute on function public.instrumentos_en_punto(double precision, double precision) from public, anon;
revoke execute on function public.zonas_en_predio(text, text) from public, anon;
revoke execute on function public.vialidad_cercana(text, text) from public, anon;
revoke execute on function public.capa_geojson(bigint) from public, anon;
