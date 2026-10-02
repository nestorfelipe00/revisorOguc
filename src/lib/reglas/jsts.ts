// Fachada tipada de jsts (porte JavaScript del mismo JTS que NetTopologySuite). jsts solo se distribuye como módulos ES por
// subruta y sus declaraciones propias son casi todas `any`; aquí se declara lo mínimo que usa el motor, sin DOM (sirve en un
// Web Worker y en Node). Las operaciones de Geometry (intersection, buffer, contains…) existen gracias a monkey.js.
import "jsts/org/locationtech/jts/monkey.js";
import GeoJSONReaderImpl from "jsts/org/locationtech/jts/io/GeoJSONReader.js";
import GeoJSONWriterImpl from "jsts/org/locationtech/jts/io/GeoJSONWriter.js";
import GeometryFactoryImpl from "jsts/org/locationtech/jts/geom/GeometryFactory.js";
import CoordinateImpl from "jsts/org/locationtech/jts/geom/Coordinate.js";
import LocationImpl from "jsts/org/locationtech/jts/geom/Location.js";
import TopologyExceptionImpl from "jsts/org/locationtech/jts/geom/TopologyException.js";
import IndexedPointInAreaLocatorImpl from "jsts/org/locationtech/jts/algorithm/locate/IndexedPointInAreaLocator.js";
import UnaryUnionOpImpl from "jsts/org/locationtech/jts/operation/union/UnaryUnionOp.js";
import type { Geometry2D } from "./tipos";

export interface Coordinate {
  x: number;
  y: number;
}

export interface Envelope {
  getMinX(): number;
  getMinY(): number;
  getMaxX(): number;
  getMaxY(): number;
  getWidth(): number;
  getHeight(): number;
  getArea(): number;
}

export interface Geometry {
  getArea(): number;
  getLength(): number;
  isEmpty(): boolean;
  getNumGeometries(): number;
  getGeometryN(n: number): Geometry;
  getCoordinates(): Coordinate[];
  getEnvelopeInternal(): Envelope;
  getGeometryType(): string;
  intersection(other: Geometry): Geometry;
  buffer(distance: number): Geometry;
  contains(other: Geometry): boolean;
  intersects(other: Geometry): boolean;
  distance(other: Geometry): number;
  copy(): Geometry;
  geometryChanged(): void;
}

export interface Polygon extends Geometry {
  getExteriorRing(): Geometry;
}

/** Equivalente de PreparedGeometry.Contains(punto): verdadero solo si el punto está en el interior (no en el borde). */
export interface PointInArea {
  contains(x: number, y: number): boolean;
}

interface GeometryFactoryLike {
  createPoint(coordinate: Coordinate): Geometry;
  createPolygon(shell?: Coordinate[]): Polygon;
  createLineString(coordinates: Coordinate[]): Geometry;
  createGeometryCollection(geometries: Geometry[]): Geometry;
}

const factory = new GeometryFactoryImpl() as unknown as GeometryFactoryLike;
const reader = new GeoJSONReaderImpl(factory as unknown as GeometryFactoryImpl) as unknown as { read(geoJson: unknown): Geometry };
const writer = new GeoJSONWriterImpl() as unknown as { write(geometry: Geometry): Geometry2D };
const unaryUnion = UnaryUnionOpImpl as unknown as { union(geometry: Geometry): Geometry };
const PointLocator = IndexedPointInAreaLocatorImpl as unknown as new (geometry: Geometry) => { locate(coordinate: Coordinate): number };
const INTERIOR = (LocationImpl as unknown as { INTERIOR: number }).INTERIOR;

export const coordinate = (x: number, y: number): Coordinate => new CoordinateImpl(x, y) as unknown as Coordinate;

export const pointOf = (c: Coordinate): Geometry => factory.createPoint(c);

/** Polígono sin huecos; el anillo se cierra si no viene cerrado. Sin coordenadas, polígono vacío. */
export function polygonOf(ring?: Coordinate[]): Polygon {
  if (!ring || ring.length === 0) return factory.createPolygon();
  const first = ring[0];
  const last = ring[ring.length - 1];
  const closed = first.x === last.x && first.y === last.y ? ring : [...ring, coordinate(first.x, first.y)];
  return factory.createPolygon(closed);
}

export const lineOf = (coordinates: Coordinate[]): Geometry => factory.createLineString(coordinates);

/** UnaryUnionOp.Union(lista): unión de todas las geometrías (vacía si no hay ninguna). */
export function unionAll(geometries: Geometry[]): Geometry {
  if (geometries.length === 0) return factory.createPolygon();
  return unaryUnion.union(factory.createGeometryCollection(geometries));
}

export const readGeoJson = (geometry: Geometry2D): Geometry => reader.read(geometry);

export const writeGeoJson = (geometry: Geometry): Geometry2D => writer.write(geometry);

export function prepare(geometry: Geometry): PointInArea {
  const locator = new PointLocator(geometry);
  return { contains: (x, y) => locator.locate(coordinate(x, y)) === INTERIOR };
}

export const isTopologyException = (error: unknown): boolean => error instanceof TopologyExceptionImpl;
