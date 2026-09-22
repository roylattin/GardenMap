// On-device AI vision — runs an open-source SegFormer (ADE20K) segmentation
// model entirely in the browser via transformers.js. No backend, no upload:
// the model files download once (then live in the browser cache) and all
// inference happens on the user's device.
//
// Two jobs:
//   • analyzeSpot(image)      — classify a garden photo into sky / canopy /
//                               structure / ground and derive an "openness"
//                               (sky-vs-blockers) sun estimate. Because dirt &
//                               lawn are recognised as GROUND, they no longer
//                               skew the sun number the way raw-brightness did.
//   • detectCanopyTrees(bbox) — segment the satellite tile over the yard and
//                               turn tree canopy blobs into map tree markers.
//
// Web-only. Guard callers with isVisionSupported().

const CDN = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.1';
const MODEL = 'Xenova/segformer-b0-finetuned-ade-512-512';

// Hide the URL from the bundler so Metro/Expo doesn't try to resolve the CDN
// module at build time — it's a genuine runtime import in the browser only.
function dynImport(u) {
  // eslint-disable-next-line no-new-func
  return Function('u', 'return import(u)')(u);
}

export function isVisionSupported() {
  return typeof window !== 'undefined' && typeof document !== 'undefined';
}

// ADE20K label groups we care about.
const SKY = new Set(['sky']);
const CANOPY = new Set(['tree', 'plant', 'palm']);
const STRUCTURE = new Set(['building', 'house', 'wall', 'fence', 'hovel', 'skyscraper', 'awning']);
// From an aerial tile, count only solid built structures as shadow-casters
// (a fence casts almost nothing, so it's left out of the satellite detector).
const TREE = new Set(['tree', 'palm']);
const BUILDING = new Set(['building', 'house', 'hovel', 'skyscraper']);
const GROUND = new Set([
  'earth', 'grass', 'field', 'sand', 'road', 'path', 'sidewalk', 'floor',
  'dirt track', 'runway', 'land', 'hill', 'rug',
]);

let _segPromise = null;

// Load (and cache) the segmentation pipeline. `onProgress` receives
// { pct: 0..1, loaded, total, status } during the one-time model download.
export async function loadSegmenter(onProgress) {
  if (_segPromise) return _segPromise;
  _segPromise = (async () => {
    const { pipeline, env } = await dynImport(CDN);
    env.allowLocalModels = false; // always pull from the HF hub / browser cache
    const files = {};
    const cb = (e) => {
      if (!e) return;
      if (e.status === 'progress' || e.status === 'download' || e.status === 'initiate') {
        if (e.file) files[e.file] = { loaded: e.loaded || 0, total: e.total || 0 };
        let loaded = 0, total = 0;
        for (const k in files) { loaded += files[k].loaded; total += files[k].total; }
        onProgress && onProgress({ pct: total ? loaded / total : 0, loaded, total, status: 'downloading' });
      } else if (e.status === 'ready' || e.status === 'done') {
        onProgress && onProgress({ pct: 1, status: 'ready' });
      }
    };
    const seg = await pipeline('image-segmentation', MODEL, { progress_callback: cb });
    onProgress && onProgress({ pct: 1, status: 'ready' });
    return seg;
  })();
  return _segPromise;
}

// True once the model is already cached in memory this session (no download UI
// needed). transformers.js also persists files in the browser Cache Storage, so
// even a fresh page load after the first use downloads nothing.
export function isSegmenterReady() {
  return _segPromise !== null;
}

// Run segmentation and summarise each class as a pixel fraction of the image.
async function segment(src, onProgress) {
  const seg = await loadSegmenter(onProgress);
  onProgress && onProgress({ pct: 1, status: 'analyzing' });
  const out = await seg(src);
  if (!out || !out.length) return { byLabel: {}, out: [], w: 0, h: 0 };
  const w = out[0].mask.width, h = out[0].mask.height;
  const total = w * h;
  const byLabel = {};
  for (const o of out) {
    const d = o.mask.data;
    let on = 0;
    for (let i = 0; i < d.length; i++) if (d[i] > 127) on++;
    byLabel[o.label] = { mask: o.mask, fraction: total ? on / total : 0 };
  }
  return { byLabel, out, w, h };
}

function sumFraction(byLabel, set) {
  let s = 0;
  for (const label in byLabel) if (set.has(label)) s += byLabel[label].fraction;
  return s;
}

function classFromOpenness(openness) {
  if (openness >= 0.6) return 'full';
  if (openness >= 0.4) return 'part-sun';
  if (openness >= 0.2) return 'part-shade';
  return 'shade';
}

// Analyze a garden photo. Returns a scene breakdown plus an openness-based sun
// estimate. `openness` = sky / (sky + canopy + structure) — of everything
// overhead-relevant, how much is open to the sun. Ground pixels are excluded so
// bare soil or lawn can't masquerade as shade.
export async function analyzeSpot(src, onProgress) {
  const { byLabel } = await segment(src, onProgress);
  const sky = sumFraction(byLabel, SKY);
  const canopy = sumFraction(byLabel, CANOPY);
  const structure = sumFraction(byLabel, STRUCTURE);
  const ground = sumFraction(byLabel, GROUND);
  const blockers = canopy + structure;
  const overhead = sky + blockers; // fraction of the frame that is sky or blocker
  const openness = overhead > 0.05 ? sky / overhead : null; // null = too little sky in frame
  const top = Object.entries(byLabel)
    .sort((a, b) => b[1].fraction - a[1].fraction)
    .slice(0, 5)
    .map(([label, v]) => ({ label, pct: Math.round(v.fraction * 100) }))
    .filter((x) => x.pct >= 2);
  return {
    sky: Math.round(sky * 100),
    canopy: Math.round(canopy * 100),
    structure: Math.round(structure * 100),
    ground: Math.round(ground * 100),
    openness: openness == null ? null : Math.round(openness * 100),
    lightClass: openness == null ? null : classFromOpenness(openness),
    lowSky: overhead <= 0.05, // camera likely pointed down — openness unreliable
    top,
  };
}

