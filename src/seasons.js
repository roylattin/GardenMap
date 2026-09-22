// Seasonal + time-of-day sun model for a single spot. Uses the SAME suncalc
// geometry that powers the satellite shadow map, but gated by the bed's aspect
// (the direction it faces) instead of building footprints — so it works from a
// photo capture (GPS + compass) without needing an OSM fetch. Walls/trees are
// NOT included here; the map view adds those for footprint-accurate shadows.

import { seasonDate, classifySun, SUN_META } from './solar';

const SunCalc = require('suncalc');

const SEASONS = ['Spring', 'Summer', 'Fall', 'Winter'];

// suncalc azimuth: from SOUTH, + toward WEST, radians. Convert to compass
// degrees (0=N, 90=E, 180=S, 270=W).
function azToCompass(azRad) {
  return (((azRad * 180) / Math.PI + 180) % 360 + 360) % 360;
}

function angDiff(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

// How lit is a bed facing `aspect` (compass deg, or null = open sky) given the
// sun's compass azimuth and altitude (radians)? Returns 0..1.
export function litFactor(azCompass, altRad, aspect) {
  const altDeg = (altRad * 180) / Math.PI;
  if (altDeg <= 0) return 0;
  // A high sun lights nearly everything regardless of which way a bed faces.
  const overhead = Math.max(0, (altDeg - 45) / 45); // 0 at 45°, 1 at zenith
  if (aspect == null) return 1; // no compass → assume open to the sky
  const diff = angDiff(azCompass, aspect); // 0 = sun straight in front of bed
  let horiz;
  if (diff <= 70) horiz = 1; // sun in front → lit
  else if (diff >= 110) horiz = 0; // sun behind the bed → blocked
  else horiz = (110 - diff) / 40; // grazing
  return Math.max(horiz, overhead);
}

function fmtTime(d) {
  if (!(d instanceof Date) || isNaN(d)) return '—';
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

// Compute per-season sun for a spot. Returns an array of season objects:
//   { season, sunriseLabel, sunsetLabel, directHours, lightClass, meta,
//     cells: [{ hour, lit, up }] }  (cells span hoursFrom..hoursTo)
export function computeSeasonSun({ lat, lng, aspect = null, hoursFrom = 5, hoursTo = 20 }) {
  const asp = typeof aspect === 'number' && !isNaN(aspect) ? ((aspect % 360) + 360) % 360 : null;

  const seasons = SEASONS.map((season) => {
    const date = seasonDate(season);
    const times = SunCalc.getTimes(date, lat, lng);
    const y = date.getFullYear(), m = date.getMonth(), day = date.getDate();

    // Direct-sun hours: sample every 15 min across the whole day.
    let directHours = 0;
    const stepMin = 15;
    for (let mins = 0; mins < 24 * 60; mins += stepMin) {
      const t = new Date(y, m, day, 0, mins, 0);
      const pos = SunCalc.getPosition(t, lat, lng);
      const lf = litFactor(azToCompass(pos.azimuth), pos.altitude, asp);
      if (lf >= 0.5) directHours += stepMin / 60;
    }

    // Hourly cells for the heatmap strip.
    const cells = [];
    for (let hr = hoursFrom; hr <= hoursTo; hr++) {
      const t = new Date(y, m, day, hr, 0, 0);
      const pos = SunCalc.getPosition(t, lat, lng);
      const up = pos.altitude > 0;
      cells.push({ hour: hr, up, lit: up ? litFactor(azToCompass(pos.azimuth), pos.altitude, asp) : 0 });
    }

    const rounded = Math.round(directHours * 2) / 2;
    const lightClass = classifySun(rounded);
    return {
      season,
      sunriseLabel: fmtTime(times.sunrise),
      sunsetLabel: fmtTime(times.sunset),
      directHours: rounded,
      lightClass,
      meta: SUN_META[lightClass],
      cells,
    };
  });

  return { aspect: asp, hoursFrom, hoursTo, seasons };
}

// Which season is "now" (N/S hemisphere aware) — used to highlight the row.
export function currentSeason(date = new Date(), lat = 40) {
  const m = date.getMonth(); // 0..11
  const north = lat >= 0;
  const nSeason = m <= 1 || m === 11 ? 'Winter' : m <= 4 ? 'Spring' : m <= 7 ? 'Summer' : 'Fall';
  if (north) return nSeason;
  const flip = { Winter: 'Summer', Spring: 'Fall', Summer: 'Winter', Fall: 'Spring' };
  return flip[nSeason];
}
