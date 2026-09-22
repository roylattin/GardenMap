import React, { useEffect, useMemo, useRef } from 'react';
import { View } from 'react-native';
import { MapContainer, TileLayer, Polygon, Rectangle, CircleMarker, Circle, useMap, useMapEvents } from 'react-leaflet';

import { toMeters, toLatLng, shadowOffset, shadowHull } from './geo';
import { classifySun, SUN_META } from './solar';
import { OSM_ATTRIBUTION } from './osm';

const ESRI_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const ATTRIBUTION = `Imagery © <a href="https://www.esri.com">Esri</a>, Maxar, Earthstar Geographics | Buildings ${OSM_ATTRIBUTION}`;

// Pick a starting zoom so the analyzed square (sizeM) fills ~92% of the canvas.
// Fractional zoom is honored because we set zoomSnap={0} on the map.
function zoomForSize(sizeM, lat, sizePx) {
  const mppTarget = sizeM / (sizePx * 0.92); // desired meters-per-pixel
  const z = Math.log2((156543.03392 * Math.cos((lat * Math.PI) / 180)) / mppTarget);
  return Math.max(16, Math.min(21, z));
}

function Recenter({ lat, lng }) {
  const map = useMap();
  useEffect(() => {
    // Only jump for programmatic moves (📍 / photo / search). Skip tiny diffs so
    // we don't fight the user's own panning (which reports back via MoveWatcher).
    const c = map.getCenter();
    if (map.distance(c, { lat, lng }) > 8) {
      map.setView([lat, lng], map.getZoom(), { animate: true });
    }
  }, [lat, lng]); // eslint-disable-line
  return null;
}

// Report the map center back to the app whenever the user finishes panning or
// zooming, so the analyzed spot follows what they're looking at. Only fires for
// user-initiated moves — not the initial view or programmatic recenters.
function MoveWatcher({ onRecenter }) {
  const userMoved = useRef(false);
  useMapEvents({
    dragstart() { userMoved.current = true; },
    zoomstart() { userMoved.current = true; },
    moveend(e) {
      if (!userMoved.current) return;
      userMoved.current = false;
      const c = e.target.getCenter();
      onRecenter && onRecenter(c.lat, c.lng);
    },
  });
  return null;
}

function ClickCatcher({ onMapClick }) {
  useMapEvents({
    click(e) {
      onMapClick(e.latlng.lat, e.latlng.lng);
    },
  });
  return null;
}

