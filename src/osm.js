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

// Returns [{ ring: [[lat,lng], ...], height, name }]
async function tryEndpoint(url, body, signal) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal,
  });
  if (!res.ok) throw new Error('Overpass ' + res.status);
  const json = await res.json();
  const out = [];
  for (const el of json.elements || []) {
    const geom = el.geometry;
    if (!geom || geom.length < 3) continue;
    out.push({
      ring: geom.map((g) => [g.lat, g.lon]),
      height: parseHeight(el.tags),
      name: (el.tags && (el.tags.name || el.tags['addr:housenumber'])) || null,
    });
  }
  return out;
}

export async function fetchBuildings(lat, lng, radius = 150) {
  const q =
    `[out:json][timeout:20];(` +
    `way["building"](around:${radius},${lat},${lng});` +
    `);out geom;`;
  const body = 'data=' + encodeURIComponent(q);

  // Race all mirrors; first success wins. Hard-cap the whole thing so the UI
  // never hangs on "loading" when public Overpass is slow or down.
  const ctrl = new AbortController();
  const budget = setTimeout(() => ctrl.abort(), 13000);
  try {
    return await Promise.any(ENDPOINTS.map((u) => tryEndpoint(u, body, ctrl.signal)));
  } finally {
    clearTimeout(budget);
    ctrl.abort();
  }
}
