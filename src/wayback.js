// Esri "Wayback" World Imagery — dated satellite captures.
// Lets us always show the newest available imagery (and browse older ones),
// while keeping the standard Esri attribution. No API key required.

const CONFIG_URL =
  'https://s3-us-west-2.amazonaws.com/config.maptiles.arcgis.com/waybackconfig.json';

// {REL} is the Wayback release number; {z}/{y}/{x} are the usual Leaflet tokens.
function tileUrl(rel) {
  return `https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/WMTS/1.0.0/default028mm/MapServer/tile/${rel}/{z}/{y}/{x}`;
}

let cache = null;

// Returns releases sorted newest → oldest: [{ rel, date, url }].
export async function fetchWaybackReleases() {
  if (cache) return cache;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(CONFIG_URL, { signal: ctrl.signal });
    const cfg = await res.json();
    const rows = Object.entries(cfg)
      .map(([rel, v]) => {
        const m = /(\d{4}-\d{2}-\d{2})/.exec(v && v.itemTitle ? v.itemTitle : '');
        return m ? { rel, date: m[1], url: tileUrl(rel) } : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.date.localeCompare(a.date));
    cache = rows;
    return rows;
  } finally {
    clearTimeout(timer);
  }
}

export { tileUrl as waybackTileUrl };
