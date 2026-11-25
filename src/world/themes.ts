/**
 * How each region's 3D place looks: ground, backdrop, water, trees, weather,
 * the style of its building, and the little things to clear, gather and
 * admire. One generic site (region.ts) builds all nine from these.
 */

export type WallKind = 'planks' | 'logs' | 'plaster' | 'stone' | 'brick' | 'ice' | 'glass' | 'crystal';
export type RoofKind = 'gable' | 'steep' | 'flat' | 'dome' | 'cone';
export type MessKind = 'litter' | 'sticks' | 'spiky' | 'tumble' | 'mounds' | 'rocks' | 'boxes' | 'puddles' | 'stars' | 'cogs';
export type TreeKind = 'round' | 'pine' | 'palm' | 'cactus' | 'mesquite' | 'crystal' | 'street' | 'pastel';
export type Backdrop = 'hills' | 'mountains' | 'dunes' | 'lagoon' | 'mesas' | 'quarry' | 'city' | 'ice' | 'sky';
export type Weather = 'petals' | 'snow' | 'dust' | 'bubbles' | 'storm' | 'embers' | 'steam' | 'aurora' | 'sparkles';
export type Landmark = 'fountain' | 'snowman' | 'well' | 'whale' | 'windmill' | 'crystal' | 'clock' | 'telescope' | 'rainbow';
export type PlantKind = 'flowers' | 'shrubs' | 'cacti' | 'coral' | 'mushrooms';

export interface HouseStyle {
  wall: WallKind;
  roof: RoofKind;
  /** Round buildings: domes, the igloo, the tower, the crystal cottage. */
  round: boolean;
  tall?: boolean;
  snow?: boolean;
  extra?: 'chimney' | 'clock' | 'radar';
  /** Natural wall colour before painting, and trim. */
  base: string;
  trim: string;
}

export interface Theme {
  region: number;
  place: string;
  ground: { dry: string; damp: string; far: string };
  backdrop: Backdrop;
  water: null | 'pond' | 'ice' | 'lagoon';
  waterColor: string;
  trees: TreeKind;
  treeColors: [string, string];
  grass: string[] | null;
  weather: Weather;
  house: HouseStyle;
  shade: 'parasol' | 'awning';
  plants: PlantKind;
  landmark: Landmark;
  /** Four messes, matching the job list's four clean-ups. */
  mess: [MessKind, string][];
  gather: { label: string; icon: string; reward: number; color: string };
  bed: 'hammock' | 'cushion' | 'cloud';
  /** Short shop sign. */
  sign: string;
  /** Colour of the product on the counter. */
  goods: string;
  lamp: string;
  path: string;
  prints: [string, string];
}

