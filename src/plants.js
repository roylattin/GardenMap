// Rough USDA-style hardiness zone estimate from latitude. This is a coarse
// hint only — real zones depend on average annual minimum winter temperature,
// elevation and microclimate. The app lets the user override it.
export function estimateZone(lat) {
  const z = Math.round(11 - (Math.abs(lat) - 25) * 0.35);
  return Math.max(1, Math.min(13, z));
}

// Each plant declares which light categories it thrives in (from solar.js:
// 'full' | 'part-sun' | 'part-shade' | 'shade') and a hardiness zone range.
// Annual vegetables use a wide zone range since they're grown seasonally.
export const PLANTS = [
  // Full sun lovers
  { name: 'Tomato', emoji: '🍅', light: ['full', 'part-sun'], zoneMin: 2, zoneMax: 11, water: 'Regular', kind: 'Veggie' },
  { name: 'Pepper', emoji: '🌶️', light: ['full', 'part-sun'], zoneMin: 3, zoneMax: 11, water: 'Regular', kind: 'Veggie' },
  { name: 'Sunflower', emoji: '🌻', light: ['full'], zoneMin: 2, zoneMax: 11, water: 'Low', kind: 'Flower' },
  { name: 'Lavender', emoji: '💜', light: ['full'], zoneMin: 5, zoneMax: 9, water: 'Low', kind: 'Herb' },
  { name: 'Rosemary', emoji: '🌿', light: ['full'], zoneMin: 7, zoneMax: 11, water: 'Low', kind: 'Herb' },
  { name: 'Basil', emoji: '🌿', light: ['full', 'part-sun'], zoneMin: 2, zoneMax: 11, water: 'Regular', kind: 'Herb' },
  { name: 'Marigold', emoji: '🟠', light: ['full', 'part-sun'], zoneMin: 2, zoneMax: 11, water: 'Low', kind: 'Flower' },
  { name: 'Coneflower', emoji: '🌸', light: ['full', 'part-sun'], zoneMin: 3, zoneMax: 9, water: 'Low', kind: 'Perennial' },
  { name: 'Black-eyed Susan', emoji: '🌼', light: ['full', 'part-sun'], zoneMin: 3, zoneMax: 9, water: 'Low', kind: 'Perennial' },
  { name: 'Yarrow', emoji: '🤍', light: ['full'], zoneMin: 3, zoneMax: 9, water: 'Low', kind: 'Perennial' },
  { name: 'Sedum', emoji: '🪴', light: ['full', 'part-sun'], zoneMin: 3, zoneMax: 10, water: 'Low', kind: 'Succulent' },
  { name: 'Zucchini', emoji: '🥒', light: ['full'], zoneMin: 3, zoneMax: 11, water: 'Regular', kind: 'Veggie' },

  // Part sun / part shade
  { name: 'Lettuce', emoji: '🥬', light: ['part-sun', 'part-shade'], zoneMin: 2, zoneMax: 11, water: 'Regular', kind: 'Veggie' },
  { name: 'Spinach', emoji: '🥬', light: ['part-sun', 'part-shade'], zoneMin: 2, zoneMax: 11, water: 'Regular', kind: 'Veggie' },
  { name: 'Kale', emoji: '🥬', light: ['full', 'part-sun', 'part-shade'], zoneMin: 2, zoneMax: 11, water: 'Regular', kind: 'Veggie' },
  { name: 'Strawberry', emoji: '🍓', light: ['full', 'part-sun'], zoneMin: 3, zoneMax: 10, water: 'Regular', kind: 'Fruit' },
  { name: 'Peas', emoji: '🫛', light: ['part-sun', 'part-shade'], zoneMin: 2, zoneMax: 11, water: 'Regular', kind: 'Veggie' },
  { name: 'Hydrangea', emoji: '💐', light: ['part-sun', 'part-shade'], zoneMin: 3, zoneMax: 9, water: 'Regular', kind: 'Shrub' },
  { name: 'Columbine', emoji: '🌸', light: ['part-sun', 'part-shade'], zoneMin: 3, zoneMax: 8, water: 'Regular', kind: 'Perennial' },
  { name: 'Astilbe', emoji: '🌾', light: ['part-shade', 'part-sun'], zoneMin: 3, zoneMax: 8, water: 'High', kind: 'Perennial' },

  // Shade
  { name: 'Hosta', emoji: '🌿', light: ['part-shade', 'shade'], zoneMin: 3, zoneMax: 9, water: 'Regular', kind: 'Perennial' },
  { name: 'Fern', emoji: '🌿', light: ['shade', 'part-shade'], zoneMin: 3, zoneMax: 10, water: 'High', kind: 'Perennial' },
  { name: 'Bleeding Heart', emoji: '💗', light: ['part-shade', 'shade'], zoneMin: 3, zoneMax: 9, water: 'Regular', kind: 'Perennial' },
  { name: 'Coral Bells', emoji: '🍃', light: ['part-shade', 'shade'], zoneMin: 4, zoneMax: 9, water: 'Regular', kind: 'Perennial' },
  { name: 'Impatiens', emoji: '🌺', light: ['shade', 'part-shade'], zoneMin: 2, zoneMax: 11, water: 'Regular', kind: 'Flower' },
  { name: 'Wild Ginger', emoji: '🍂', light: ['shade'], zoneMin: 4, zoneMax: 8, water: 'Regular', kind: 'Groundcover' },
];

// Return plants that thrive at the given light class AND tolerate the zone.
export function recommendPlants(lightClass, zone) {
  return PLANTS.filter(
    (p) => p.light.includes(lightClass) && zone >= p.zoneMin && zone <= p.zoneMax
  );
}