export default function YardMap({
  size,
  center,
  imageryUrl,
  imageryDate,
  buildings = [],
  obstructions = [],
  mode = 'shadows',
  edit = false,
  sunPos,
  sunGrid,
  gridN = 14,
  sizeM = 40,
  selectedCell,
  onPlace,
  onInspect,
  onRecenter,
}) {
  const { lat, lng } = center;

  // Inject Leaflet's stylesheet once (avoids relying on Metro CSS handling).
  useEffect(() => {
    if (typeof document !== 'undefined' && !document.getElementById('leaflet-css')) {
      const link = document.createElement('link');
      link.id = 'leaflet-css';
      link.rel = 'stylesheet';
      link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
      document.head.appendChild(link);
    }
  }, []);

  // Meter-space footprints for shadow casting (buildings + added obstructions).
  const footprints = useMemo(() => {
    const fps = buildings.map((b) => ({
      ringM: b.ring.map(([la, ln]) => toMeters(lat, lng, la, ln)),
      height: b.height,
      soft: false,
    }));
    for (const o of obstructions) {
      const c = toMeters(lat, lng, o.lat, o.lng);
      const r = o.radius || 1.5;
      fps.push({
        ringM: [
          { e: c.e - r, n: c.n - r },
          { e: c.e + r, n: c.n - r },
          { e: c.e + r, n: c.n + r },
          { e: c.e - r, n: c.n + r },
        ],
        height: o.height,
        soft: o.type === 'tree', // dappled canopy vs solid structure
      });
    }
    return fps;
  }, [buildings, obstructions, lat, lng]);

  // Live cast-shadow polygons for the current sun position.
  const shadows = useMemo(() => {
    if (mode !== 'shadows' || !sunPos) return [];
    const off = shadowOffset(sunPos.altitude, sunPos.azimuth, 1);
    if (!off) return []; // sun down
    const out = [];
    for (const fp of footprints) {
      const hull = shadowHull(fp.ringM, { e: off.e * fp.height, n: off.n * fp.height });
      if (hull) out.push({ poly: hull.map((p) => toLatLng(lat, lng, p.e, p.n)), soft: fp.soft });
    }
    return out;
  }, [footprints, sunPos, mode, lat, lng]);

  // Plant-zone grid cells (rectangles) with all-day sun classification.
  const zoneCells = useMemo(() => {
    if (mode !== 'zones' || !sunGrid) return [];
    const cellM = sizeM / gridN;
    const cells = [];
    for (let r = 0; r < gridN; r++) {
      for (let c = 0; c < gridN; c++) {
        const eW = -sizeM / 2 + c * cellM;
        const eE = eW + cellM;
        const nN = sizeM / 2 - r * cellM;
        const nS = nN - cellM;
        const sw = toLatLng(lat, lng, eW, nS);
        const ne = toLatLng(lat, lng, eE, nN);
        cells.push({ r, c, bounds: [sw, ne], cls: classifySun(sunGrid[r][c]) });
      }
    }
    return cells;
  }, [sunGrid, mode, gridN, sizeM, lat, lng]);

  return (
    <View style={{ width: size, height: size, borderRadius: 12, overflow: 'hidden', position: 'relative' }}>
      <MapContainer
        center={[lat, lng]}
        zoom={zoomForSize(sizeM, lat, size)}
        zoomSnap={0}
        maxZoom={22}
        scrollWheelZoom
        style={{ height: size, width: size }}
      >
        <TileLayer key={imageryUrl || 'esri'} url={imageryUrl || ESRI_URL} maxNativeZoom={19} maxZoom={22} attribution={ATTRIBUTION} />
        <Recenter lat={lat} lng={lng} />
        <MoveWatcher onRecenter={onRecenter} />
        <ClickCatcher onMapClick={(la, ln) => edit && onPlace && onPlace(la, ln)} />

        {/* Cast shadows (drawn first, under everything). Trees = softer dappled. */}
        {shadows.map((s, i) => (
          <Polygon
            key={`sh-${i}`}
            positions={s.poly}
            pathOptions={{
              color: '#0b1a2e',
              fillColor: '#0b1a2e',
              fillOpacity: s.soft ? 0.22 : 0.4,
              weight: 0,
              interactive: false,
            }}
          />
        ))}

        {/* Plant-zone grid */}
        {zoneCells.map((cell) => {
          const sel = selectedCell && selectedCell.r === cell.r && selectedCell.c === cell.c;
          return (
            <Rectangle
              key={`z-${cell.r}-${cell.c}`}
              bounds={cell.bounds}
              pathOptions={{
                color: sel ? '#c0392b' : '#ffffff',
                weight: sel ? 2.5 : 0.3,
                fillColor: SUN_META[cell.cls].color,
                fillOpacity: 0.5,
              }}
              eventHandlers={{ click: () => onInspect && onInspect(cell.r, cell.c) }}
            />
          );
        })}

        {/* Building outlines */}
        {buildings.map((b, i) => (
          <Polygon
            key={`b-${i}`}
            positions={b.ring}
            pathOptions={{ color: '#ffd54f', weight: 1, fill: false, interactive: false }}
          />
        ))}

        {/* Added obstructions */}
        {obstructions.map((o, i) => (
          o.type === 'tree' ? (
            <React.Fragment key={`o-${i}`}>
              {/* Real-meter canopy: the ground under it is dappled all day */}
              <Circle
                center={[o.lat, o.lng]}
                radius={Math.max(o.radius || 1.5, 2)}
                pathOptions={{ color: '#1b4d20', fillColor: '#2e7d32', fillOpacity: 0.28, weight: 1.5 }}
              />
              <CircleMarker
                center={[o.lat, o.lng]}
                radius={4}
                pathOptions={{ color: '#1b4d20', fillColor: '#2e7d32', fillOpacity: 0.95, weight: 2 }}
              />
            </React.Fragment>
          ) : (
            <CircleMarker
              key={`o-${i}`}
              center={[o.lat, o.lng]}
              radius={6}
              pathOptions={{
                color: '#5d4037',
                fillColor: '#8d6e63',
                fillOpacity: 0.9,
                weight: 2,
              }}
            />
          )
        ))}
      </MapContainer>

      {/* Fixed center pin — marks the exact spot being analyzed. Follows the map
          because it's pinned to the container center, not a lat/lng. */}
      <div
        style={{
          position: 'absolute',
          left: '50%',
          top: '50%',
          transform: 'translate(-50%, -50%)',
          pointerEvents: 'none',
          zIndex: 500,
        }}
      >
        <div style={{ position: 'absolute', left: -5, top: -5, width: 10, height: 10, borderRadius: 10, background: '#c0392b', border: '2px solid #fff', boxShadow: '0 0 4px rgba(0,0,0,0.6)' }} />
        <div style={{ position: 'absolute', left: -22, top: -0.5, width: 44, height: 1, background: 'rgba(255,255,255,0.75)' }} />
        <div style={{ position: 'absolute', left: -0.5, top: -22, width: 1, height: 44, background: 'rgba(255,255,255,0.75)' }} />
      </div>
    </View>
  );
}
