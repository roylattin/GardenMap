import React, { useEffect, useMemo } from 'react';
import { View } from 'react-native';
import { MapContainer, TileLayer, Polygon, Rectangle, CircleMarker, useMap, useMapEvents } from 'react-leaflet';

import { toMeters, toLatLng, shadowOffset, shadowHull } from './geo';
import { classifySun, SUN_META } from './solar';
import { OSM_ATTRIBUTION } from './osm';

const ESRI_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const ATTRIBUTION = `Imagery © <a href="https://www.esri.com">Esri</a>, Maxar, Earthstar Geographics | Buildings ${OSM_ATTRIBUTION}`;

function Recenter({ lat, lng }) {
  const map = useMap();
  useEffect(() => {
    map.setView([lat, lng], map.getZoom(), { animate: true });
  }, [lat, lng]); // eslint-disable-line
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
      if (hull) out.push(hull.map((p) => toLatLng(lat, lng, p.e, p.n)));
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
    <View style={{ width: size, height: size, borderRadius: 12, overflow: 'hidden' }}>
      <MapContainer
        center={[lat, lng]}
        zoom={20}
        maxZoom={22}
        scrollWheelZoom
        style={{ height: size, width: size }}
      >
        <TileLayer url={ESRI_URL} maxNativeZoom={19} maxZoom={22} attribution={ATTRIBUTION} />
        <Recenter lat={lat} lng={lng} />
        <ClickCatcher onMapClick={(la, ln) => edit && onPlace && onPlace(la, ln)} />

        {/* Cast shadows (drawn first, under everything) */}
        {shadows.map((poly, i) => (
          <Polygon
            key={`sh-${i}`}
            positions={poly}
            pathOptions={{ color: '#0b1a2e', fillColor: '#0b1a2e', fillOpacity: 0.4, weight: 0, interactive: false }}
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
          <CircleMarker
            key={`o-${i}`}
            center={[o.lat, o.lng]}
            radius={o.type === 'tree' ? 7 : 6}
            pathOptions={{
              color: o.type === 'tree' ? '#1b4d20' : '#5d4037',
              fillColor: o.type === 'tree' ? '#2e7d32' : '#8d6e63',
              fillOpacity: 0.9,
              weight: 2,
            }}
          />
        ))}
      </MapContainer>
    </View>
  );
}
