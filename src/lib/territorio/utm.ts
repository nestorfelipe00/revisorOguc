// Porte de Core/Territory/Utm.cs: proyección UTM (Transversa de Mercator) sobre WGS 84, fórmulas de Snyder (USGS PP 1395).
// Precisión milimétrica dentro del huso. SIRGAS-Chile usa GRS80, que difiere de WGS 84 en menos de un milímetro para este uso.

export interface GeoPoint {
  latitude: number;
  longitude: number;
}

export interface UtmPoint {
  easting: number;
  northing: number;
  zone: number;
  south: boolean;
}

const A = 6378137.0;
const F = 1 / 298.257223563;
const K0 = 0.9996;
const E2 = F * (2 - F);
const EP2 = E2 / (1 - E2);

/** Huso UTM que contiene la longitud (Chile continental: 18 al oeste de 72° O, 19 al este). */
export function zoneFor(longitude: number): number {
  return Math.floor((longitude + 180) / 6) + 1;
}

function centralMeridian(zone: number): number {
  return ((zone * 6 - 183) * Math.PI) / 180;
}

function meridianArc(phi: number): number {
  return (
    A *
    ((1 - E2 / 4 - (3 * E2 * E2) / 64 - (5 * E2 ** 3) / 256) * phi -
      ((3 * E2) / 8 + (3 * E2 * E2) / 32 + (45 * E2 ** 3) / 1024) * Math.sin(2 * phi) +
      ((15 * E2 * E2) / 256 + (45 * E2 ** 3) / 1024) * Math.sin(4 * phi) -
      ((35 * E2 ** 3) / 3072) * Math.sin(6 * phi))
  );
}

export function fromGeographic(point: GeoPoint, zone?: number): UtmPoint {
  const z = zone ?? zoneFor(point.longitude);
  const phi = (point.latitude * Math.PI) / 180;
  const lambda = (point.longitude * Math.PI) / 180;
  const sin = Math.sin(phi);
  const cos = Math.cos(phi);
  const tan = Math.tan(phi);

  const n = A / Math.sqrt(1 - E2 * sin * sin);
  const t = tan * tan;
  const c = EP2 * cos * cos;
  const a = cos * (lambda - centralMeridian(z));
  const m = meridianArc(phi);

  const x = K0 * n * (a + ((1 - t + c) * a ** 3) / 6 + ((5 - 18 * t + t * t + 72 * c - 58 * EP2) * a ** 5) / 120);
  const y =
    K0 *
    (m +
      n * tan * ((a * a) / 2 + ((5 - t + 9 * c + 4 * c * c) * a ** 4) / 24 + ((61 - 58 * t + t * t + 600 * c - 330 * EP2) * a ** 6) / 720));
  const south = point.latitude < 0;
  return { easting: x + 500000, northing: south ? y + 10000000 : y, zone: z, south };
}

export function toGeographic(point: UtmPoint): GeoPoint {
  const x = point.easting - 500000;
  const y = point.south ? point.northing - 10000000 : point.northing;

  const mu = y / K0 / (A * (1 - E2 / 4 - (3 * E2 * E2) / 64 - (5 * E2 ** 3) / 256));
  const e1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2));
  const phi1 =
    mu +
    ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu) +
    ((21 * e1 * e1) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu) +
    ((151 * e1 ** 3) / 96) * Math.sin(6 * mu) +
    ((1097 * e1 ** 4) / 512) * Math.sin(8 * mu);

  const sin1 = Math.sin(phi1);
  const cos1 = Math.cos(phi1);
  const tan1 = Math.tan(phi1);
  const c1 = EP2 * cos1 * cos1;
  const t1 = tan1 * tan1;
  const n1 = A / Math.sqrt(1 - E2 * sin1 * sin1);
  const r1 = (A * (1 - E2)) / Math.pow(1 - E2 * sin1 * sin1, 1.5);
  const d = x / (n1 * K0);

  const phi =
    phi1 -
    ((n1 * tan1) / r1) *
      ((d * d) / 2 -
        ((5 + 3 * t1 + 10 * c1 - 4 * c1 * c1 - 9 * EP2) * d ** 4) / 24 +
        ((61 + 90 * t1 + 298 * c1 + 45 * t1 * t1 - 252 * EP2 - 3 * c1 * c1) * d ** 6) / 720);
  const lambda =
    centralMeridian(point.zone) +
    (d - ((1 + 2 * t1 + c1) * d ** 3) / 6 + ((5 - 2 * c1 + 28 * t1 - 3 * c1 * c1 + 8 * EP2 + 24 * t1 * t1) * d ** 5) / 120) / cos1;

  return { latitude: (phi * 180) / Math.PI, longitude: (lambda * 180) / Math.PI };
}

/** Distancia aproximada en metros (haversine sobre la esfera de radio medio). */
export function distanceMeters(a: GeoPoint, b: GeoPoint): number {
  const r = 6371008.8;
  const dLat = ((b.latitude - a.latitude) * Math.PI) / 180;
  const dLon = ((b.longitude - a.longitude) * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((a.latitude * Math.PI) / 180) * Math.cos((b.latitude * Math.PI) / 180) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * r * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Huso UTM declarado en un CRS: EPSG 327xx/326xx (WGS 84), 31978/31979 (SIRGAS 2000), 5361/5362 (SIRGAS-Chile)
 * o una zona explícita ("19S"). Null si no se reconoce.
 */
export function zoneFromCrs(crsName: string | null | undefined, mapZone?: string | null): { zone: number; south: boolean } | null {
  const text = `${crsName ?? ""} ${mapZone ?? ""}`.toUpperCase();
  const epsg = /EPSG:(\d{4,5})/.exec(text);
  if (epsg) {
    const code = Number.parseInt(epsg[1], 10);
    if (code > 32700 && code <= 32760) return { zone: code - 32700, south: true };
    if (code > 32600 && code <= 32660) return { zone: code - 32600, south: false };
    switch (code) {
      case 31978:
      case 5362:
        return { zone: 18, south: true };
      case 31979:
      case 5361:
        return { zone: 19, south: true };
    }
  }
  const zone = /\b(1[89]|[1-5]?\d)\s*([NS])\b/.exec(text);
  if (zone) return { zone: Number.parseInt(zone[1], 10), south: zone[2] === "S" };
  return null;
}

/** Área (m²) de un anillo lon/lat en el plano UTM del primer vértice. */
export function ringAreaM2(ring: GeoPoint[]): number {
  if (ring.length < 3) return 0;
  const zone = zoneFor(ring[0].longitude);
  const p = ring.map((v) => fromGeographic(v, zone));
  let area = 0;
  for (let k = 0; k < p.length; k++) {
    const a = p[k];
    const b = p[(k + 1) % p.length];
    area += a.easting * b.northing - b.easting * a.northing;
  }
  return Math.abs(area) / 2;
}
