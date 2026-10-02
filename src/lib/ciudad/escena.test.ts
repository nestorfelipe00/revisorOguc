// Escena de ciudad desde las teselas reales de la porción de La Serena (public/_ciudad), sin navegador ni Supabase.
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { siteLocation } from "@/lib/territorio/colocacion";
import { alturaTerreno, calleMasCercana, escenaCiudad } from "./escena";
import { CIUDAD_URL } from "./teselas";

const root = path.resolve(__dirname, "../../../public/_ciudad");
const disponible = existsSync(path.join(root, "la-serena", "index.json"));
// Centro del predio FICTICIO del proyecto hipotético (La Serena, zona ZU-1A).
const centro = { latitude: -29.90138, longitude: -71.24856 };

const originalFetch = globalThis.fetch;

beforeAll(() => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (!url.startsWith(CIUDAD_URL)) return new Response(null, { status: 404 });
    const file = path.join(root, url.slice(CIUDAD_URL.length + 1));
    if (!existsSync(file)) return new Response(null, { status: 404 });
    return new Response(await readFile(file), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

describe.skipIf(!disponible)("Ciudad 3D desde teselas (porción de La Serena)", () => {
  it("arma la escena alrededor del predio con terreno, edificios y calles", async () => {
    const location = siteLocation(centro);
    const scene = await escenaCiudad({ location, extent: null, parcel: null, zonas: [], alturasDocumento: null });
    expect(scene.terrain.z).toHaveLength(scene.terrain.columns * scene.terrain.rows);
    expect(scene.terrain.columns).toBeGreaterThan(100);
    // Sin cota en el marco: Z = 0 del modelo es el terreno en el centro → el terreno queda cerca de 0 en el centro.
    const centerIndex = Math.floor(scene.terrain.rows / 2) * scene.terrain.columns + Math.floor(scene.terrain.columns / 2);
    expect(Math.abs(scene.terrain.z[centerIndex])).toBeLessThan(3);
    expect(scene.buildings.length).toBeGreaterThan(100);
    expect(scene.roads.length).toBeGreaterThan(20);
    expect(scene.trees.length % 3).toBe(0);
    expect(scene.notes.some((n) => n.startsWith("Supuesto: Z = 0"))).toBe(true);
    expect(scene.modelToWorld).toHaveLength(8);
    // Todo lo dibujado está dentro del área de 300 m (más el margen gráfico de las vías).
    for (const b of scene.buildings) for (let k = 0; k < b.rings[0].length; k += 2) expect(Math.abs(b.rings[0][k])).toBeLessThan(400);
    expect(new Set(scene.buildings.map((b) => b.heightSource)).size).toBeGreaterThan(0);
  });

  it("estima la cota del terreno y la calle más cercana", async () => {
    const h = await alturaTerreno(centro);
    expect(h).not.toBeNull();
    expect(h!).toBeGreaterThan(5);
    expect(h!).toBeLessThan(120);
    const street = await calleMasCercana(centro);
    expect(street).not.toBeNull();
    expect(street!.distance).toBeLessThan(60);
    expect(Math.hypot(street!.directionX, street!.directionY)).toBeCloseTo(1, 6);
  });

  it("fuera de la porción generada avisa en vez de fallar", async () => {
    await expect(escenaCiudad({ location: siteLocation({ latitude: -33.45, longitude: -70.65 }), extent: null, parcel: null, zonas: [], alturasDocumento: null })).rejects.toThrow(/porción de ciudad/);
    expect(await alturaTerreno({ latitude: -33.45, longitude: -70.65 })).toBeNull();
  });
});
