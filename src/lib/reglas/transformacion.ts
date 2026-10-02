// Porte de Infrastructure/Gis/ModelTransform.cs: pasa geometrías de las capas (X = longitud, Y = latitud) a coordenadas del modelo
// con la ubicación del proyecto. Trabaja sobre GeoJSON: devuelve una copia con cada posición transformada.
import { frameGeoToModel, type ModelFrame } from "@/lib/territorio/location";
import type { Geometry2D } from "./tipos";

const position = (frame: ModelFrame, p: number[]): number[] => {
  const { x, y } = frameGeoToModel(frame, { latitude: p[1], longitude: p[0] });
  return [x, y];
};

export function toModel(geojsonLonLat: Geometry2D, frame: ModelFrame): Geometry2D {
  switch (geojsonLonLat.type) {
    case "LineString":
      return { type: "LineString", coordinates: geojsonLonLat.coordinates.map((p) => position(frame, p)) };
    case "MultiLineString":
    case "Polygon":
      return { type: geojsonLonLat.type, coordinates: geojsonLonLat.coordinates.map((ring) => ring.map((p) => position(frame, p))) };
    case "MultiPolygon":
      return {
        type: "MultiPolygon",
        coordinates: geojsonLonLat.coordinates.map((polygon) => polygon.map((ring) => ring.map((p) => position(frame, p)))),
      };
  }
}
