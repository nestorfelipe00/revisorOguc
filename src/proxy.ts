import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

const PUBLIC_PATHS = ["/ingresar", "/auth/", "/_next/", "/wasm/", "/fragments-worker.mjs", "/favicon.ico"];

/** Refresca la sesión de Supabase en cada petición y exige sesión fuera de las rutas públicas. */
export default async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });
  const supabase = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) response.cookies.set(name, value, options);
      },
    },
  });

  // getUser valida el JWT contra Supabase (getSession solo lo decodifica).
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;
  const isPublic = PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p));
  if (!user && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = "/ingresar";
    url.searchParams.set("volver", pathname);
    return NextResponse.redirect(url);
  }
  if (user && pathname === "/ingresar") {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    url.search = "";
    return NextResponse.redirect(url);
  }
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|wasm|mjs)$).*)"],
};
