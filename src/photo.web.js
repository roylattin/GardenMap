// On-device photo analysis (web): reads EXIF (location, compass aspect, time)
// and estimates sun vs shade from image brightness. No network, no API key —
// the photo never leaves the device. The AI layer (plant ID, health, tailored
// advice) is added later as an opt-in on top of these measured facts.

import exifr from 'exifr';

const MAX_DIM = 900; // downscale cap for speed; overlay rendered at this size

// ---- EXIF ---------------------------------------------------------------

const COMPASS_8 = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

export function aspectFromHeading(deg, lat = 40) {
  if (deg == null || isNaN(deg)) return null;
  const d = ((deg % 360) + 360) % 360;
  const facing = COMPASS_8[Math.round(d / 45) % 8];
  const north = lat >= 0; // northern hemisphere: sun tracks the south
  const NOTES = north
    ? {
        S: 'Hottest, brightest aspect — full sun most of the day. Great for sun-lovers; watch for scorch/drying.',
        N: 'Coolest, shadiest aspect — little to no direct sun. Best for shade & woodland plants.',
        E: 'Gentle morning sun, shade by afternoon. Kind to ferns, hostas, many perennials.',
        W: 'Harsh afternoon sun and trapped heat. Choose heat- & drought-tolerant plants.',
        SE: 'Warm, bright morning through midday sun. Broadly favorable for most plants.',
        SW: 'Very sunny and hot, especially afternoons. Sun- and heat-tolerant picks.',
        NE: 'Soft morning light, shaded afternoons — mostly part shade.',
        NW: 'Shaded mornings, some hot late sun. Leans part shade.',
      }
    : {
        // Southern hemisphere: mirror — sun tracks the north
        N: 'Hottest, brightest aspect — full sun most of the day. Watch for scorch/drying.',
        S: 'Coolest, shadiest aspect — little direct sun. Best for shade & woodland plants.',
        E: 'Gentle morning sun, shade by afternoon. Kind to ferns and shade perennials.',
        W: 'Harsh afternoon sun and heat. Choose heat- & drought-tolerant plants.',
        NE: 'Warm, bright morning through midday sun. Broadly favorable.',
        NW: 'Very sunny and hot, especially afternoons.',
        SE: 'Soft morning light, shaded afternoons — mostly part shade.',
        SW: 'Shaded mornings, some hot late sun. Leans part shade.',
      };
  return { deg: Math.round(d), facing, label: `${facing}-facing`, note: NOTES[facing] };
}

export async function readExif(file) {
  try {
    const data = await exifr.parse(file, {
      gps: true,
      tiff: true,
      ifd0: true,
      exif: true,
      pick: [
        'DateTimeOriginal',
        'CreateDate',
        'GPSImgDirection',
        'GPSImgDirectionRef',
        'GPSDestBearing',
        'latitude',
        'longitude',
        'Orientation',
      ],
    });
    if (!data) return {};
    const lat = data.latitude ?? null;
    const lng = data.longitude ?? null;
    const heading = data.GPSImgDirection ?? data.GPSDestBearing ?? null;
    const when = data.DateTimeOriginal || data.CreateDate || null;
    return {
      lat,
      lng,
      heading,
      when: when ? new Date(when) : null,
      aspect: aspectFromHeading(heading, lat ?? 40),
    };
  } catch {
    return {};
  }
}

// ---- Image light analysis ----------------------------------------------

function otsuThreshold(hist, total) {
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, maxVar = -1, thr = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > maxVar) { maxVar = between; thr = t; }
  }
  return thr;
}

