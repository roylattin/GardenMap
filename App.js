import React, { useState, useMemo, useEffect, useRef } from 'react';
import {
  SafeAreaView,
  ScrollView,
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Dimensions,
  ActivityIndicator,
  Alert,
  Modal,
  Image,
  Platform,
  Share as RNShare,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as Location from 'expo-location';
import QRCode from 'qrcode';

import YardMap from './src/YardMap';
import TimeSlider from './src/TimeSlider';
import PhotoAnalyzer from './src/PhotoAnalyzer';
import { fetchBuildings } from './src/osm';
import { detectObstructions, isSegmenterReady, isVisionSupported } from './src/vision';
import { fetchWaybackReleases } from './src/wayback';
import {
  computeSunGrid,
  classifySun,
  timeForFraction,
  sunPositionAt,
  SUN_META,
} from './src/solar';
import { estimateZone, recommendPlants } from './src/plants';
import { toMeters, pointInPoly } from './src/geo';

// Public test-app URL (Azure Static Web Apps). On web we prefer the live origin.
const APP_URL = 'https://purple-ocean-065e1490f.5.azurestaticapps.net';
function shareUrl() {
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    return window.location.origin + window.location.pathname;
  }
  return APP_URL;
}

const GRID_N = 32;
const SIZE_M = 64; // area analyzed ≈ 64m x 64m around the pin
const SEASONS = ['Spring', 'Summer', 'Fall', 'Winter'];
const CANVAS = Math.min(Dimensions.get('window').width - 32, 380);

