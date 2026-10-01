import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "BIM Normative Checker",
  description: "Revisión de modelos IFC contra la normativa urbana y de edificación chilena (LGUC, OGUC, PRC).",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#1f2226" };

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