// Returns { sunPct, shadePct, skyPct, lightClass, overlayUrl, width, height }.
// Ground = pixels that aren't sky; sun/shade split via Otsu on ground luminance.
// `source` may be a File/Blob or an already-drawn HTMLCanvasElement (live frame).
export async function analyzeLight(source) {
  let baseCanvas, revoke;
  if (typeof HTMLCanvasElement !== 'undefined' && source instanceof HTMLCanvasElement) {
    baseCanvas = source;
  } else {
    const url = URL.createObjectURL(source);
    revoke = () => URL.revokeObjectURL(url);
    const img = await new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = rej;
      im.src = url;
    });
    baseCanvas = document.createElement('canvas');
    baseCanvas.width = img.width;
    baseCanvas.height = img.height;
    baseCanvas.getContext('2d').drawImage(img, 0, 0);
  }
  try {
    const scale = Math.min(1, MAX_DIM / Math.max(baseCanvas.width, baseCanvas.height));
    const w = Math.max(1, Math.round(baseCanvas.width * scale));
    const h = Math.max(1, Math.round(baseCanvas.height * scale));
    const cvs = document.createElement('canvas');
    cvs.width = w; cvs.height = h;
    const ctx = cvs.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(baseCanvas, 0, 0, w, h);
    const px = ctx.getImageData(0, 0, w, h);
    const d = px.data;

    const lum = new Float32Array(w * h);
    const warmth = new Float32Array(w * h); // R - B: warm (sunlit) vs cool (sky-lit shadow)
    const isSky = new Uint8Array(w * h);
    const hist = new Uint32Array(256);
    let groundCount = 0, skyCount = 0;

    for (let i = 0, p = 0; i < d.length; i += 4, p++) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      lum[p] = L;
      warmth[p] = r - b;
      const y = (p / w) | 0;
      // Sky heuristic: bright + blue-dominant, biased to the upper image.
      const bright = L > 170;
      const bluish = b > r + 8 && b > g - 4;
      const upper = y < h * 0.55;
      if (bright && (bluish || L > 235) && upper) {
        isSky[p] = 1; skyCount++;
      } else {
        hist[Math.min(255, L | 0)]++;
        groundCount++;
      }
    }

    const thrRaw = groundCount > 0 ? otsuThreshold(hist, groundCount) : 128;
    const thr = Math.max(70, Math.min(200, thrRaw)); // adaptive dark/bright split

    // A pixel is real SHADE only when it is BOTH darker than the split AND
    // cool/neutral in tone — because a cast shadow is lit by blue sky, not warm
    // sun. Dark-but-warm pixels (soil, bark mulch, deep-green leaves in sun) are
    // just dark material in sunlight, so they count as SUN. This stops surface
    // texture (dirt speckle, grass gaps) from being miscounted as shade.
    const COOL = 6; // warmth below this (R-B < 6) reads as sky-lit / cool
    const shadeMask = new Uint8Array(w * h);
    let sun = 0, shade = 0;
    for (let p = 0; p < w * h; p++) {
      if (isSky[p]) continue;
      const isShade = lum[p] < thr && warmth[p] < COOL;
      if (isShade) { shade++; shadeMask[p] = 1; } else sun++;
    }
    const ground = sun + shade || 1;
    const sunFrac = sun / ground;

    // Overlay: warm tint = sun, cool tint = shade, sky left as-is.
    for (let i = 0, p = 0; i < d.length; i += 4, p++) {
      if (isSky[p]) continue;
      if (!shadeMask[p]) {
        d[i] = Math.min(255, d[i] * 0.7 + 255 * 0.3);
        d[i + 1] = Math.min(255, d[i + 1] * 0.7 + 205 * 0.3);
        d[i + 2] = Math.min(255, d[i + 2] * 0.7 + 40 * 0.3);
      } else {
        d[i] = Math.min(255, d[i] * 0.72 + 40 * 0.28);
        d[i + 1] = Math.min(255, d[i + 1] * 0.72 + 90 * 0.28);
        d[i + 2] = Math.min(255, d[i + 2] * 0.72 + 170 * 0.28);
      }
    }
    ctx.putImageData(px, 0, 0);
    const overlayUrl = cvs.toDataURL('image/jpeg', 0.85);

    let lightClass;
    if (sunFrac >= 0.6) lightClass = 'full';
    else if (sunFrac >= 0.4) lightClass = 'part-sun';
    else if (sunFrac >= 0.2) lightClass = 'part-shade';
    else lightClass = 'shade';

    return {
      sunPct: Math.round(sunFrac * 100),
      shadePct: Math.round((1 - sunFrac) * 100),
      skyPct: Math.round((skyCount / (w * h)) * 100),
      lightClass,
      overlayUrl,
      width: w,
      height: h,
    };
  } finally {
    if (revoke) revoke();
  }
}

export async function analyzePhoto(file) {
  const [light, exif] = await Promise.all([analyzeLight(file), readExif(file)]);
  return { ...light, exif };
}
