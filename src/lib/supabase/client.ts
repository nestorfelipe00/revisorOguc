import { createBrowserClient } from "@supabase/ssr";

/** Cliente de Supabase para componentes de cliente. Usa la clave pública: toda lectura y escritura pasa por RLS. */
export function createClient() {
  return createBrowserClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!);
}
