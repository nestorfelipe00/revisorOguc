import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

/** Retorno de OAuth (Google): canjea el código PKCE por una sesión y vuelve a la página pedida (solo rutas internas). */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const volver = searchParams.get("volver") ?? "/";
  const destino = volver.startsWith("/") && !volver.startsWith("//") ? volver : "/";

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(new URL(destino, request.url));
  }
  return NextResponse.redirect(new URL("/ingresar?error=oauth", request.url));
}
