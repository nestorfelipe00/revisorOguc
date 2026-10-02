// Porte de la parte de predio de UntrustedInputTests.cs (GeoJSON malformado, predio guardado inválido) y pruebas de la lectura
// de GeoJSON con deslindes declarados y de la transformación a coordenadas del modelo.
import { describe, expect, it } from "vitest";
import { placedFrame } from "@/lib/territorio/location";
import { fromGeographic } from "@/lib/territorio/utm";
import { InvalidDataError, importParcelGeoJson, parcelFromJson, parcelFromVertices, parcelToJson } from "./predio";
import { toModel } from "./transformacion";

describe("GeoJSON del predio (entrada de terceros)", () => {
  // H-01: ParcelImporter.Import lanzaba KeyNotFoundException / InvalidOperationException.
  it.each([
    ['{"features": []}'],
    ['[{"type": "Feature"}]'],
    ['{"type": 7}'],
    ['{"type": "MultiPolygon", "coordinates": []}'],
    ["esto no es json"],
    ['{"type": "Polygon", "coordinates": [[[0, 0], [1, 0], [1, 1]]]}'],
  ])("rechaza %s con un mensaje claro", (json) => {
    let error: unknown = null;
    try {
      importParcelGeoJson(json, "predio.geojson");
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(InvalidDataError);
    expect((error as Error).message.trim().length).toBeGreaterThan(0);
  });

  it("lee un Feature con deslindes declarados y suelo natural", () => {
    const json = JSON.stringify({
      type: "Feature",
      geometry: { type: "Polygon", coordinates: [[[-71.25, -29.9], [-71.2499, -29.9], [-71.2499, -29.9001], [-71.25, -29.9001], [-71.25, -29.9]]] },
      properties: {
        deslindes: [{ tipo: "frente", ancho_lineas_oficiales: 12, colindante: "Calle Balmaceda" }, { tipo: "vecino" }, { tipo: "area_verde" }, {}],
        suelo_natural_z: 1.5,
        suelo_natural_confirmado: true,
      },
    });

    const parcel = importParcelGeoJson(json, "predio.geojson");

    expect(parcel.vertices).toHaveLength(4);
    expect(parcel.edges.map((e) => e.kind)).toEqual(["Frente", "Vecino", "AreaVerde", "Vecino"]);
    expect(parcel.edges[0]).toEqual({ kind: "Frente", officialLinesWidth: 12, label: "Calle Balmaceda" });
    expect(parcel.naturalGroundZ).toBe(1.5);
    expect(parcel.groundConfirmed).toBe(true);
    expect(parcel.source).toBe("predio.geojson");
  });

  it("sin deslindes declarados todos quedan como vecino y lo dice la fuente", () => {
    const json = '{"type": "FeatureCollection", "features": [{"type": "Feature", "geometry": {"type": "Point", "coordinates": [0, 0]}}, ' +
      '{"type": "Feature", "properties": {}, "geometry": {"type": "Polygon", "coordinates": [[[-71.25, -29.9], [-71.2499, -29.9], [-71.2499, -29.9001], [-71.25, -29.9]]]}}]}';

    const parcel = importParcelGeoJson(json, "predio.geojson");

    expect(parcel.edges.every((e) => e.kind === "Vecino")).toBe(true);
    expect(parcel.source).toContain("marque los frentes");
  });

  it("rechaza coordenadas que no son latitud/longitud", () => {
    const json = '{"type": "Polygon", "coordinates": [[[300000, 6690000], [300100, 6690000], [300100, 6690100], [300000, 6690000]]]}';

    expect(() => importParcelGeoJson(json, "predio.geojson")).toThrow(/WGS 84/);
  });
});

describe("Predio guardado", () => {
  // H-04: un predio guardado sin deslindes (o con deslindes nulos) lanzaba NullReferenceException al abrir el .bnc.
  it.each([["null"], ["[null, null, null]"]])("ignora un predio con deslindes %s", (edges) => {
    const json = `{"vertices": [{"latitude": -29.9, "longitude": -71.25}, {"latitude": -29.9, "longitude": -71.2499},
                   {"latitude": -29.9001, "longitude": -71.2499}],
                   "edges": ${edges}, "naturalGroundZ": 0, "source": "predio"}`;

    expect(parcelFromJson(json)).toBeNull();
  });

  it.each([
    ["dos vértices", '{"vertices": [{"latitude": -29.9, "longitude": -71.25}, {"latitude": -29.9, "longitude": -71.2499}], "edges": [{"kind": "Vecino"}, {"kind": "Vecino"}], "naturalGroundZ": 0, "source": "p"}'],
    ["fuera de Chile", '{"vertices": [{"latitude": 42.3, "longitude": -71.25}, {"latitude": 42.3, "longitude": -71.2499}, {"latitude": 42.31, "longitude": -71.2499}], "edges": [{"kind": "Vecino"}, {"kind": "Vecino"}, {"kind": "Vecino"}], "naturalGroundZ": 0, "source": "p"}'],
    ["suelo absurdo", '{"vertices": [{"latitude": -29.9, "longitude": -71.25}, {"latitude": -29.9, "longitude": -71.2499}, {"latitude": -29.9001, "longitude": -71.2499}], "edges": [{"kind": "Vecino"}, {"kind": "Vecino"}, {"kind": "Vecino"}], "naturalGroundZ": 9000, "source": "p"}'],
    ["menos deslindes que vértices", '{"vertices": [{"latitude": -29.9, "longitude": -71.25}, {"latitude": -29.9, "longitude": -71.2499}, {"latitude": -29.9001, "longitude": -71.2499}], "edges": [{"kind": "Vecino"}], "naturalGroundZ": 0, "source": "p"}'],
    ["vacío", ""],
    ["no es JSON", "{"],
  ])("rechaza %s", (_name, json) => {
    expect(parcelFromJson(json)).toBeNull();
  });

  it("ida y vuelta del JSON", () => {
    const parcel = parcelFromVertices(
      [{ latitude: -29.9, longitude: -71.25 }, { latitude: -29.9, longitude: -71.2499 }, { latitude: -29.9001, longitude: -71.2499 }],
      "dibujado",
    );
    const back = parcelFromJson(parcelToJson(parcel));

    expect(back).toEqual(parcel);
    expect(back!.edges.every((e) => e.kind === "Vecino")).toBe(true);
  });
});

describe("Transformación a coordenadas del modelo", () => {
  it("lleva un polígono lon/lat al marco del modelo", () => {
    const center = { latitude: -29.9, longitude: -71.25 };
    const frame = placedFrame(10, 20, fromGeographic(center));
    const east = fromGeographic({ latitude: -29.9, longitude: -71.2499 }, frame.zone);
    const result = toModel({ type: "Polygon", coordinates: [[[-71.25, -29.9], [-71.2499, -29.9], [-71.25, -29.9]]] }, frame);

    expect(result.type).toBe("Polygon");
    const ring = result.coordinates[0] as number[][];
    expect(ring[0][0]).toBeCloseTo(10, 6);
    expect(ring[0][1]).toBeCloseTo(20, 6);
    expect(ring[1][0]).toBeCloseTo(10 + (east.easting - frame.easting), 6);
    expect(ring[1][1]).toBeCloseTo(20 + (east.northing - frame.northing), 6);
  });
});
