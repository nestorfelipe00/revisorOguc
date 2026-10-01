import type { NextConfig } from "next";

const supabaseHost = (() => {
  try {
    return new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://localhost").host;
  } catch {
    return "localhost";
  }
})();

// Política de seguridad de contenido: solo esta app, Supabase, las teselas del mapa y el wasm de web-ifc.
const csp = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'" + (process.env.NODE_ENV === "development" ? " 'unsafe-eval' 'unsafe-inline'" : ""),
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://tile.openstreetmap.org https://*.tile.openstreetmap.org https://server.arcgisonline.com",
  `connect-src 'self' https://${supabaseHost} wss://${supabaseHost} blob: data:`,
  "worker-src 'self' blob:",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const nextConfig: NextConfig = {
  turbopack: {
    resolveAlias: {
      // three/examples/jsm/loaders/TTFLoader.js importa opentype.js desde jsDelivr; se sirve la copia local.
      "https://cdn.jsdelivr.net/npm/opentype.js@1.3.4/+esm": "opentype.js",
    },
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains; preload" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(self), payment=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
