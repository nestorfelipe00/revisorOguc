import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

/** Cliente de Supabase para componentes y rutas de servidor, con la sesión del usuario en cookies. */
export async function createClient() {
  const cookieStore = await cookies();
  return createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) cookieStore.set(name, value, options);
        } catch {
          // Desde un componente de servidor no se pueden escribir cookies; el proxy las refresca.
        }
      },
    },
  });
}
