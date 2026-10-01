// Porte de TerritoryTests y GeolocationTests del escritorio (tests/BimNormativeChecker.Core.Tests).
import { describe, expect, it } from "vitest";
import { distanceMeters, fromGeographic, toGeographic, zoneFor, zoneFromCrs } from "./utm";
import { describeGeolocation, isSiteOutsideChile, resolveLocation, rotationDegrees, type ModelGeolocation } from "./location";

describe("UTM", () => {
  it("ida y vuelta milimétrica en La Serena", () => {
    const laSerena = { latitude: -29.9027, longitude: -71.2519 };
    const utm = fromGeographic(laSerena);
    expect(utm.zone).toBe(19);
    expect(utm.south).toBe(true);
    expect(distanceMeters(laSerena, toGeographic(utm))).toBeLessThan(0.01);
  });

  it("el meridiano central da el falso Este", () => {
    const utm = fromGeographic({ latitude: -33.45, longitude: -69 });
    expect(utm.easting).toBeCloseTo(500000, 3);
    expect(utm.zone).toBe(19);
  });

  it.each([
    [-70.74, 19],
    [-71.25, 19],
    [-72.5, 18],
  ])("huso de la longitud %d es %d", (lon, zone) => {
    expect(zoneFor(lon)).toBe(zone);
  });

  it.each([
    ["EPSG:32719", 19, true],
    ["EPSG:5361", 19, true],
    ["EPSG:31978", 18, true],
    ["WGS 84 / UTM zone 19S", 19, true],
  ])("reconoce el CRS %s", (crs, zone, south) => {
    expect(zoneFromCrs(crs)).toEqual({ zone, south });
  });
});

describe("Georreferencia", () => {
  it("lee IfcMapConversion y el IfcSite", () => {
    const geo: ModelGeolocation = {
      mapConversion: { crsName: "EPSG:32719", eastings: 282900, northings: 6690000, height: 30, xAxisAbscissa: 1, xAxisOrdinate: 0, scale: 1, lengthScale: 1 },
      siteLatitude: -29.904444444444444,
      siteLongitude: -71.24888888888889,
    };
    expect(rotationDegrees(geo.mapConversion!)).toBe(0);
    expect(isSiteOutsideChile(geo)).toBe(false);
    expect(describeGeolocation(geo).some((l) => l.startsWith("⚠"))).toBe(false);
  });

  it("marca la ubicación por defecto de Revit en Boston", () => {
    const geo: ModelGeolocation = { mapConversion: null, siteLatitude: 42.213001251111116, siteLongitude: -71.03299713111112 };
    expect(isSiteOutsideChile(geo)).toBe(true);
    expect(describeGeolocation(geo).filter((l) => l.startsWith("⚠"))).toHaveLength(2);
    expect(resolveLocation(geo, { minX: 0, minY: 0, minZ: 0, maxX: 30, maxY: 20, maxZ: 10 })).toBeNull();
  });

  it("la rotación sigue la dirección del eje X", () => {
    expect(rotationDegrees({ crsName: null, eastings: 0, northings: 0, height: 0, xAxisAbscissa: 0, xAxisOrdinate: 1, scale: 1, lengthScale: 1 })).toBeCloseTo(90, 6);
  });

  it("el modelo de ejemplo se ubica en La Serena por IfcMapConversion", () => {
    const geo: ModelGeolocation = {
      mapConversion: { crsName: "EPSG:32719", eastings: 282900, northings: 6690000, height: 30, xAxisAbscissa: 1, xAxisOrdinate: 0, scale: 1, lengthScale: 1 },
      siteLatitude: -29.904444444444444,
      siteLongitude: -71.24888888888889,
    };
    const location = resolveLocation(geo, { minX: 0, minY: 0, minZ: 0, maxX: 30, maxY: 20, maxZ: 10 })!;
    expect(location.source).toBe("mapConversion");
    expect(location.needsConfirmation).toBe(false);
    expect(location.footprint).toHaveLength(5);
    expect(distanceMeters(location.center, { latitude: -29.901457, longitude: -71.248295 })).toBeLessThan(1);
    expect(location.notes.some((n) => n.startsWith("Coherente con el IfcSite"))).toBe(true);
  });

  it("coordenadas compartidas del HBP son coherentes con su IfcSite", () => {
    // HBP-EST-R2025: extensión con magnitud UTM 19S alrededor de E 338.726 N 6.264.692; IfcSite -33.7456, -70.7411.
    const geo: ModelGeolocation = { mapConversion: null, siteLatitude: -33.7456, siteLongitude: -70.7411 };
    const location = resolveLocation(geo, { minX: 338600, minY: 6264600, minZ: 0, maxX: 338850, maxY: 6264780, maxZ: 40 })!;
    expect(location.source).toBe("modelUtmCoordinates");
    expect(location.needsConfirmation).toBe(true);
    expect(location.notes.some((n) => n.startsWith("Coherente con el IfcSite"))).toBe(true);
    expect(distanceMeters(location.center, { latitude: -33.74576, longitude: -70.74327 })).toBeLessThan(5000);
  });
});