export const THEMES: Theme[] = [
  {
    region: 1, place: 'park',
    ground: { dry: '#8fd17a', damp: '#7cc46a', far: '#a8dc8c' },
    backdrop: 'hills', water: 'pond', waterColor: '#4fb7d8',
    trees: 'round', treeColors: ['#4fae5e', '#86d68e'], grass: ['#6fbf5c', '#86cf6a', '#9ad67a'],
    weather: 'petals',
    house: { wall: 'planks', roof: 'gable', round: false, base: '#c98b52', trim: '#8a5e3c', extra: 'chimney' },
    shade: 'parasol', plants: 'flowers', landmark: 'fountain',
    mess: [['litter', '#e0e0e0'], ['sticks', '#8a6644'], ['spiky', '#5e7a3a'], ['mounds', '#7a5a3a']],
    gather: { label: 'Pick berries', icon: '🫐', reward: 10, color: '#5b5bd6' },
    bed: 'cushion', sign: 'TREATS', goods: '#c98b52', lamp: '#ffcf6b', path: '#d9d2c4', prints: ['#5a9a4a', '#8fd17a'],
  },
  {
    region: 2, place: 'lodge',
    ground: { dry: '#f4f8ff', damp: '#e3ecf8', far: '#ffffff' },
    backdrop: 'mountains', water: 'ice', waterColor: '#bfe3f7',
    trees: 'pine', treeColors: ['#3f6e5f', '#ffffff'], grass: null,
    weather: 'snow',
    house: { wall: 'logs', roof: 'steep', round: false, base: '#9a6a45', trim: '#6b4a30', snow: true, extra: 'chimney' },
    shade: 'awning', plants: 'shrubs', landmark: 'snowman',
    mess: [['mounds', '#ffffff'], ['rocks', '#cfe8ff'], ['sticks', '#d84a4a'], ['sticks', '#8a6644']],
    gather: { label: 'Collect pinecones', icon: '🌲', reward: 10, color: '#8a5a33' },
    bed: 'cushion', sign: 'COCOA', goods: '#7a4a2a', lamp: '#ffb35c', path: '#a8b4c4', prints: ['#c3d3e8', '#f4f8ff'],
  },
  {
    region: 3, place: 'oasis',
    ground: { dry: '#f2d29a', damp: '#e3bd7d', far: '#f6dcaa' },
    backdrop: 'dunes', water: 'pond', waterColor: '#3fc7c8',
    trees: 'palm', treeColors: ['#4fa85e', '#6fc07a'], grass: null,
    weather: 'dust',
    house: { wall: 'plaster', roof: 'flat', round: false, base: '#e8c58a', trim: '#b88a55' },
    shade: 'parasol', plants: 'cacti', landmark: 'well',
    mess: [['mounds', '#e9c88a'], ['tumble', '#b5985f'], ['boxes', '#c97a4a'], ['rocks', '#b8936a']],
    gather: { label: 'Pick dates', icon: '🌴', reward: 10, color: '#8a4a2a' },
    bed: 'hammock', sign: 'JUICE', goods: '#ff9a3c', lamp: '#ffcf6b', path: '#d9b98a', prints: ['#c99d5e', '#f2d29a'],
  },
  {
    region: 4, place: 'aquarium',
    ground: { dry: '#fbf1dc', damp: '#ecd9b3', far: '#fff6e4' },
    backdrop: 'lagoon', water: 'lagoon', waterColor: '#3fd0d8',
    trees: 'palm', treeColors: ['#3fae6a', '#6fd08a'], grass: ['#8fcf7a', '#a8dc8c'],
    weather: 'bubbles',
    house: { wall: 'glass', roof: 'dome', round: true, base: '#bfeaf7', trim: '#3d7fc9' },
    shade: 'parasol', plants: 'coral', landmark: 'whale',
    mess: [['spiky', '#3c5a2a'], ['spiky', '#c9c2a8'], ['rocks', '#b8b2a0'], ['sticks', '#c2b49a']],
    gather: { label: 'Collect seashells', icon: '🐚', reward: 10, color: '#ffd0dc' },
    bed: 'hammock', sign: 'SNACKS', goods: '#3f6e3f', lamp: '#9ff0ff', path: '#e8dcc4', prints: ['#d4bd8c', '#fbf1dc'],
  },
  {
    region: 5, place: 'station',
    ground: { dry: '#d9946a', damp: '#c98058', far: '#e3a77c' },
    backdrop: 'mesas', water: null, waterColor: '#4fb7d8',
    trees: 'mesquite', treeColors: ['#7a9a4a', '#9ab85a'], grass: ['#b8a35a', '#a8924a'],
    weather: 'storm',
    house: { wall: 'stone', roof: 'flat', round: true, tall: true, base: '#c9b8a8', trim: '#6b5a4a', extra: 'radar' },
    shade: 'awning', plants: 'cacti', landmark: 'windmill',
    mess: [['sticks', '#7a6450'], ['tumble', '#a8875a'], ['cogs', '#8a94a8'], ['rocks', '#b5634a']],
    gather: { label: 'Collect rainwater', icon: '💧', reward: 12, color: '#6fc7ff' },
    bed: 'cushion', sign: 'SODA', goods: '#ff5a6e', lamp: '#ffe08a', path: '#b5826a', prints: ['#a86a4a', '#d9946a'],
  },
  {
    region: 6, place: 'workshop',
    ground: { dry: '#5c5470', damp: '#4a4360', far: '#6b6380' },
    backdrop: 'quarry', water: null, waterColor: '#4fb7d8',
    trees: 'crystal', treeColors: ['#7fe3ff', '#ff8fe0'], grass: null,
    weather: 'embers',
    house: { wall: 'stone', roof: 'flat', round: false, base: '#7a7088', trim: '#3a3348', extra: 'chimney' },
    shade: 'awning', plants: 'mushrooms', landmark: 'crystal',
    mess: [['rocks', '#6b6378'], ['mounds', '#2f2a38'], ['boxes', '#8a6d5a'], ['spiky', '#d8d4e8']],
    gather: { label: 'Chip a crystal', icon: '💎', reward: 14, color: '#7fe3ff' },
    bed: 'hammock', sign: 'CANDY', goods: '#ff8fe0', lamp: '#b7a4ff', path: '#8a8298', prints: ['#3a3348', '#5c5470'],
  },
  {
    region: 7, place: 'toyshop',
    ground: { dry: '#c9b8a3', damp: '#b8a690', far: '#d4c4b0' },
    backdrop: 'city', water: null, waterColor: '#4fb7d8',
    trees: 'street', treeColors: ['#5fae6a', '#86c97a'], grass: null,
    weather: 'steam',
    house: { wall: 'brick', roof: 'gable', round: false, base: '#b5603d', trim: '#5a3a2a', extra: 'clock' },
    shade: 'awning', plants: 'flowers', landmark: 'clock',
    mess: [['cogs', '#c9a04a'], ['boxes', '#8a94a8'], ['puddles', '#2a2a35'], ['boxes', '#a88b62']],
    gather: { label: 'Wind the old clock', icon: '⚙️', reward: 14, color: '#c9a04a' },
    bed: 'cushion', sign: 'TOYS', goods: '#ff6b6b', lamp: '#ffd36b', path: '#a8998a', prints: ['#9c8c78', '#c9b8a3'],
  },
  {
    region: 8, place: 'igloo',
    ground: { dry: '#f2f7ff', damp: '#dde9f8', far: '#ffffff' },
    backdrop: 'ice', water: 'ice', waterColor: '#a8d4f0',
    trees: 'pine', treeColors: ['#3d6a8c', '#ffffff'], grass: null,
    weather: 'aurora',
    house: { wall: 'ice', roof: 'dome', round: true, base: '#e8f4ff', trim: '#8fc3f0', snow: true },
    shade: 'awning', plants: 'shrubs', landmark: 'telescope',
    mess: [['mounds', '#ffffff'], ['rocks', '#cfe8ff'], ['boxes', '#7a8aa0'], ['sticks', '#9a8270']],
    gather: { label: 'Catch snowflakes', icon: '❄️', reward: 14, color: '#ffffff' },
    bed: 'cushion', sign: 'COOKIES', goods: '#d9a05a', lamp: '#bfe3ff', path: '#a8bcd4', prints: ['#c0d0e6', '#f2f7ff'],
  },
  {
    region: 9, place: 'island',
    ground: { dry: '#a8e08c', damp: '#93d27a', far: '#c2ec9e' },
    backdrop: 'sky', water: 'pond', waterColor: '#9ed8ff',
    trees: 'pastel', treeColors: ['#ffb3d6', '#c9b8ff'], grass: ['#8fd77a', '#a8e08c', '#c2ec9e'],
    weather: 'sparkles',
    house: { wall: 'crystal', roof: 'cone', round: true, base: '#efe6ff', trim: '#a98bff' },
    shade: 'parasol', plants: 'flowers', landmark: 'rainbow',
    mess: [['stars', '#ffd23f'], ['mounds', '#ffffff'], ['rocks', '#d9c9ff'], ['spiky', '#5fae6a']],
    gather: { label: 'Pick starfruit', icon: '⭐', reward: 16, color: '#ffe066' },
    bed: 'cloud', sign: 'ICE CREAM', goods: '#ffb3d6', lamp: '#fff3a8', path: '#e8dcff', prints: ['#7cc06a', '#a8e08c'],
  },
];
