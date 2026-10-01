# BIM Normative Checker — versión web

Revisión de modelos IFC contra la normativa urbana y de edificación chilena (LGUC, OGUC, PRC), en el navegador. Es la versión web de la aplicación de escritorio `REVISOR OGUC`; comparte el visor That Open y el plan `docs/PLAN_WEB.md` de ese repositorio.

**Arquitectura:** todo el cálculo IFC ocurre en el navegador (web-ifc + That Open); Next.js en Vercel sirve la interfaz; Supabase guarda usuarios, proyectos y la normativa en PostGIS con RLS. IfcOpenShell y .NET no van a la nube. El IFC no sale del equipo del usuario salvo que guarde el proyecto.

> Estado: **MVP-W1** (ver y ubicar). Ingreso con enlace por correo o contraseña, visor 3D con herramientas (pisos, cortes, mediciones), panel de elemento con propiedades y cantidades, territorio: comuna y región (DPA SUBDERE, 345 comunas), zona del PRC con su ficha, áreas especiales, fajas viales a menos de 30 m y notas, para los 45 PRC y el PRMS cargados. Advertencias de la versión web: no escribe copias IFC georreferenciadas y rechaza modelos de más de 300 MB.

## Desarrollo

Requisitos: Node.js 20+ y un proyecto Supabase.

```bash
npm install
cp .env.example .env.local   # URL y clave pública del proyecto Supabase
npm run dev
```

- `npm run build` compila para producción; `npm run typecheck` y `npm test` (Vitest) validan el código.
- `supabase/migrations/` tiene el esquema (tablas, RLS, RPC, buckets). Se aplica con el MCP de Supabase o con `supabase db push`.
- `npm run cargar-normativa` carga `data/territorio`, `data/gis` y `data/normas` del repo de escritorio (variable `BNC_DATA_DIR`) usando un token de carga de un solo uso (`SUPABASE_CARGA_TOKEN`, ver `supabase/migrations/*_carga_normativa.sql`). Nunca usa la clave `service_role`.

## Estructura

```
src/app/            páginas (ingreso, inicio, visor) y rutas de auth
src/components/     Viewer.tsx: contenedor React del visor That Open
src/viewer/         visor copiado del escritorio (viewer/src) + web.ts (entrada web) + ifcMetaWorker.ts (georreferencia con web-ifc)
src/lib/supabase/   clientes de Supabase (navegador y servidor)
src/lib/territorio/ portes de Core/Territory (UTM, ubicación) y consulta a PostGIS
src/proxy.ts        sesión en cada petición y rutas protegidas
scripts/            carga de la normativa
supabase/           migraciones
public/wasm, public/fragments-worker.mjs   web-ifc y worker de fragments (copiados de node_modules)
```

## Seguridad

- Toda tabla tiene RLS; la normativa es de solo lectura para usuarios con sesión y solo se escribe por migración.
- La clave pública (`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`) es la única que llega al navegador.
- Cabeceras CSP, HSTS, `X-Frame-Options`, `nosniff` y `Permissions-Policy` en `next.config.ts`.
- Los IFC se validan por tamaño antes de leerse; los nombres del modelo se muestran siempre escapados por React.

Los datos del PRC son referenciales: lo oficial es la Ordenanza Local vigente. Esta revisión no reemplaza la del arquitecto revisor ni la de la DOM.
