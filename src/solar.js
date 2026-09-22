// suncalc is a CommonJS module whose default export doesn't survive Metro's
// ESM interop on web (resolves to undefined), so require it directly.
const SunCalc = require('suncalc');

// Coordinate model for the yard canvas:
//   - The yard is a square of `sizeM` meters per side.
//   - Obstruction positions (x, y) are normalized [0,1], origin at TOP-LEFT.
//   - Screen "up" (y = 0) is treated as NORTH, so +y = south, +x = east.
//
// SunCalc azimuth convention: measured from SOUTH, positive toward WEST.
// With north = -y, south = +y, east = +x, west = -x:
//   sunDir (unit vector pointing TOWARD the sun) = { x: -sin(az), y: cos(az) }

const SEASON_DATES = {
  Spring: [2, 21], // month index (0-based), day
  Summer: [5, 21],
  Fall: [8, 21],
  Winter: [11, 21],
};

export function seasonDate(season, year = new Date().getFullYear()) {
  const [m, d] = SEASON_DATES[season] || SEASON_DATES.Summer;
  // Noon-anchored so getTimes()/getPosition() land on the right local day.
  return new Date(year, m, d, 12, 0, 0);
}

/**
 * Estimate direct-sun hours for every cell of a gridN x gridN grid.
 * Returns a 2D array [row][col] of hours (row 0 = north edge).
 */
export function computeSunHours({
  lat,
  lng,
  date,
  obstructions = [],
  gridN = 12,
  sizeM = 24,
  stepMinutes = 30,
}) {
  const times = SunCalc.getTimes(date, lat, lng);
  const sunrise = times.sunrise;
  const sunset = times.sunset;

  const grid = Array.from({ length: gridN }, () => new Array(gridN).fill(0));

  // Guard against polar day/night or invalid times.
  if (!(sunrise instanceof Date) || isNaN(sunrise) || isNaN(sunset)) {
    return grid;
  }

  const cell = sizeM / gridN;
  const centers = [];
  for (let r = 0; r < gridN; r++) {
    for (let c = 0; c < gridN; c++) {
      centers.push({ r, c, mx: (c + 0.5) * cell, my: (r + 0.5) * cell });
    }
  }

  const obs = obstructions.map((o) => ({
    bx: o.x * sizeM,
    by: o.y * sizeM,
    h: o.height,
    w: (o.radius ?? 1) * 2, // shadow band width in meters
  }));

  const stepMs = stepMinutes * 60000;
  const stepHours = stepMinutes / 60;

  for (let t = sunrise.getTime(); t <= sunset.getTime(); t += stepMs) {
    const d = new Date(t);
    const pos = SunCalc.getPosition(d, lat, lng);
    if (pos.altitude <= 0.03) continue; // ignore sun very near/below horizon

    const az = pos.azimuth;
    const sunDir = { x: -Math.sin(az), y: Math.cos(az) };
    const shadowDir = { x: -sunDir.x, y: -sunDir.y }; // cast away from the sun
    const perp = { x: -shadowDir.y, y: shadowDir.x };
    const shadowPerMeter = 1 / Math.tan(pos.altitude); // shadow length factor

    for (const o of obs) {
      o._len = o.h * shadowPerMeter;
    }

    for (const ctr of centers) {
      let shaded = false;
      for (const o of obs) {
        const dx = ctr.mx - o.bx;
        const dy = ctr.my - o.by;
        const along = dx * shadowDir.x + dy * shadowDir.y;
        const side = dx * perp.x + dy * perp.y;
        if (along >= -o.w * 0.5 && along <= o._len && Math.abs(side) <= o.w * 0.5) {
          shaded = true;
          break;
        }
      }
      if (!shaded) grid[ctr.r][ctr.c] += stepHours;
    }
  }

  return grid;
}

// Classify direct-sun hours into a garden light category.
export function classifySun(hours) {
  if (hours >= 6) return 'full';
  if (hours >= 4) return 'part-sun';
  if (hours >= 2) return 'part-shade';
  return 'shade';
}

