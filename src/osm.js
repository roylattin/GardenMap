// OpenStreetMap building footprints via the Overpass API.
// OSM data is ODbL — attribution "© OpenStreetMap contributors" is REQUIRED
// wherever this data (or shadows derived from it) is shown.
export const OSM_ATTRIBUTION = '© OpenStreetMap contributors';

const ENDPOINTS = [
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

function parseHeight(tags = {}) {
  if (tags.height) {
    const v = parseFloat(tags.height);
    if (!isNaN(v)) return v;
  }
  if (tags['building:levels']) {
    const v = parseFloat(tags['building:levels']);
    if (!isNaN(v)) return Math.max(2.5, v * 3.2);
  }
  return 6; // sensible default ≈ 2 storeys
}

// Returns { buildings: [{ ring:[[lat,lng]...], height, name }], trees: [{ lat, lng, radius, height }] }
async function tryEndpoint(url, body, signal) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal,
  });
  if (!res.ok) throw new Error('Overpass ' + res.status);
  const json = await res.json();
  const buildings = [];
  const trees = [];
  for (const el of json.elements || []) {
    const tags = el.tags || {};
    if (el.type === 'way' && tags.building) {
      const geom = el.geometry;
      if (!geom || geom.length < 3) continue;
      buildings.push({
        ring: geom.map((g) => [g.lat, g.lon]),
        height: parseHeight(tags),
        name: tags.name || tags['addr:housenumber'] || null,
      });
    } else if (el.type === 'node' && tags.natural === 'tree' && el.lat != null) {
      trees.push(treeFrom(el.lat, el.lon, tags));
    } else if (el.type === 'way' && tags.natural === 'tree_row' && el.geometry) {
      // A row of trees — drop a canopy at each mapped vertex.
      for (const g of el.geometry) trees.push(treeFrom(g.lat, g.lon, tags));
    }
  }
  return { buildings, trees };
}

// Build a tree obstruction from OSM tags, using crown/height hints when present.
function treeFrom(lat, lng, tags = {}) {
  let radius = 3; // canopy radius in meters (≈ 6 m spread) — a typical yard tree
  const crown = parseFloat(tags['diameter_crown']);
  if (!isNaN(crown) && crown > 0) radius = Math.max(1.5, Math.min(12, crown / 2));
  let height = 7;
  const h = parseFloat(tags.height || tags['est_height']);
  if (!isNaN(h) && h > 0) height = Math.max(2, Math.min(30, h));
  return { type: 'tree', lat, lng, radius, height, auto: true };
}

export async function fetchBuildings(lat, lng, radius = 150) {
  const q =
    `[out:json][timeout:20];(` +
    `way["building"](around:${radius},${lat},${lng});` +
    `node["natural"="tree"](around:${radius},${lat},${lng});` +
    `way["natural"="tree_row"](around:${radius},${lat},${lng});` +
    `);out geom;`;
  const body = 'data=' + encodeURIComponent(q);

  // Race all mirrors; first success wins. Each attempt has its own timeout, and
  // a hard wall-clock cap GUARANTEES the promise resolves even if a mobile
  // browser ignores fetch abort — so the UI never gets stuck on "Loading…".
  const attempt = (async () => {
    const tries = ENDPOINTS.map((u) => {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 9000);
      return tryEndpoint(u, body, ctrl.signal).finally(() => clearTimeout(t));
    });
    try {
      return await Promise.any(tries);
    } catch {
      return { buildings: [], trees: [] };
    }
  })();
  const hardCap = new Promise((res) => setTimeout(() => res(null), 11000));
  const result = await Promise.race([attempt, hardCap]);
  return result && result.buildings ? result : { buildings: [], trees: [] };
}
