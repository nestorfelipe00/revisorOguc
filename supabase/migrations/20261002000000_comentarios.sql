-- Comentarios de los usuarios para mejorar la experiencia (banner «Comentarios» del panel IFC).
-- Cada usuario con sesión puede dejar comentarios y ver solo los suyos; nadie los edita ni borra por la API.
-- El contexto (pestaña, navegador, versión) ayuda a reproducir lo que el usuario cuenta.

create table public.comentarios (
  id uuid primary key default gen_random_uuid(),
  usuario uuid not null default auth.uid() references auth.users(id) on delete cascade,
  tipo text not null check (tipo in ('idea', 'problema', 'pregunta', 'otro')),
  mensaje text not null check (char_length(mensaje) between 3 and 2000),
  pagina text check (pagina is null or char_length(pagina) <= 80),
  proyecto_id uuid references public.proyectos(id) on delete set null,
  contexto jsonb not null default '{}'::jsonb check (pg_column_size(contexto) < 4096),
  creado_en timestamptz not null default now()
);
comment on table public.comentarios is 'Comentarios de usuarios (ideas, problemas, preguntas) enviados desde la aplicación web.';
create index comentarios_usuario_idx on public.comentarios (usuario);
create index comentarios_creado_idx on public.comentarios (creado_en desc);

alter table public.comentarios enable row level security;

create policy comentarios_insertar on public.comentarios
  for insert to authenticated with check (usuario = (select auth.uid()));

create policy comentarios_propios on public.comentarios
  for select to authenticated using (usuario = (select auth.uid()));

revoke all on table public.comentarios from anon;
grant select, insert on table public.comentarios to authenticated;
