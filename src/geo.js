// Local planar approximation: convert between lat/lng and east/north meters
// relative to an anchor point. Good enough at backyard scale.
const R = 111320;

export function metersPerDeg(lat) {
  return { lat: R, lng: R * Math.cos((lat * Math.PI) / 180) };
}

export function toMeters(lat0, lng0, lat, lng) {
  const m = metersPerDeg(lat0);
  return { e: (lng - lng0) * m.lng, n: (lat - lat0) * m.lat };
}

export function toLatLng(lat0, lng0, e, n) {
  const m = metersPerDeg(lat0);
  return [lat0 + n / m.lat, lng0 + e / m.lng];
}

// Andrew's monotone chain convex hull over [{e,n}] points.
export function convexHull(points) {
  const p = points.slice().sort((a, b) => a.e - b.e || a.n - b.n);
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a.e - o.e) * (b.n - o.n) - (a.n - o.n) * (b.e - o.e);
  const lower = [];
  for (const pt of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], pt) <= 0) lower.pop();
    lower.push(pt);
  }
  const upper = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const pt = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], pt) <= 0) upper.pop();
    upper.push(pt);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

// Horizontal shadow displacement (in meters, east/north) for an object of the
// given height, at the given sun altitude/azimuth (SunCalc convention:
// azimuth measured from south, positive toward west).
export function shadowOffset(altitude, azimuth, height, maxLen = 300) {
  if (altitude <= 0.02) return null; // sun at/below horizon
  let len = height / Math.tan(altitude);
  if (!isFinite(len) || len > maxLen) len = maxLen;
  return { e: len * Math.sin(azimuth), n: len * Math.cos(azimuth) };
}

// The cast-shadow footprint of a polygon: hull of the base plus the base
// translated by the shadow offset.
export function shadowHull(footprintMeters, offset) {
  if (!offset) return null;
  const pts = footprintMeters.concat(
    footprintMeters.map((p) => ({ e: p.e + offset.e, n: p.n + offset.n }))
  );
  return convexHull(pts);
}

export function pointInPoly(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].e, yi = poly[i].n, xj = poly[j].e, yj = poly[j].n;
    const intersect = yi > pt.n !== yj > pt.n && pt.e < ((xj - xi) * (pt.n - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}
