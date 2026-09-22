import React from 'react';

// Web slider backed by a native <input type="range"> — rock-solid touch/drag
// on phones (the RN PanResponder version is used on native only).
export default function TimeSlider({ value, onChange, width, fill = '#f4a825' }) {
  const clamped = Math.max(0, Math.min(1, value || 0));
  return (
    <input
      type="range"
      min={0}
      max={1000}
      step={1}
      value={Math.round(clamped * 1000)}
      onChange={(e) => onChange(Number(e.target.value) / 1000)}
      aria-label="Time of day"
      style={{
        width,
        height: 28,
        margin: '10px 0',
        accentColor: fill,
        cursor: 'pointer',
        touchAction: 'none',
      }}
    />
  );
}