export const SUN_META = {
  full: { label: 'Full sun', color: '#f4c430', sub: '6+ hrs direct' },
  'part-sun': { label: 'Part sun', color: '#a7d96b', sub: '4-6 hrs direct' },
  'part-shade': { label: 'Part shade', color: '#4c9a6b', sub: '2-4 hrs direct' },
  shade: { label: 'Full shade', color: '#2f5d50', sub: 'under 2 hrs' },
};

// ---- Real-map (satellite) sun helpers -------------------------------------
import { toMeters, shadowOffset, shadowHull, pointInPoly } from './geo';

export function sunTimes(date, lat, lng) {
  return SunCalc.getTimes(date, lat, lng);
}

export function sunPositionAt(date, lat, lng) {
  return SunCalc.getPosition(date, lat, lng); // { altitude, azimuth } radians
}

// Map a 0..1 fraction of the day to an actual Date between sunrise and sunset.
export function timeForFraction(season, lat, lng, frac) {
  const base = seasonDate(season);
  const t = SunCalc.getTimes(base, lat, lng);
  const start = t.sunrise instanceof Date && !isNaN(t.sunrise) ? t.sunrise.getTime() : new Date(base).setHours(7, 0, 0, 0);
  const end = t.sunset instanceof Date && !isNaN(t.sunset) ? t.sunset.getTime() : new Date(base).setHours(19, 0, 0, 0);
  return new Date(start + frac * (end - start));
}

// Build the meter-space footprints (relative to center) for buildings + the
// user's added obstructions. Trees/structures become small squares.
function footprintsMeters({ lat, lng, buildings = [], obstructions = [] }) {
  const fps = [];
  for (const b of buildings) {
    const ring = b.ring.map(([la, ln]) => toMeters(lat, lng, la, ln));
    fps.push({ ring, height: b.height });
  }
  for (const o of obstructions) {
    const c = toMeters(lat, lng, o.lat, o.lng);
    const r = o.radius || 1.5;
    fps.push({
      ring: [
        { e: c.e - r, n: c.n - r },
        { e: c.e + r, n: c.n - r },
        { e: c.e + r, n: c.n + r },
        { e: c.e - r, n: c.n + r },
      ],
      height: o.height,
    });
  }
  return fps;
}

/**
 * All-day direct-sun hours for a sizeM x sizeM grid centered on (lat,lng),
 * accounting for shadows cast by real building footprints + added obstructions.
 * Returns a 2D array [row][col] (row 0 = north).
 */
export function computeSunGrid({
  lat,
  lng,
  season,
  buildings = [],
  obstructions = [],
  gridN = 14,
  sizeM = 40,
  stepMinutes = 30,
}) {
  const date = seasonDate(season);
  const times = SunCalc.getTimes(date, lat, lng);
  const grid = Array.from({ length: gridN }, () => new Array(gridN).fill(0));
  if (!(times.sunrise instanceof Date) || isNaN(times.sunrise) || isNaN(times.sunset)) return grid;

  const fps = footprintsMeters({ lat, lng, buildings, obstructions });
  const cellM = sizeM / gridN;
  // grid centered on (0,0) in meters; row 0 = north (+n)
  const centers = [];
  for (let r = 0; r < gridN; r++) {
    for (let c = 0; c < gridN; c++) {
      centers.push({ r, c, e: -sizeM / 2 + (c + 0.5) * cellM, n: sizeM / 2 - (r + 0.5) * cellM });
    }
  }

  const stepMs = stepMinutes * 60000;
  const stepHours = stepMinutes / 60;

  for (let t = times.sunrise.getTime(); t <= times.sunset.getTime(); t += stepMs) {
    const pos = SunCalc.getPosition(new Date(t), lat, lng);
    if (pos.altitude <= 0.03) continue;
    const off = shadowOffset(pos.altitude, pos.azimuth, 1); // per-meter offset
    const hulls = fps.map((f) =>
      shadowHull(f.ring, off ? { e: off.e * f.height, n: off.n * f.height } : null)
    );
    for (const ctr of centers) {
      let shaded = false;
      for (let i = 0; i < hulls.length; i++) {
        const hull = hulls[i];
        if (hull && pointInPoly(ctr, hull)) {
          shaded = true;
          break;
        }
      }
      if (!shaded) grid[ctr.r][ctr.c] += stepHours;
    }
  }
  return grid;
}
