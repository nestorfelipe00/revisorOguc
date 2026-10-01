import type { NextConfig } from "next";

// La Content-Security-Policy se emite con nonce por petición en src/proxy.ts; aquí van las cabeceras fijas.
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
