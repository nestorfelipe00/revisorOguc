-- Teselas de la ciudad 3D (porciones precalculadas por tools/gis/teselas_ciudad.py): bucket público de solo lectura.
-- La aplicación las lee por URL pública (NEXT_PUBLIC_CIUDAD_URL); nadie escribe por la API (la carga se hace aparte).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('ciudad', 'ciudad', true, 5242880, array['application/json'])
on conflict (id) do update set public = true, file_size_limit = 5242880, allowed_mime_types = array['application/json'];

create policy ciudad_lectura on storage.objects
  for select to anon, authenticated using (bucket_id = 'ciudad');
