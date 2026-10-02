import { NextResponse, type NextRequest } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";

/**
 * Destino de los enlaces por correo (confirmación de cuenta y cambio de contraseña): canjea el token o el código PKCE por una
 * sesión y vuelve a la página pedida (solo rutas internas).
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;
  const code = searchParams.get("code");
  const volver = searchParams.get("volver") ?? "/";
  const destino = volver.startsWith("/") && !volver.startsWith("//") ? volver : "/";

  if (tokenHash && type) {
    const supabase = await createClient();
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
    if (!error) return NextResponse.redirect(new URL(destino, request.url));
  } else if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(new URL(destino, request.url));
  }
  return NextResponse.redirect(new URL("/ingresar?error=enlace", request.url));
}