// Rough great-circle distance in meters (good enough for yard-scale guards).
function metersBetween(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

// Tiny safe key/value store — uses localStorage on web, no-ops on native.
const LS = (() => {
  try {
    if (typeof localStorage !== 'undefined') return localStorage;
  } catch {}
  return null;
})();
function loadJSON(key, fallback) {
  try {
    const v = LS && LS.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
}
function saveJSON(key, val) {
  try {
    if (LS) LS.setItem(key, JSON.stringify(val));
  } catch {}
}
// Cache key for a ~110m tile so nearby pins reuse the same OSM result.
function osmKey(lat, lng) {
  return `gm_osm_${lat.toFixed(3)}_${lng.toFixed(3)}`;
}

// Seed the demo yard so shadows are visible on first load even if the public
// OSM building service is slow/unavailable. Cleared once the user picks 📍.
const DEMO_OBSTRUCTIONS = [
  { type: 'structure', lat: 37.44293, lng: -122.15178, height: 6, radius: 5 },
  { type: 'tree', lat: 37.44283, lng: -122.15165, height: 7, radius: 2.6 },
  { type: 'tree', lat: 37.44300, lng: -122.15193, height: 5, radius: 2.1 },
];

export default function App() {
  const savedLoc = loadJSON('gm_loc', null);
  const initLat = savedLoc ? savedLoc.lat : 37.4429;
  const initLng = savedLoc ? savedLoc.lng : -122.1518;
  const [lat, setLat] = useState(initLat);
  const [lng, setLng] = useState(initLng);
  const [zone, setZone] = useState(estimateZone(initLat));
  const [locLabel, setLocLabel] = useState(savedLoc ? savedLoc.label || 'Saved yard' : 'Demo yard — tap 📍 for yours');
  const [season, setSeason] = useState('Summer');
  const [uiMode, setUiMode] = useState('zones'); // 'shadows' | 'zones' — zones is the primary view
  const [timeFrac, setTimeFrac] = useState(0.5); // 0 = sunrise, 1 = sunset

  const [buildings, setBuildings] = useState([]);
  const [loadingBld, setLoadingBld] = useState(false);
  const [edit, setEdit] = useState(false);
  const [editKind, setEditKind] = useState('tree');
  const [obstructions, setObstructions] = useState(loadJSON('gm_obs', savedLoc ? [] : DEMO_OBSTRUCTIONS));
  const [autoTrees, setAutoTrees] = useState([]); // trees auto-detected from OpenStreetMap
  const [autoTreesOn, setAutoTreesOn] = useState(true);
  const [aiTrees, setAiTrees] = useState([]); // trees detected by on-device AI from the satellite tile
  const [aiStructures, setAiStructures] = useState([]); // buildings detected by on-device AI from the satellite tile
  const [aiStage, setAiStage] = useState('idle'); // idle | setup | analyzing | done | error
  const [aiProg, setAiProg] = useState({ pct: 0, loaded: 0, total: 0 });
  const [aiErr, setAiErr] = useState(null);

  const [selectedCell, setSelectedCell] = useState(null);
  const [imagery, setImagery] = useState([]); // [{ rel, date, url }] newest→oldest
  const [imageryIdx, setImageryIdx] = useState(0);
  const [shareOpen, setShareOpen] = useState(false);
  const [photoOpen, setPhotoOpen] = useState(false);
  const [qrUri, setQrUri] = useState(null);

  useEffect(() => {
    QRCode.toDataURL(shareUrl(), { width: 220, margin: 1 })
      .then(setQrUri)
      .catch(() => setQrUri(null));
  }, []);

  // First-time visitors: center on their real yard instead of the demo.
  // Returning visitors (savedLoc) keep the yard they were last on. Denial or
  // failure silently leaves the demo yard in place — no scary alert on launch.
  useEffect(() => {
    if (savedLoc) return; // respect a previously chosen/saved location
    let cancelled = false;
    setLocLabel('📍 Finding your yard…');
    (async () => {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== 'granted') {
          if (!cancelled) setLocLabel('Demo yard — tap 📍 for yours');
          return;
        }
        const loc = await Location.getCurrentPositionAsync({});
        if (cancelled) return;
        const la = loc.coords.latitude;
        const ln = loc.coords.longitude;
        setLat(la);
        setLng(ln);
        setZone(estimateZone(la));
        setLocLabel(`${la.toFixed(4)}, ${ln.toFixed(4)}`);
        setObstructions([]); // clear demo house/trees — this is a real place now
        setSelectedCell(null);
      } catch (e) {
        if (!cancelled) setLocLabel('Demo yard — tap 📍 for yours');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Load Esri Wayback capture dates once; default to the newest available.
  useEffect(() => {
    let cancelled = false;
    fetchWaybackReleases()
      .then((rows) => {
        if (!cancelled && rows && rows.length) {
          setImagery(rows);
          setImageryIdx(0);
        }
      })
      .catch(() => {
        /* falls back to standard Esri layer in YardMap */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const imageryUrl = imagery[imageryIdx] ? imagery[imageryIdx].url : null;
  const imageryDate = imagery[imageryIdx] ? imagery[imageryIdx].date : null;

  // Persist the user's location + placed items so a hard refresh returns to
  // their yard (not the demo) with their house/trees intact.
  useEffect(() => {
    saveJSON('gm_loc', { lat, lng, label: locLabel });
  }, [lat, lng, locLabel]);
  useEffect(() => {
    saveJSON('gm_obs', obstructions);
  }, [obstructions]);

  // Auto-load nearby building footprints whenever the pin moves a meaningful
  // distance (avoids hammering the OSM service while the user pans/zooms).
  // Cached results show INSTANTLY (stale-while-revalidate) so there's no lag on
  // revisits or hard refresh — the network fetch just quietly refreshes them.
  const lastFetch = useRef(null);
  useEffect(() => {
    const prev = lastFetch.current;
    const movedM = prev ? metersBetween(prev.lat, prev.lng, lat, lng) : Infinity;
    if (movedM < 25) return; // still analyzing essentially the same footprints
    lastFetch.current = { lat, lng };
    let cancelled = false;
    setAiTrees([]); // AI canopy is tied to the previous tile — clear on move
    setAiStructures([]);
    setAiStage('idle');

    const key = osmKey(lat, lng);
    const cached = loadJSON(key, null);
    if (cached) {
      setBuildings(cached.buildings || []);
      setAutoTrees(cached.trees || []);
      setLoadingBld(false); // instant — don't block on the network
    } else {
      setLoadingBld(true);
    }

    fetchBuildings(lat, lng)
      .then((res) => {
        if (cancelled) return;
        const b = res.buildings || [];
        const t = res.trees || [];
        if (b.length || t.length) {
          setBuildings(b);
          setAutoTrees(t);
          saveJSON(key, { buildings: b, trees: t });
        } else if (!cached) {
          // Nothing here (or the fetch failed with no prior data) — reflect
          // empty. If we DID have cache, keep it rather than clobber with empty.
          setBuildings([]);
          setAutoTrees([]);
        }
      })
      .catch(() => {
        if (!cancelled && !cached) {
          setBuildings([]);
          setAutoTrees([]);
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingBld(false);
      });
    return () => {
      cancelled = true;
    };
  }, [lat, lng]);

  // Everything that casts shade: user-placed items + auto-detected OSM trees +
  // AI-detected canopy from the satellite tile.
  const effObstructions = useMemo(
    () => [...obstructions, ...(autoTreesOn ? autoTrees : []), ...aiTrees, ...aiStructures],
    [obstructions, autoTrees, autoTreesOn, aiTrees, aiStructures]
  );

  // Is the pin sitting on a modeled structure (OSM building or a placed
  // structure)? Drives the "add my house" fallback when nothing covers it.
  const houseCovered = useMemo(() => {
    for (const b of buildings) {
      const ring = b.ring.map(([la, ln]) => toMeters(lat, lng, la, ln));
      if (pointInPoly({ e: 0, n: 0 }, ring)) return true;
    }
    for (const o of [...obstructions, ...aiStructures]) {
      if (o.type === 'structure' && metersBetween(lat, lng, o.lat, o.lng) < 10) return true;
    }
    return false;
  }, [buildings, obstructions, aiStructures, lat, lng]);

  // Live sun position for Shadows mode.
  const shadowTime = useMemo(() => timeForFraction(season, lat, lng, timeFrac), [season, lat, lng, timeFrac]);
  const sunPos = useMemo(() => sunPositionAt(shadowTime, lat, lng), [shadowTime, lat, lng]);
  const timeLabel = useMemo(
    () => shadowTime.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
    [shadowTime]
  );

  // All-day sun-hours grid for Plant zones mode (recomputes as data changes).
  const sunGrid = useMemo(() => {
    if (uiMode !== 'zones') return null;
    return computeSunGrid({ lat, lng, season, buildings, obstructions: effObstructions, gridN: GRID_N, sizeM: SIZE_M, stepMinutes: 30 });
  }, [uiMode, lat, lng, season, buildings, effObstructions]);

  async function doShare() {
    const url = shareUrl();
    const message = `Try GardenMap 🌱 — see your yard's sun & shade and find what thrives: ${url}`;
    try {
      if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.share) {
        await navigator.share({ title: 'GardenMap', text: message, url });
      } else if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(url);
        Alert.alert('Link copied', url);
      } else {
        await RNShare.share({ message, url });
      }
    } catch (e) {
      // cancelled/unsupported — no-op
    }
  }

  async function useMyLocation() {
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission needed', 'Location access lets GardenMap center on your yard and match your hardiness zone.');
        return;
      }
      const loc = await Location.getCurrentPositionAsync({});
      const la = loc.coords.latitude;
      const ln = loc.coords.longitude;
      setLat(la);
      setLng(ln);
      setZone(estimateZone(la));
      setLocLabel(`${la.toFixed(4)}, ${ln.toFixed(4)}`);
      setObstructions([]);
      setSelectedCell(null);
    } catch (e) {
      Alert.alert('Location error', String(e.message || e));
    }
  }

  function placeObstruction(la, ln) {
    const item =
      editKind === 'tree'
        ? { type: 'tree', lat: la, lng: ln, height: 6, radius: 2 }
        : { type: 'structure', lat: la, lng: ln, height: 4, radius: 2.5 };
    setObstructions((prev) => [...prev, item]);
    setSelectedCell(null);
  }

  // Tap an item on the map (in edit mode) to remove it — works for items you
  // placed and for anything the AI added.
  function removeObstruction(target) {
    setObstructions((prev) => prev.filter((o) => o !== target));
    setAiTrees((prev) => prev.filter((o) => o !== target));
    setAiStructures((prev) => prev.filter((o) => o !== target));
    setSelectedCell(null);
  }

  // When no footprints are available (e.g. OSM is rate-limited), let the user
  // drop an estimated house at the pin so shadows always have something to cast.
  function addHouseAtCenter() {
    setObstructions((prev) => [...prev, { type: 'structure', lat, lng, height: 6, radius: 6 }]);
    setSelectedCell(null);
  }

  // Scan the yard's satellite tile with the on-device AI model and add any tree
  // canopy it finds. First run downloads the model once (progress shown).
  async function scanForTrees() {
    setAiErr(null);
    setAiStage(isSegmenterReady() ? 'analyzing' : 'setup');
    try {
      const { trees } = await detectObstructions(lat, lng, SIZE_M, (p) => {
        setAiProg(p);
        if (p.status === 'analyzing' || p.status === 'ready') setAiStage('analyzing');
      });
      setAiTrees(trees);
      setAiStage('done');
    } catch (e) {
      setAiErr(String((e && e.message) || e));
      setAiStage('error');
    }
  }

  function usePhotoLocation(la, ln) {
    setLat(la);
    setLng(ln);
    setZone(estimateZone(la));
    setLocLabel(`${la.toFixed(4)}, ${ln.toFixed(4)}`);
    setObstructions([]);
    setSelectedCell(null);
  }

  // The user panned/zoomed the map — follow the new center so every result
  // (shadows, sun grid, plant zones, hardiness zone) reflects what they're
  // looking at now. Guard against no-op updates from programmatic recenters.
  function onMapRecenter(la, ln) {
    if (metersBetween(lat, lng, la, ln) < 1) return;
    setLat(la);
    setLng(ln);
    setZone(estimateZone(la));
    setLocLabel(`${la.toFixed(4)}, ${ln.toFixed(4)}`);
    setSelectedCell(null);
  }

  function inspectCell(r, c) {
    setSelectedCell({ r, c });
  }

  const cellInfo = useMemo(() => {
    if (!sunGrid || !selectedCell) return null;
    const hrs = sunGrid[selectedCell.r][selectedCell.c];
    const cls = classifySun(hrs);
    return { hrs, cls, plants: recommendPlants(cls, zone) };
  }, [sunGrid, selectedCell, zone]);

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="light" />
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.header}>
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>🌱 GardenMap</Text>
            <Text style={styles.subtitle}>See your yard's sun, shade & what thrives</Text>
          </View>
          <TouchableOpacity style={styles.shareBtn} onPress={() => setShareOpen(true)}>
            <Text style={styles.shareBtnText}>📤 Share</Text>
          </TouchableOpacity>
        </View>

        {/* Location + zone */}
        <TouchableOpacity style={styles.locBtn} onPress={useMyLocation}>
          <Text style={styles.locBtnText}>📍 {locLabel}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.photoCta} onPress={() => setPhotoOpen(true)}>
          <Text style={styles.photoCtaText}>📷 Analyze a photo of a spot</Text>
        </TouchableOpacity>
        <View style={styles.rowBetween}>
          <Text style={styles.zoneLabel}>Hardiness zone</Text>
          <View style={styles.stepper}>
            <TouchableOpacity onPress={() => setZone((z) => Math.max(1, z - 1))} style={styles.stepBtn}>
              <Text style={styles.stepText}>−</Text>
            </TouchableOpacity>
            <Text style={styles.zoneValue}>{zone}</Text>
            <TouchableOpacity onPress={() => setZone((z) => Math.min(13, z + 1))} style={styles.stepBtn}>
              <Text style={styles.stepText}>+</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Mode segmented control — tap the active one again to hide overlays. */}
        <View style={styles.segment}>
          <TouchableOpacity
            style={[styles.segBtn, uiMode === 'shadows' && styles.segActive]}
            onPress={() => {
              setUiMode((m) => (m === 'shadows' ? 'none' : 'shadows'));
              setSelectedCell(null);
            }}
          >
            <Text style={[styles.segText, uiMode === 'shadows' && styles.segTextActive]}>☀️ Shadows</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.segBtn, uiMode === 'zones' && styles.segActive]}
            onPress={() => {
              setUiMode((m) => (m === 'zones' ? 'none' : 'zones'));
              setSelectedCell(null);
            }}
          >
            <Text style={[styles.segText, uiMode === 'zones' && styles.segTextActive]}>🌱 Plant zones</Text>
          </TouchableOpacity>
        </View>
        {uiMode === 'none' && (
          <Text style={[styles.hint, { marginTop: 6 }]}>
            🛰 Clean satellite view — overlays off. Tap ☀️ Shadows or 🌱 Plant zones to bring them back.
          </Text>
        )}

        {/* Season selector */}
        <View style={styles.pillRow}>
          {SEASONS.map((s) => (
            <TouchableOpacity
              key={s}
              style={[styles.pill, season === s && styles.pillActive]}
              onPress={() => {
                setSeason(s);
                setSelectedCell(null);
              }}
            >
              <Text style={[styles.pillText, season === s && styles.pillTextActive]}>{s}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Imagery date (Esri Wayback) — defaults to newest capture */}
        {imageryDate && (
          <View style={styles.imageryRow}>
            <Text style={styles.imageryLabel}>🛰 Imagery</Text>
            <TouchableOpacity
              style={styles.imageryBtn}
              disabled={imageryIdx >= imagery.length - 1}
              onPress={() => setImageryIdx((i) => Math.min(imagery.length - 1, i + 1))}
            >
              <Text style={styles.imageryBtnText}>‹ older</Text>
            </TouchableOpacity>
            <Text style={styles.imageryDate}>
              {imageryDate}
              {imageryIdx === 0 ? '  (latest)' : ''}
            </Text>
            <TouchableOpacity
              style={styles.imageryBtn}
              disabled={imageryIdx <= 0}
              onPress={() => setImageryIdx((i) => Math.max(0, i - 1))}
            >
              <Text style={styles.imageryBtnText}>newer ›</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Map */}
        <View style={styles.canvasWrap}>
          <YardMap
            size={CANVAS}
            center={{ lat, lng }}
            imageryUrl={imageryUrl}
            imageryDate={imageryDate}
            buildings={buildings}
            obstructions={effObstructions}
            mode={uiMode}
            edit={edit}
            sunPos={sunPos}
            sunGrid={sunGrid}
            gridN={GRID_N}
            sizeM={SIZE_M}
            selectedCell={selectedCell}
            onPlace={placeObstruction}
            onRemove={removeObstruction}
            onInspect={inspectCell}
            onRecenter={onMapRecenter}
          />
          {loadingBld && (
            <View style={styles.mapBadge}>
              <ActivityIndicator color="#eaf5d9" size="small" />
              <Text style={styles.mapBadgeText}>Loading buildings…</Text>
            </View>
          )}
        </View>

        {/* Shadows: time-of-day slider */}
        {uiMode === 'shadows' && (
          <View style={styles.panel}>
            <View style={styles.rowBetween}>
              <Text style={styles.panelTitle}>🕐 {timeLabel}</Text>
              <Text style={styles.panelSub}>
                {sunPos.altitude > 0 ? `Sun ${Math.round((sunPos.altitude * 180) / Math.PI)}° up` : 'Below horizon'}
              </Text>
            </View>
            <TimeSlider value={timeFrac} onChange={setTimeFrac} width={CANVAS} />
            <View style={styles.rowBetween}>
              <Text style={styles.tick}>Sunrise</Text>
              <Text style={styles.tick}>Noon</Text>
              <Text style={styles.tick}>Sunset</Text>
            </View>
            <Text style={styles.panelSub}>
              {sunPos.altitude <= 0
                ? 'The sun is below the horizon at this time — drag toward midday.'
                : 'Drag the slider to watch shadows sweep across your yard.'}
            </Text>
            {!loadingBld && !houseCovered && aiStructures.length === 0 && (
              <View style={styles.actionRow}>
                <Text style={styles.hint}>No house outlined here — add yours so it casts a shadow.</Text>
                <TouchableOpacity style={styles.primaryBtn} onPress={addHouseAtCenter}>
                  <Text style={styles.primaryBtnText}>➕ Add my house</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        )}

        {/* Zones: inspect result or legend */}
        {uiMode === 'zones' &&
          (cellInfo ? (
            <View style={styles.panel}>
              <View style={styles.rowBetween}>
                <Text style={styles.panelTitle}>
                  {SUN_META[cellInfo.cls].label} · {cellInfo.hrs.toFixed(1)} hrs sun
                </Text>
                <View style={[styles.swatch, { backgroundColor: SUN_META[cellInfo.cls].color }]} />
              </View>
              <Text style={styles.panelSub}>Thrives here in zone {zone} ({cellInfo.plants.length}):</Text>
              <View style={styles.chipWrap}>
                {cellInfo.plants.length === 0 ? (
                  <Text style={styles.empty}>No matches — try adjusting your zone.</Text>
                ) : (
                  cellInfo.plants.map((p) => (
                    <View key={p.name} style={styles.chip}>
                      <Text style={styles.chipText}>{p.emoji} {p.name}</Text>
                      <Text style={styles.chipSub}>{p.kind} · {p.water} water</Text>
                    </View>
                  ))
                )}
              </View>
            </View>
          ) : (
            <View style={styles.panel}>
              <Text style={styles.panelTitle}>Sunlight legend</Text>
              {Object.entries(SUN_META).map(([k, v]) => (
                <View key={k} style={styles.legendRow}>
                  <View style={[styles.swatch, { backgroundColor: v.color }]} />
                  <Text style={styles.legendText}>{v.label} — {v.sub}</Text>
                </View>
              ))}
              <Text style={styles.panelSub}>Tap any colored square to see what grows there.</Text>
              <View style={styles.legendRow}>
                <TouchableOpacity
                  style={[styles.pill, autoTreesOn && styles.pillActive]}
                  onPress={() => setAutoTreesOn((v) => !v)}
                >
                  <Text style={[styles.pillText, autoTreesOn && styles.pillTextActive]}>
                    🌳 Auto-detect trees {autoTreesOn ? 'on' : 'off'}
                  </Text>
                </TouchableOpacity>
                <Text style={[styles.legendText, { marginLeft: 8 }]}>
                  {autoTrees.length > 0
                    ? `${autoTrees.length} found from OpenStreetMap`
                    : loadingBld
                    ? 'checking the map…'
                    : 'none mapped here — add with ✏️'}
                </Text>
              </View>

              {isVisionSupported() && (
                <View style={styles.aiBox}>
                  {aiStage === 'idle' && (
                    <>
                      <TouchableOpacity style={styles.aiBtn} onPress={scanForTrees}>
                        <Text style={styles.aiBtnText}>✨ AI: scan satellite for tree canopy</Text>
                      </TouchableOpacity>
                      <Text style={styles.aiFine}>
                        Spots your house and tree canopy right from the aerial image — even when OpenStreetMap
                        has no outline — so they cast real shade. Runs on your device; first run downloads a
                        small model (~15 MB) once, then it's instant.
                      </Text>
                    </>
                  )}
                  {(aiStage === 'setup' || aiStage === 'analyzing') && (
                    <View style={styles.aiCard}>
                      <Text style={styles.aiTitle}>
                        {aiStage === 'setup' ? '✨ Setting up on-device AI' : '✨ Scanning the satellite tile…'}
                      </Text>
                      <Text style={styles.aiFine}>
                        {aiStage === 'setup'
                          ? "One-time download — cached on this device afterwards, so it's instant next time. Nothing is uploaded."
                          : 'Finding your house and tree canopy in the aerial image on your device.'}
                      </Text>
                      <View style={styles.aiTrack}>
                        <View
                          style={[
                            styles.aiFill,
                            { width: `${aiStage === 'analyzing' ? 100 : Math.max(4, Math.round((aiProg.pct || 0) * 100))}%` },
                          ]}
                        />
                      </View>
                      <Text style={styles.aiMeta}>
                        {aiStage === 'setup'
                          ? aiProg.total
                            ? `${(aiProg.loaded / 1e6).toFixed(1)} / ${(aiProg.total / 1e6).toFixed(1)} MB`
                            : 'starting…'
                          : 'almost there…'}
                      </Text>
                    </View>
                  )}
                  {aiStage === 'done' && (
                    <View style={styles.aiCard}>
                      <Text style={styles.aiTitle}>
                        {aiTrees.length > 0
                          ? `✨ AI added ${aiTrees.length} tree${aiTrees.length === 1 ? '' : 's'}`
                          : '✨ No canopy found'}
                      </Text>
                      <Text style={styles.aiFine}>
                        {aiTrees.length > 0
                          ? 'Shade from this canopy is now in the plant zones. Buildings come from the map itself; tap ✏️ to nudge or remove anything.'
                          : "The AI didn't spot tree canopy over this yard. You can still drop trees with ✏️."}
                      </Text>
                      <TouchableOpacity style={styles.aiBtnGhost} onPress={scanForTrees}>
                        <Text style={styles.aiBtnGhostText}>↺ Re-scan</Text>
                      </TouchableOpacity>
                    </View>
                  )}
                  {aiStage === 'error' && (
                    <View style={styles.aiCard}>
                      <Text style={styles.aiFine}>Couldn't run the AI here{aiErr ? ` (${aiErr})` : ''}.</Text>
                      <TouchableOpacity style={styles.aiBtnGhost} onPress={scanForTrees}>
                        <Text style={styles.aiBtnGhostText}>↺ Try again</Text>
                      </TouchableOpacity>
                    </View>
                  )}
                </View>
              )}
              {!loadingBld && !houseCovered && aiStructures.length === 0 && (
                <View style={styles.actionRow}>
                  <Text style={styles.hint}>Your house isn't outlined here, so it may read as full sun. Center the pin on it and add it.</Text>
                  <TouchableOpacity style={styles.primaryBtn} onPress={addHouseAtCenter}>
                    <Text style={styles.primaryBtnText}>➕ Add my house</Text>
                  </TouchableOpacity>
                </View>
              )}
              <Text style={[styles.hint, { flex: undefined, marginTop: 8 }]}>🌳 See a tree we missed? Tap ✏️ Edit → Tree and drop it — its canopy adds dappled shade, so the ground below reads part-shade, not full sun.</Text>
            </View>
          ))}

        {/* Edit tools */}
        <View style={styles.rowBetween}>
          <TouchableOpacity
            style={[styles.editToggle, edit && styles.editToggleOn]}
            onPress={() => setEdit((e) => !e)}
          >
            <Text style={[styles.editToggleText, edit && styles.editToggleTextOn]}>
              ✏️ Edit {edit ? 'on' : 'off'}
            </Text>
          </TouchableOpacity>
          {edit && (
            <View style={styles.pillRow}>
              <TouchableOpacity
                style={[styles.pill, editKind === 'tree' && styles.pillActive]}
                onPress={() => setEditKind('tree')}
              >
                <Text style={[styles.pillText, editKind === 'tree' && styles.pillTextActive]}>🌳 Tree</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.pill, editKind === 'structure' && styles.pillActive]}
                onPress={() => setEditKind('structure')}
              >
                <Text style={[styles.pillText, editKind === 'structure' && styles.pillTextActive]}>🏠 Structure</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>
        {edit && (
          <View style={styles.actionRow}>
            <Text style={styles.hint}>Tap the map to drop a {editKind}; tap any tree or house to remove it. Trees ≈ 6 m, structures ≈ 4 m.</Text>
            <TouchableOpacity style={styles.secondaryBtn} onPress={() => setObstructions((p) => p.slice(0, -1))}>
              <Text style={styles.secondaryBtnText}>↩︎ Undo</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.secondaryBtn} onPress={() => setObstructions([])}>
              <Text style={styles.secondaryBtnText}>🗑 Clear</Text>
            </TouchableOpacity>
          </View>
        )}

        <Text style={styles.footer}>
          Imagery © Esri, Maxar, Earthstar Geographics{imageryDate ? ` (captured ${imageryDate})` : ''} · Buildings © OpenStreetMap contributors.
          Shadows are modeled from building heights & sun angle — a planning aid, not a survey.
        </Text>
      </ScrollView>

      <PhotoAnalyzer
        visible={photoOpen}
        onClose={() => setPhotoOpen(false)}
        zone={zone}
        onUseLocation={usePhotoLocation}
      />

      <Modal visible={shareOpen} transparent animationType="fade" onRequestClose={() => setShareOpen(false)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Share the GardenMap test app</Text>
            <Text style={styles.modalSub}>Scan to open it on any phone — runs in the browser, no install.</Text>
            {qrUri ? (
              <Image source={{ uri: qrUri }} style={styles.qr} />
            ) : (
              <ActivityIndicator color="#7cb342" style={{ height: 220 }} />
            )}
            <Text selectable style={styles.urlText}>{shareUrl()}</Text>
            <TouchableOpacity style={styles.modalPrimary} onPress={doShare}>
              <Text style={styles.modalPrimaryText}>
                {Platform.OS === 'web' ? '🔗 Share / copy link' : '🔗 Share link'}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.modalClose} onPress={() => setShareOpen(false)}>
              <Text style={styles.modalCloseText}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#20331f' },
  scroll: { padding: 16, paddingBottom: 40 },
  header: { flexDirection: 'row', alignItems: 'center', marginBottom: 14 },
  shareBtn: { backgroundColor: '#7cb342', paddingVertical: 8, paddingHorizontal: 12, borderRadius: 10 },
  shareBtnText: { color: '#12240f', fontWeight: '700' },
  title: { fontSize: 30, fontWeight: '800', color: '#eaf5d9' },
  subtitle: { fontSize: 13, color: '#a9c48b' },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  locBtn: { backgroundColor: '#2f4a2c', padding: 12, borderRadius: 10, alignItems: 'center', marginBottom: 8 },
  locBtnText: { color: '#dcecc7', fontWeight: '600' },
  zoneLabel: { color: '#cfe3b4', fontWeight: '600', fontSize: 15 },
  stepper: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#2f4a2c', borderRadius: 10 },
  stepBtn: { paddingHorizontal: 16, paddingVertical: 8 },
  stepText: { color: '#eaf5d9', fontSize: 20, fontWeight: '700' },
  zoneValue: { color: '#fff', fontSize: 17, fontWeight: '700', minWidth: 28, textAlign: 'center' },
  segment: { flexDirection: 'row', backgroundColor: '#2f4a2c', borderRadius: 12, padding: 4, marginBottom: 10 },
  segBtn: { flex: 1, paddingVertical: 10, borderRadius: 9, alignItems: 'center' },
  segActive: { backgroundColor: '#7cb342' },
  segText: { color: '#cfe3b4', fontWeight: '700', fontSize: 14 },
  segTextActive: { color: '#12240f' },
  pillRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 8 },
  pill: { paddingVertical: 8, paddingHorizontal: 14, borderRadius: 20, backgroundColor: '#2f4a2c' },
  pillActive: { backgroundColor: '#7cb342' },
  pillText: { color: '#cfe3b4', fontWeight: '600' },
  pillTextActive: { color: '#12240f' },
  aiBox: { marginTop: 10, gap: 6 },
  aiBtn: { backgroundColor: '#6a4bd6', paddingVertical: 12, paddingHorizontal: 14, borderRadius: 12, alignItems: 'center' },
  aiBtnText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  aiFine: { color: '#c3b8e6', fontSize: 12, lineHeight: 17 },
  aiCard: { backgroundColor: '#241a3d', borderColor: '#5a3fb0', borderWidth: 1, borderRadius: 14, padding: 14, gap: 8 },
  aiTitle: { color: '#eaf5d9', fontWeight: '800', fontSize: 15 },
  aiTrack: { height: 12, borderRadius: 999, backgroundColor: '#0f1a0c', borderColor: '#2f4a2c', borderWidth: 1, overflow: 'hidden' },
  aiFill: { height: '100%', borderRadius: 999, backgroundColor: '#b452c9', minWidth: 8 },
  aiMeta: { color: '#9fb47f', fontSize: 12, textAlign: 'right' },
  aiBtnGhost: { backgroundColor: '#20301a', borderColor: '#2f4a2c', borderWidth: 1, borderRadius: 10, paddingVertical: 8, alignItems: 'center' },
  aiBtnGhostText: { color: '#dcecc7', fontWeight: '600' },
  hint: { color: '#9fbb80', fontSize: 12, fontStyle: 'italic', flex: 1 },
  canvasWrap: { alignItems: 'center', marginBottom: 12 },
  mapBadge: { position: 'absolute', top: 10, left: 10, flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: 'rgba(20,36,15,0.8)', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8 },
  mapBadgeText: { color: '#eaf5d9', fontSize: 12, fontWeight: '600' },
  actionRow: { flexDirection: 'row', gap: 8, marginBottom: 16, alignItems: 'center' },
  secondaryBtn: { backgroundColor: '#2f4a2c', padding: 10, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  secondaryBtnText: { color: '#dcecc7', fontWeight: '600' },
  primaryBtn: { backgroundColor: '#7cb342', paddingVertical: 10, paddingHorizontal: 14, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  primaryBtnText: { color: '#12240f', fontWeight: '700' },
  photoCta: { backgroundColor: '#20301a', borderColor: '#3a5a34', borderWidth: 1, borderRadius: 12, padding: 12, alignItems: 'center', marginTop: 8 },
  photoCtaText: { color: '#cfe6ad', fontWeight: '700', fontSize: 15 },
  editToggle: { backgroundColor: '#2f4a2c', paddingVertical: 10, paddingHorizontal: 16, borderRadius: 10 },
  editToggleOn: { backgroundColor: '#f4a825' },
  editToggleText: { color: '#dcecc7', fontWeight: '700' },
  editToggleTextOn: { color: '#3a2a00' },
  tick: { color: '#9fbb80', fontSize: 11 },
  panel: { backgroundColor: '#2a3f27', borderRadius: 14, padding: 16, marginBottom: 14 },
  panelTitle: { color: '#eaf5d9', fontSize: 16, fontWeight: '700', marginBottom: 6 },
  panelSub: { color: '#a9c48b', fontSize: 13, marginTop: 6, marginBottom: 8 },
  legendRow: { flexDirection: 'row', alignItems: 'center', marginVertical: 3 },
  swatch: { width: 20, height: 20, borderRadius: 5, marginRight: 10 },
  legendText: { color: '#cfe3b4', fontSize: 13 },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { backgroundColor: '#37532f', borderRadius: 10, paddingVertical: 8, paddingHorizontal: 12 },
  chipText: { color: '#eaf5d9', fontWeight: '700', fontSize: 14 },
  chipSub: { color: '#9fbb80', fontSize: 11 },
  empty: { color: '#c9a', fontStyle: 'italic' },
  footer: { color: '#7f9a63', fontSize: 11, textAlign: 'center', marginTop: 4 },
  imageryRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 4, marginBottom: 2 },
  imageryLabel: { color: '#9fb47f', fontSize: 12, fontWeight: '600' },
  imageryBtn: { backgroundColor: '#20301a', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4 },
  imageryBtnText: { color: '#cfe6ad', fontSize: 12, fontWeight: '600' },
  imageryDate: { color: '#eaf5d9', fontSize: 12, fontWeight: '700', minWidth: 118, textAlign: 'center' },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', alignItems: 'center', padding: 24 },
  modalCard: { backgroundColor: '#2a3f27', borderRadius: 16, padding: 20, width: '100%', maxWidth: 340, alignItems: 'center' },
  modalTitle: { color: '#eaf5d9', fontSize: 18, fontWeight: '800', textAlign: 'center' },
  modalSub: { color: '#a9c48b', fontSize: 13, textAlign: 'center', marginTop: 6, marginBottom: 14 },
  qr: { width: 220, height: 220, borderRadius: 10, backgroundColor: '#fff' },
  urlText: { color: '#cfe3b4', fontSize: 12, marginTop: 12, textAlign: 'center' },
  modalPrimary: { backgroundColor: '#f4a825', borderRadius: 10, paddingVertical: 12, paddingHorizontal: 20, marginTop: 16, alignSelf: 'stretch', alignItems: 'center' },
  modalPrimaryText: { color: '#3a2a00', fontWeight: '800', fontSize: 15 },
  modalClose: { paddingVertical: 10, marginTop: 4 },
  modalCloseText: { color: '#9fbb80', fontWeight: '600' },
});