// Build an ArcGIS World Imagery export URL covering `sizeM` metres around a pin.
export function yardTileUrl(lat, lng, sizeM = 64, px = 384) {
  const dLat = sizeM / 2 / 111320;
  const dLng = sizeM / 2 / (111320 * Math.cos((lat * Math.PI) / 180));
  const west = lng - dLng, east = lng + dLng, south = lat - dLat, north = lat + dLat;
  const url =
    'https://services.arcgisonline.com/arcgis/rest/services/World_Imagery/MapServer/export' +
    `?bbox=${west},${south},${east},${north}&bboxSR=4326&imageSR=3857` +
    `&size=${px},${px}&format=jpg&f=image`;
  return { url, west, east, south, north };
}

// Downscale a single-channel RawImage mask to a coarse boolean grid.
function coarseGrid(mask, G) {
  const { data, width, height } = mask;
  const grid = new Array(G * G).fill(0);
  const counts = new Array(G * G).fill(0);
  for (let y = 0; y < height; y++) {
    const gy = Math.min(G - 1, (y * G / height) | 0);
    for (let x = 0; x < width; x++) {
      const gx = Math.min(G - 1, (x * G / width) | 0);
      const gi = gy * G + gx;
      counts[gi]++;
      if (data[y * width + x] > 127) grid[gi]++;
    }
  }
  const on = new Array(G * G).fill(false);
  for (let i = 0; i < grid.length; i++) on[i] = counts[i] > 0 && grid[i] / counts[i] >= 0.4;
  return on;
}

// Union several class masks (e.g. building + house) into one coarse boolean grid.
function gridFromLabels(byLabel, set, w, h, G, minCover = 0.4) {
  const masks = [];
  for (const label in byLabel) if (set.has(label)) masks.push(byLabel[label].mask);
  if (!masks.length) return null;
  const grid = new Array(G * G).fill(0);
  const counts = new Array(G * G).fill(0);
  for (let y = 0; y < h; y++) {
    const gy = Math.min(G - 1, (y * G / h) | 0);
    for (let x = 0; x < w; x++) {
      const gx = Math.min(G - 1, (x * G / w) | 0);
      const gi = gy * G + gx;
      counts[gi]++;
      let hit = false;
      for (const m of masks) { if (m.data[y * m.width + x] > 127) { hit = true; break; } }
      if (hit) grid[gi]++;
    }
  }
  const on = new Array(G * G).fill(false);
  for (let i = 0; i < grid.length; i++) on[i] = counts[i] > 0 && grid[i] / counts[i] >= minCover;
  return on;
}

// Flood-fill the boolean grid into connected blobs.
function blobs(on, G) {
  const seen = new Array(G * G).fill(false);
  const out = [];
  for (let i = 0; i < on.length; i++) {
    if (!on[i] || seen[i]) continue;
    const stack = [i];
    seen[i] = true;
    const cells = [];
    while (stack.length) {
      const c = stack.pop();
      cells.push(c);
      const cx = c % G, cy = (c / G) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= G || ny >= G) continue;
        const ni = ny * G + nx;
        if (on[ni] && !seen[ni]) { seen[ni] = true; stack.push(ni); }
      }
    }
    out.push(cells);
  }
  return out;
}

// Detect shadow-casters in the yard's satellite tile. Segments the aerial image
// once and turns tree-canopy and building blobs into map obstructions:
//   { type:'tree'|'structure', lat, lng, radius, height, ai:true }
// Returns { trees, structures } so callers can label/report them separately.
export async function detectObstructions(lat, lng, sizeM = 64, onProgress) {
  const { url, west, east, south, north } = yardTileUrl(lat, lng, sizeM);
  const { byLabel, w, h } = await segment(url, onProgress);
  const G = 40;
  const mPerCell = sizeM / G;
  const cellArea = mPerCell * mPerCell;

  const blobsToItems = (set, type, height, rMin, rMax) => {
    const on = gridFromLabels(byLabel, set, w, h, G);
    if (!on) return [];
    const items = [];
    for (const cells of blobs(on, G)) {
      if (cells.length < 2) continue; // ignore speckle
      let sx = 0, sy = 0;
      for (const c of cells) { sx += c % G; sy += (c / G) | 0; }
      const cx = sx / cells.length, cy = sy / cells.length;
      const areaM2 = cells.length * cellArea;
      const radius = Math.max(rMin, Math.min(rMax, Math.sqrt(areaM2 / Math.PI)));
      const ilng = west + ((cx + 0.5) / G) * (east - west);
      const ilat = north - ((cy + 0.5) / G) * (north - south);
      items.push({ type, lat: ilat, lng: ilng, radius, height, ai: true });
    }
    return items;
  };

  const trees = blobsToItems(TREE, 'tree', 7, 1.8, 10);
  const structures = blobsToItems(BUILDING, 'structure', 6, 2.5, 16);
  return { trees, structures };
}

// Detect tree canopy in the yard's satellite tile and return tree obstructions
// { type:'tree', lat, lng, radius, height, ai:true }.
export async function detectCanopyTrees(lat, lng, sizeM = 64, onProgress) {
  const { trees } = await detectObstructions(lat, lng, sizeM, onProgress);
  return trees;
}
