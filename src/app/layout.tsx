import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Norma+BIM",
  description: "Revisión de modelos IFC contra la normativa urbana y de edificación chilena (LGUC, OGUC, PRC).",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#1f2226" };

// Render dinámico en toda la app: la CSP con nonce (src/proxy.ts) exige que Next.js firme sus scripts en cada petición;
// una página prerrenderizada estática no puede llevar el nonce.
export const dynamic = "force-dynamic";

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
