import React from 'react';
import { View, StyleSheet } from 'react-native';
import Svg, { Rect, Circle, Line, Text as SvgText } from 'react-native-svg';
import { classifySun, SUN_META } from './solar';

// Interactive yard canvas. Touches are captured on the wrapping View so we get
// coordinates relative to the square, regardless of react-native-svg version.
export default function YardMap({
  size,
  gridN,
  obstructions,
  sunGrid,
  mode,
  selectedCell,
  onPlace,
  onInspect,
}) {
  const cell = size / gridN;

  function handleTouch(evt) {
    const { locationX, locationY } = evt.nativeEvent;
    const x = Math.max(0, Math.min(size, locationX));
    const y = Math.max(0, Math.min(size, locationY));
    if (mode === 'inspect') {
      const c = Math.min(gridN - 1, Math.floor(x / cell));
      const r = Math.min(gridN - 1, Math.floor(y / cell));
      onInspect(r, c);
    } else {
      onPlace(x / size, y / size);
    }
  }

  return (
    <View
      style={[styles.wrap, { width: size, height: size }]}
      onStartShouldSetResponder={() => true}
      onResponderRelease={handleTouch}
    >
      <Svg width={size} height={size}>
        {/* Lawn base */}
        <Rect x={0} y={0} width={size} height={size} fill="#dfeecb" rx={10} />

        {/* Shade grid overlay */}
        {sunGrid &&
          sunGrid.map((row, r) =>
            row.map((hrs, c) => {
              const cls = classifySun(hrs);
              const isSel = selectedCell && selectedCell.r === r && selectedCell.c === c;
              return (
                <Rect
                  key={`${r}-${c}`}
                  x={c * cell}
                  y={r * cell}
                  width={cell}
                  height={cell}
                  fill={SUN_META[cls].color}
                  opacity={0.82}
                  stroke={isSel ? '#c0392b' : 'rgba(255,255,255,0.25)'}
                  strokeWidth={isSel ? 3 : 0.5}
                />
              );
            })
          )}

        {/* Grid guide lines when no data yet */}
        {!sunGrid &&
          Array.from({ length: gridN + 1 }).map((_, i) => (
            <React.Fragment key={`g${i}`}>
              <Line x1={i * cell} y1={0} x2={i * cell} y2={size} stroke="#bcd39a" strokeWidth={0.5} />
              <Line x1={0} y1={i * cell} x2={size} y2={i * cell} stroke="#bcd39a" strokeWidth={0.5} />
            </React.Fragment>
          ))}

        {/* Obstructions */}
        {obstructions.map((o, i) => {
          const px = o.x * size;
          const py = o.y * size;
          if (o.type === 'tree') {
            const r = Math.max(8, (o.radius / (size / gridN)) * cell * 0.9);
            return <Circle key={i} cx={px} cy={py} r={r} fill="#2e7d32" opacity={0.85} stroke="#1b4d20" strokeWidth={2} />;
          }
          const w = 26;
          return <Rect key={i} x={px - w / 2} y={py - w / 2} width={w} height={w} fill="#8d6e63" opacity={0.9} stroke="#5d4037" strokeWidth={2} rx={3} />;
        })}

        {/* Compass */}
        <SvgText x={size / 2} y={16} fill="#4a6a2f" fontSize={12} fontWeight="bold" textAnchor="middle">
          N ↑
        </SvgText>
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    borderRadius: 10,
    overflow: 'hidden',
  },
});
