import React, { useEffect, useRef, useState } from 'react';
import { Modal } from 'react-native';

import { analyzeLight, analyzePhoto, aspectFromHeading } from './photo.web';
import { estimateZone, recommendPlants } from './plants';
import { SUN_META } from './solar';
import { computeSeasonSun, currentSeason } from './seasons';
import { analyzeSpot, isSegmenterReady, isVisionSupported } from './vision';

const C = {
  bg: '#0f1a0c',
  panel: '#182611',
  chip: '#20301a',
  text: '#eaf5d9',
  sub: '#9fb47f',
  accent: '#7cb342',
  line: '#2f4a2c',
};

function getLoc() {
  return new Promise((res) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) return res(null);
    navigator.geolocation.getCurrentPosition(
      (p) => res({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => res(null),
      { enableHighAccuracy: true, timeout: 6000, maximumAge: 60000 }
    );
  });
}

// Blend from shade (cool slate) to full sun (gold) by lit factor 0..1.
function cellColor(cell) {
  if (!cell.up) return '#0c1408'; // sun below horizon
  const t = Math.max(0, Math.min(1, cell.lit));
  const a = [47, 74, 44], b = [244, 196, 48]; // #2f4a2c → #f4c430
  const c = a.map((v, i) => Math.round(v + (b[i] - v) * t));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

function hourLabel(h) {
  const ampm = h < 12 ? 'a' : 'p';
  const hr = h % 12 === 0 ? 12 : h % 12;
  return `${hr}${ampm}`;
}

export default function PhotoAnalyzer({ visible, onClose, zone, onUseLocation }) {
  const [stage, setStage] = useState('start'); // start | camera | analyzing | report
  const [heading, setHeading] = useState(null);
  const [tilt, setTilt] = useState(null);
  const [orientBlocked, setOrientBlocked] = useState(false);
  const [report, setReport] = useState(null);
  const [err, setErr] = useState(null);
  const [aiNote, setAiNote] = useState(false);

  // On-device AI (segmentation) state.
  const [aiStage, setAiStage] = useState('idle'); // idle | setup | analyzing | done | error
  const [aiProg, setAiProg] = useState({ pct: 0, loaded: 0, total: 0 });
  const [aiResult, setAiResult] = useState(null);
  const [aiErr, setAiErr] = useState(null);

  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const orientHandler = useRef(null);

  function handleOrient(e) {
    let h = null;
    if (typeof e.webkitCompassHeading === 'number') h = e.webkitCompassHeading;
    else if (typeof e.alpha === 'number') h = 360 - e.alpha;
    if (h != null) setHeading(((h % 360) + 360) % 360);
    if (typeof e.beta === 'number') setTilt(Math.round(e.beta));
  }

  async function enableOrientation() {
    try {
      const DOE = typeof DeviceOrientationEvent !== 'undefined' ? DeviceOrientationEvent : null;
      if (DOE && typeof DOE.requestPermission === 'function') {
        const res = await DOE.requestPermission();
        if (res !== 'granted') { setOrientBlocked(true); return; }
      }
      const evt = 'ondeviceorientationabsolute' in window ? 'deviceorientationabsolute' : 'deviceorientation';
      orientHandler.current = handleOrient;
      window.addEventListener(evt, handleOrient, true);
    } catch {
      setOrientBlocked(true);
    }
  }

  function stopCamera() {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (orientHandler.current) {
      window.removeEventListener('deviceorientation', orientHandler.current, true);
      window.removeEventListener('deviceorientationabsolute', orientHandler.current, true);
      orientHandler.current = null;
    }
  }

  useEffect(() => {
    if (!visible) { stopCamera(); reset(); }
    return () => stopCamera();
  }, [visible]);

  useEffect(() => {
    if (stage === 'camera' && videoRef.current && streamRef.current) {
      videoRef.current.srcObject = streamRef.current;
      videoRef.current.play?.().catch(() => {});
    }
  }, [stage]);

  function reset() {
    setStage('start'); setReport(null); setErr(null);
    setHeading(null); setTilt(null); setOrientBlocked(false); setAiNote(false);
    setAiStage('idle'); setAiResult(null); setAiErr(null); setAiProg({ pct: 0, loaded: 0, total: 0 });
  }

  // Run the on-device segmentation model on the captured/uploaded image. Shows a
  // one-time model-download experience the first time, then instant thereafter.
  async function runAi() {
    if (!report || !report.aiSrc) return;
    setAiErr(null);
    setAiStage(isSegmenterReady() ? 'analyzing' : 'setup');
    try {
      const res = await analyzeSpot(report.aiSrc, (p) => {
        setAiProg(p);
        if (p.status === 'analyzing' || p.status === 'ready') setAiStage('analyzing');
      });
      setAiResult(res);
      setAiStage('done');
    } catch (e) {
      setAiErr(String((e && e.message) || e));
      setAiStage('error');
    }
  }

  async function startCamera() {
    setErr(null);
    await enableOrientation();
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      });
      streamRef.current = s;
      setStage('camera');
    } catch {
      setErr('Camera not available here — upload a photo instead.');
    }
  }

  async function snap() {
    const v = videoRef.current;
    if (!v || !v.videoWidth) return;
    const cvs = document.createElement('canvas');
    cvs.width = v.videoWidth; cvs.height = v.videoHeight;
    cvs.getContext('2d').drawImage(v, 0, 0);
    setStage('analyzing');
    const light = await analyzeLight(cvs);
    const aiSrc = cvs.toDataURL('image/jpeg', 0.9);
    const loc = await getLoc();
    const lat = loc ? loc.lat : null;
    const lng = loc ? loc.lng : null;
    const z = lat != null ? estimateZone(lat) : zone;
    const aspect = aspectFromHeading(heading, lat != null ? lat : 40);
    stopCamera();
    setReport({
      ...light, aiSrc, lat, lng, heading, tilt, aspect, zone: z,
      when: new Date(), plants: recommendPlants(light.lightClass, z), source: 'camera',
      seasons: lat != null ? computeSeasonSun({ lat, lng, aspect: aspect ? aspect.deg : null }) : null,
    });
    setStage('report');
  }

  async function onFile(e) {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    setStage('analyzing');
    try {
      const r = await analyzePhoto(f);
      const aiSrc = URL.createObjectURL(f);
      let lat = r.exif && r.exif.lat != null ? r.exif.lat : null;
      let lng = r.exif && r.exif.lng != null ? r.exif.lng : null;
      let locApprox = false;
      if (lat == null) {
        const loc = await getLoc(); // photo had no GPS → use device location
        if (loc) { lat = loc.lat; lng = loc.lng; locApprox = true; }
      }
      const z = lat != null ? estimateZone(lat) : zone;
      setReport({
        ...r, aiSrc, lat, lng, locApprox,
        heading: r.exif ? r.exif.heading : null,
        aspect: r.exif ? r.exif.aspect : null,
        zone: z, when: r.exif ? r.exif.when : null,
        plants: recommendPlants(r.lightClass, z), source: 'upload',
        seasons: lat != null
          ? computeSeasonSun({ lat, lng, aspect: r.exif && r.exif.aspect ? r.exif.aspect.deg : null })
          : null,
      });
      setStage('report');
    } catch {
      setErr('Could not read that image. Try another photo.');
      setStage('start');
    }
    e.target.value = '';
  }

  const meta = report ? SUN_META[report.lightClass] : null;
  const nowSeason = report && report.seasons ? currentSeason(new Date(report.when || Date.now()), report.lat ?? 40) : null;
  const hourLabels = report && report.seasons ? report.seasons.hoursFrom : 5;

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <div style={S.root}>
        <style>{AI_KEYFRAMES}</style>
        <div style={S.header}>
          <span style={S.title}>📷 Analyze a spot</span>
          <button style={S.close} onClick={onClose}>✕</button>
        </div>
        <div style={S.scroll}>
          {stage === 'start' && (
            <>
              <p style={S.lead}>
                Point your camera at a bed, border, or wall. GardenMap reads the light and — if your phone
                allows it — captures the exact spot and the direction it faces.
              </p>
              <button style={S.primary} onClick={startCamera}>📷 Open camera</button>
              <label style={S.secondary}>
                🖼 Upload a photo instead
                <input type="file" accept="image/*" onChange={onFile} style={{ display: 'none' }} />
              </label>
              {err && <p style={S.err}>{err}</p>}
              <p style={S.fine}>
                Everything runs on your device — the photo isn’t uploaded. Deeper AI plant ID & health is coming
                as an opt-in.
              </p>
            </>
          )}

          {stage === 'camera' && (
            <>
              <div style={S.viewWrap}>
                <video ref={videoRef} playsInline muted style={S.video} />
                <div style={S.hud}>
                  <span>{heading != null ? `🧭 ${aspectFromHeading(heading).facing} (${Math.round(heading)}°)` : '🧭 compass…'}</span>
                  <span>{tilt != null ? `📐 ${tilt}°` : ''}</span>
                </div>
              </div>
              {orientBlocked && (
                <p style={S.fine}>Compass permission was blocked — you’ll still get the light read; aspect will be estimated.</p>
              )}
              <button style={S.primary} onClick={snap}>◉ Capture &amp; analyze</button>
              <button style={S.secondary} onClick={() => { stopCamera(); reset(); }}>Cancel</button>
            </>
          )}

          {stage === 'analyzing' && <p style={S.lead}>Analyzing light &amp; sensors…</p>}

          {stage === 'report' && report && (
            <>
              <img src={report.overlayUrl} alt="analyzed" style={S.overlay} />
              <div style={S.legendRow}>
                <span style={{ ...S.badge, background: '#f4c430', color: '#3a2b00' }}>☀️ Sun {report.sunPct}%</span>
                <span style={{ ...S.badge, background: '#2f5d80' }}>🌑 Shade {report.shadePct}%</span>
              </div>

              <div style={S.card}>
                <div style={S.verdict}>
                  <span style={{ ...S.swatch, background: meta.color }} />
                  <span style={S.verdictText}>{meta.label}</span>
                  <span style={S.verdictSub}>{meta.sub}</span>
                </div>
                {report.aspect ? (
                  <p style={S.aspect}><b>{report.aspect.label}</b> — {report.aspect.note}</p>
                ) : (
                  <p style={S.fine}>No compass heading captured — aspect unknown. Face the bed and retake, or set it on the map.</p>
                )}
                <div style={S.factRow}>
                  {report.lat != null && <span style={S.fact}>📍 {report.lat.toFixed(4)}, {report.lng.toFixed(4)} · zone {report.zone}{report.locApprox ? ' (approx)' : ''}</span>}
                  {report.when && <span style={S.fact}>🕐 {new Date(report.when).toLocaleString([], { hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric' })}</span>}
                </div>
                {report.lat != null && (
                  <button style={S.secondary} onClick={() => { onUseLocation(report.lat, report.lng); onClose(); }}>
                    📍 Use this spot on the map
                  </button>
                )}
              </div>

              <p style={S.sectionTitle}>Thrives in {meta.label.toLowerCase()} · zone {report.zone} ({report.plants.length})</p>
              <div style={S.chipWrap}>
                {report.plants.length === 0
                  ? <span style={S.fine}>No matches — adjust your zone on the map.</span>
                  : report.plants.map((p) => (
                      <div key={p.name} style={S.chip}>
                        <div style={S.chipName}>{p.emoji} {p.name}</div>
                        <div style={S.chipSub}>{p.kind} · {p.water} water</div>
                      </div>
                    ))}
              </div>

              {isVisionSupported() && (
                <div style={S.aiWrap}>
                  {aiStage === 'idle' && (
                    <>
                      <button style={S.ai} onClick={runAi}>✨ Deeper AI analysis — read this scene on-device</button>
                      <p style={S.fine}>
                        Uses a small open-source vision model that runs <b>entirely on your device</b> — your photo is
                        never uploaded. First run downloads it once (~15&nbsp;MB); after that it’s instant.
                      </p>
                    </>
                  )}

                  {(aiStage === 'setup' || aiStage === 'analyzing') && (
                    <div style={S.aiCard}>
                      <div style={S.aiSpark}>✨</div>
                      <div style={S.aiTitle}>
                        {aiStage === 'setup' ? 'Setting up on-device AI' : 'Reading the scene…'}
                      </div>
                      <div style={S.aiSub}>
                        {aiStage === 'setup'
                          ? 'One-time download — it’s then cached on this device, so next time is instant. Nothing is uploaded.'
                          : 'Segmenting sky, canopy, structures and ground on your device.'}
                      </div>
                      <div style={S.barTrack}>
                        <div
                          style={{
                            ...S.barFill,
                            width: aiStage === 'analyzing' ? '100%' : `${Math.max(4, Math.round((aiProg.pct || 0) * 100))}%`,
                            ...(aiStage === 'analyzing' ? S.barPulse : null),
                          }}
                        />
                        <div style={S.barShimmer} />
                      </div>
                      <div style={S.aiMeta}>
                        {aiStage === 'setup'
                          ? aiProg.total
                            ? `${(aiProg.loaded / 1e6).toFixed(1)} / ${(aiProg.total / 1e6).toFixed(1)} MB`
                            : 'starting…'
                          : 'almost there…'}
                      </div>
                    </div>
                  )}

                  {aiStage === 'error' && (
                    <div style={S.aiCard}>
                      <div style={S.aiSub}>Couldn’t run the AI here{aiErr ? ` (${aiErr})` : ''}.</div>
                      <button style={S.secondary} onClick={runAi}>↺ Try again</button>
                    </div>
                  )}

                  {aiStage === 'done' && aiResult && (
                    <div style={S.aiCard}>
                      <div style={S.aiTitle}>✨ AI scene read</div>
                      {aiResult.lowSky ? (
                        <p style={S.aiSub}>
                          Barely any sky in this frame, so I can’t judge openness from it. Include the sky above the
                          spot (tilt up) and re-shoot for a sun estimate — the composition below is still useful.
                        </p>
                      ) : (
                        <div style={S.aiVerdict}>
                          <span style={{ ...S.swatch, background: (SUN_META[aiResult.lightClass] || {}).color || '#7cb342' }} />
                          <b>{(SUN_META[aiResult.lightClass] || {}).label || '—'}</b>
                          <span style={S.aiOpen}>{aiResult.openness}% open sky</span>
                        </div>
                      )}
                      {!aiResult.lowSky && aiResult.openness !== report.sunPct && (
                        <p style={S.fine}>
                          Quick read said {report.sunPct}% sun from brightness; the AI separates real sky from
                          shadowed ground &amp; soil, so <b>{aiResult.openness}%</b> is the openness that actually
                          drives sun here.
                        </p>
                      )}
                      <div style={S.breakWrap}>
                        {[
                          ['☀️ Open sky', aiResult.sky, '#f4c430'],
                          ['🌳 Canopy', aiResult.canopy, '#2e7d32'],
                          ['🏠 Structures', aiResult.structure, '#8d6e63'],
                          ['🟫 Ground', aiResult.ground, '#5d7a4a'],
                        ].map(([label, pct, color]) => (
                          <div key={label} style={S.breakRow}>
                            <span style={S.breakLabel}>{label}</span>
                            <div style={S.breakTrack}>
                              <div style={{ ...S.breakFill, width: `${Math.min(100, pct)}%`, background: color }} />
                            </div>
                            <span style={S.breakPct}>{pct}%</span>
                          </div>
                        ))}
                      </div>
                      <p style={S.fine}>
                        Ground (soil &amp; lawn) is excluded from the sun estimate — that’s what fixes the old skew
                        where dark dirt read as shade. Runs 100% on your device.
                      </p>
                    </div>
                  )}
                </div>
              )}

              {report.seasons ? (
                <>
                  <p style={S.sectionTitle}>Sun through the year at this spot</p>
                  <p style={S.fine}>
                    Modeled from your latitude{report.aspect ? ` and the bed's ${report.aspect.facing}-facing aspect` : ' (open-sky estimate — no compass captured)'} using
                    the same sun engine as the map. Assumes clear sky; nearby walls &amp; trees aren’t included here.
                  </p>
                  <div style={S.heat}>
                    <div style={S.heatHead}>
                      <span style={S.heatRowLabel} />
                      <div style={S.heatCells}>
                        {report.seasons.seasons[0].cells.map((c) => (
                          <span key={c.hour} style={S.heatHour}>{c.hour % 3 === 0 ? hourLabel(c.hour) : ''}</span>
                        ))}
                      </div>
                      <span style={S.heatHours}>hrs</span>
                    </div>
                    {report.seasons.seasons.map((s) => (
                      <div key={s.season} style={{ ...S.heatRow, ...(s.season === nowSeason ? S.heatRowNow : null) }}>
                        <span style={S.heatRowLabel}>{s.season === nowSeason ? '▸ ' : ''}{s.season}</span>
                        <div style={S.heatCells}>
                          {s.cells.map((c) => (
                            <span key={c.hour} title={`${hourLabel(c.hour)} · ${Math.round(c.lit * 100)}% sun`}
                              style={{ ...S.heatCell, background: cellColor(c) }} />
                          ))}
                        </div>
                        <span style={{ ...S.heatHours, color: s.meta.color }}>{s.directHours}h</span>
                      </div>
                    ))}
                  </div>
                  <div style={S.legend2}>
                    <span><span style={{ ...S.dot, background: '#2f4a2c' }} /> shade</span>
                    <span><span style={{ ...S.dot, background: '#a7d96b' }} /> partial</span>
                    <span><span style={{ ...S.dot, background: '#f4c430' }} /> full sun</span>
                    <span><span style={{ ...S.dot, background: '#0c1408', border: `1px solid ${C.line}` }} /> sun down</span>
                  </div>
                  <p style={S.fine}>
                    Summer gives the longest days and highest sun; winter the shortest and lowest. For shadows from
                    your actual house &amp; trees, open this spot on the map.
                  </p>
                </>
              ) : (
                <p style={S.fine}>
                  📍 Capture or allow location to unlock the seasonal &amp; time-of-day deep-dive for this exact spot.
                </p>
              )}

              <p style={S.fine}>
                The photo above reads a single moment of light. The chart estimates the whole year from the sun’s
                path — together they tell you both what’s true right now and what to expect.
              </p>
              <button style={S.primary} onClick={reset}>↺ Analyze another spot</button>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

const AI_KEYFRAMES = `
@keyframes gm-shimmer { 0% { transform: translateX(-100%); } 100% { transform: translateX(300%); } }
@keyframes gm-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.55; } }
@keyframes gm-float { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-4px); } }
@keyframes gm-grow { from { transform: scaleX(0); } to { transform: scaleX(1); } }
`;

const S = {
  root: { display: 'flex', flexDirection: 'column', height: '100%', background: C.bg, color: C.text, fontFamily: 'system-ui, sans-serif' },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px', borderBottom: `1px solid ${C.line}` },
  title: { fontSize: 18, fontWeight: 700 },
  close: { background: 'transparent', border: 'none', color: C.text, fontSize: 20, cursor: 'pointer' },
  scroll: { flex: 1, overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 12 },
  lead: { color: C.sub, fontSize: 15, lineHeight: 1.4, margin: 0 },
  fine: { color: C.sub, fontSize: 12, lineHeight: 1.4, margin: '4px 0' },
  err: { color: '#ff9a76', fontSize: 13, margin: '4px 0' },
  primary: { background: C.accent, color: '#12240f', border: 'none', borderRadius: 12, padding: '14px', fontSize: 16, fontWeight: 700, cursor: 'pointer' },
  secondary: { background: C.chip, color: C.text, border: `1px solid ${C.line}`, borderRadius: 12, padding: '12px', fontSize: 15, fontWeight: 600, cursor: 'pointer', textAlign: 'center', display: 'block' },
  ai: { background: 'linear-gradient(90deg,#6a4bd6,#b452c9)', color: '#fff', border: 'none', borderRadius: 12, padding: '12px', fontSize: 15, fontWeight: 700, cursor: 'pointer' },
  viewWrap: { position: 'relative', borderRadius: 14, overflow: 'hidden', background: '#000' },
  video: { width: '100%', display: 'block', maxHeight: '60vh', objectFit: 'cover' },
  hud: { position: 'absolute', top: 8, left: 8, right: 8, display: 'flex', justifyContent: 'space-between', color: '#fff', fontSize: 13, fontWeight: 700, textShadow: '0 1px 3px #000' },
  overlay: { width: '100%', borderRadius: 14, display: 'block' },
  legendRow: { display: 'flex', gap: 8 },
  badge: { color: '#fff', borderRadius: 999, padding: '4px 10px', fontSize: 13, fontWeight: 700 },
  card: { background: C.panel, borderRadius: 14, padding: 14, display: 'flex', flexDirection: 'column', gap: 8 },
  verdict: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  swatch: { width: 16, height: 16, borderRadius: 4, display: 'inline-block' },
  verdictText: { fontSize: 17, fontWeight: 800 },
  verdictSub: { color: C.sub, fontSize: 13 },
  aspect: { fontSize: 14, lineHeight: 1.4, margin: 0 },
  factRow: { display: 'flex', flexWrap: 'wrap', gap: 8 },
  fact: { color: C.sub, fontSize: 12 },
  sectionTitle: { fontSize: 14, fontWeight: 700, margin: '4px 0 0' },
  chipWrap: { display: 'flex', flexWrap: 'wrap', gap: 8 },
  chip: { background: C.chip, borderRadius: 10, padding: '8px 10px' },
  chipName: { fontSize: 14, fontWeight: 600 },
  chipSub: { color: C.sub, fontSize: 11 },
  heat: { display: 'flex', flexDirection: 'column', gap: 3, background: C.panel, borderRadius: 12, padding: 10 },
  heatHead: { display: 'flex', alignItems: 'center', gap: 6 },
  heatRow: { display: 'flex', alignItems: 'center', gap: 6, borderRadius: 6, padding: '2px 2px' },
  heatRowNow: { background: '#1f331a' },
  heatRowLabel: { width: 52, flexShrink: 0, fontSize: 12, fontWeight: 700, color: C.text },
  heatCells: { display: 'flex', flex: 1, gap: 2 },
  heatCell: { flex: 1, height: 16, borderRadius: 2 },
  heatHour: { flex: 1, fontSize: 9, color: C.sub, textAlign: 'center', overflow: 'hidden' },
  heatHours: { width: 30, flexShrink: 0, fontSize: 12, fontWeight: 700, textAlign: 'right' },
  legend2: { display: 'flex', flexWrap: 'wrap', gap: 12, color: C.sub, fontSize: 11 },
  dot: { display: 'inline-block', width: 10, height: 10, borderRadius: 2, marginRight: 4, verticalAlign: 'middle' },

  aiWrap: { display: 'flex', flexDirection: 'column', gap: 8 },
  aiCard: {
    position: 'relative', background: 'linear-gradient(135deg,#241a3d 0%,#182611 100%)',
    border: '1px solid #5a3fb0', borderRadius: 16, padding: 16,
    display: 'flex', flexDirection: 'column', gap: 10, overflow: 'hidden',
  },
  aiSpark: { fontSize: 30, animation: 'gm-float 1.8s ease-in-out infinite', alignSelf: 'center' },
  aiTitle: { fontSize: 16, fontWeight: 800, color: '#eaf5d9' },
  aiSub: { fontSize: 13, color: '#c3b8e6', lineHeight: 1.45, margin: 0 },
  aiMeta: { fontSize: 12, color: '#9fb47f', fontVariantNumeric: 'tabular-nums', textAlign: 'right' },
  barTrack: {
    position: 'relative', height: 12, borderRadius: 999, background: '#0f1a0c',
    border: '1px solid #2f4a2c', overflow: 'hidden',
  },
  barFill: {
    height: '100%', borderRadius: 999,
    background: 'linear-gradient(90deg,#7cb342,#b452c9)',
    transition: 'width 0.35s ease', minWidth: 8,
  },
  barPulse: { animation: 'gm-pulse 1.1s ease-in-out infinite' },
  barShimmer: {
    position: 'absolute', top: 0, left: 0, width: '40%', height: '100%',
    background: 'linear-gradient(90deg,transparent,rgba(255,255,255,0.35),transparent)',
    animation: 'gm-shimmer 1.4s linear infinite',
  },
  aiVerdict: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  aiOpen: { marginLeft: 'auto', fontSize: 13, fontWeight: 700, color: '#f4c430' },
  breakWrap: { display: 'flex', flexDirection: 'column', gap: 6 },
  breakRow: { display: 'flex', alignItems: 'center', gap: 8 },
  breakLabel: { width: 96, flexShrink: 0, fontSize: 12, color: '#eaf5d9' },
  breakTrack: { flex: 1, height: 10, borderRadius: 999, background: '#0f1a0c', overflow: 'hidden' },
  breakFill: { height: '100%', borderRadius: 999, transformOrigin: 'left', animation: 'gm-grow 0.5s ease' },
  breakPct: { width: 34, flexShrink: 0, textAlign: 'right', fontSize: 12, fontWeight: 700, color: '#cfe3b4', fontVariantNumeric: 'tabular-nums' },
};
