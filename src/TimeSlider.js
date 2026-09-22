import React, { useRef } from 'react';
import { View, PanResponder, StyleSheet } from 'react-native';

// Lightweight 0..1 slider that works on web and native (no extra deps).
export default function TimeSlider({ value, onChange, width, fill = '#f4a825', track = '#3a5a34' }) {
  const w = useRef(width);
  w.current = width;

  const set = (x) => {
    const v = Math.max(0, Math.min(1, x / (w.current || 1)));
    onChange(v);
  };

  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (e) => set(e.nativeEvent.locationX),
      onPanResponderMove: (e) => set(e.nativeEvent.locationX),
    })
  ).current;

  const clamped = Math.max(0, Math.min(1, value));

  return (
    <View style={[styles.track, { width, backgroundColor: track }]} {...pan.panHandlers}>
      <View style={[styles.fill, { width: width * clamped, backgroundColor: fill }]} />
      <View style={[styles.thumb, { left: width * clamped - 11, backgroundColor: fill }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  track: { height: 8, borderRadius: 4, justifyContent: 'center', marginVertical: 14 },
  fill: { height: 8, borderRadius: 4, position: 'absolute', left: 0 },
  thumb: { position: 'absolute', width: 22, height: 22, borderRadius: 11, top: -7, borderWidth: 2, borderColor: '#fff' },
});
