import React, { useEffect, useRef, useState } from 'react';
import { Modal } from 'react-native';

import { analyzeLight, analyzePhoto, aspectFromHeading } from './photo.web';
import { estimateZone, recommendPlants } from './plants';
import { SUN_META } from './solar';

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

export default function PhotoAnalyzer({ visible, onClose, zone, onUseLocation }) {
  const [stage, setStage] = useState('start'); // start | camera | analyzing | report
  const [heading, setHeading] = useState(null);
  const [tilt, setTilt] = useState(null);
  const [orientBlocked, setOrientBlocked] = useState(false);
  const [report, setReport] = useState(null);
  const [err, setErr] = useState(null);
  const [aiNote, setAiNote] = useState(false);

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
    const loc = await getLoc();
    const lat = loc ? loc.lat : null;
    const lng = loc ? loc.lng : null;
    const z = lat != null ? estimateZone(lat) : zone;
    const aspect = aspectFromHeading(heading, lat != null ? lat : 40);
    stopCamera();
    setReport({
      ...light, lat, lng, heading, tilt, aspect, zone: z,
      when: new Date(), plants: recommendPlants(light.lightClass, z), source: 'camera',
    });
    setStage('report');
  }

  async function onFile(e) {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    setStage('analyzing');
    try {
      const r = await analyzePhoto(f);
      const lat = r.exif && r.exif.lat != null ? r.exif.lat : null;
      const lng = r.exif && r.exif.lng != null ? r.exif.lng : null;
      const z = lat != null ? estimateZone(lat) : zone;
      setReport({
        ...r, lat, lng,
        heading: r.exif ? r.exif.heading : null,
        aspect: r.exif ? r.exif.aspect : null,
        zone: z, when: r.exif ? r.exif.when : null,
        plants: recommendPlants(r.lightClass, z), source: 'upload',
      });
      setStage('report');
    } catch {
      setErr('Could not read that image. Try another photo.');
      setStage('start');
    }
    e.target.value = '';
  }

  const meta = report ? SUN_META[report.lightClass] : null;

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <div style={S.root}>
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
                  {report.lat != null && <span style={S.fact}>📍 {report.lat.toFixed(4)}, {report.lng.toFixed(4)} · zone {report.zone}</span>}
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

              <button style={S.ai} onClick={() => setAiNote((v) => !v)}>✨ Deeper AI analysis</button>
              {aiNote && (
                <p style={S.fine}>
                  Coming soon (opt-in): AI identifies your plants, spots health/pest issues, and reads shade cues
                  (moss, leggy growth) to fine-tune advice. It’ll build on the facts captured here.
                </p>
              )}
              <p style={S.fine}>
                This reads a single moment of light. For all-day sun, take shots at morning/noon/afternoon, or use
                the map’s shadow model.
              </p>
              <button style={S.primary} onClick={reset}>↺ Analyze another spot</button>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

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
};
