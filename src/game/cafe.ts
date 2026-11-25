/**
 * Restoring the Seaside Onigiri Café, the first 3D place. Pure data and
 * rules, no rendering, so the economy can be reasoned about on its own.
 *
 * The café starts run-down: trash on the sand, a rotten shack, a wrecked
 * boat. Thirty tasks in four stages bring it back to life. Paint jobs let the
 * player pick a colour (and change it again later for free), and rare finds
 * from Dig and Fetch become decorations that make the place look better.
 *
 * Costs are tuned so finishing takes roughly the coins from the hundred
 * levels of Sunrise Shore, with upgrades and boosters still affordable.
 */
import { Profile, today } from './save.js';

export type TaskKind = 'clean' | 'repair' | 'paint' | 'build';

export interface Swatch {
  id: string;
  label: string;
  color: string;
}

export interface CafeTask {
  id: string;
  name: string;
  icon: string;
  kind: TaskKind;
  stage: number;
  /** Where the dog walks to do it, on the beach (x, z) in metres. */
  spot: [number, number];
  /** What the dog says when it is done. */
  line: string;
  /** Colour choices; the player picks one, and can change it later. */
  swatches?: Swatch[];
}

export const PAINTS: Swatch[] = [
  { id: 'sky', label: 'Sky blue', color: '#7cc6f2' },
  { id: 'mint', label: 'Mint', color: '#8fe3c0' },
  { id: 'sun', label: 'Sunshine', color: '#ffd66b' },
  { id: 'coral', label: 'Coral', color: '#ff9a8b' },
  { id: 'lilac', label: 'Lilac', color: '#c3a6f5' },
  { id: 'shell', label: 'Shell white', color: '#f7f1e3' },
  { id: 'sea', label: 'Deep sea', color: '#3e8fb8' },
  { id: 'wood', label: 'Natural wood', color: '#c98b52' },
];

const ROOFS: Swatch[] = [
  { id: 'thatch', label: 'Thatch', color: '#d9b26a' },
  { id: 'terracotta', label: 'Terracotta', color: '#d9714e' },
  { id: 'teal', label: 'Teal tin', color: '#3fa7a0' },
  { id: 'navy', label: 'Navy tin', color: '#3d5a99' },
];

const FLOWERS: Swatch[] = [
  { id: 'red', label: 'Hibiscus red', color: '#ff5a6e' },
  { id: 'yellow', label: 'Sunflower', color: '#ffd23f' },
  { id: 'purple', label: 'Lavender', color: '#a77bff' },
  { id: 'white', label: 'Daisy white', color: '#ffffff' },
];

export const STAGES = ['Clear the beach', 'Fix the shack', 'Open the café', 'Beach life'];

export const CAFE_TASKS: CafeTask[] = [
  // Stage 1 — clear the beach
  { id: 'trash', name: 'Pick up the trash', icon: '🗑️', kind: 'clean', stage: 0, spot: [-6, 3], line: 'Bottles, cans… who leaves this on a beach? Much better.' },
  { id: 'seaweed', name: 'Rake up the seaweed', icon: '🌿', kind: 'clean', stage: 0, spot: [6, 5], line: 'Smelly! But the sand underneath is lovely.' },
  { id: 'weeds', name: 'Pull the weeds', icon: '🌾', kind: 'clean', stage: 0, spot: [-4, -3], line: 'Prickly weeds, gone. Paws a bit itchy.' },
  { id: 'crates', name: 'Clear the broken crates', icon: '📦', kind: 'clean', stage: 0, spot: [5, -2], line: 'Splinters everywhere. Careful, careful…' },
  { id: 'driftwood', name: 'Haul away the driftwood', icon: '🪵', kind: 'clean', stage: 0, spot: [-12, 4], line: 'Heave… ho! That log was heavier than me.' },
  { id: 'floor', name: 'Sweep the sandy floor', icon: '🧹', kind: 'clean', stage: 0, spot: [0, -3.5], line: 'Swish swish. Look, there are real planks under there!' },
  // Stage 2 — fix the shack
  { id: 'walls', name: 'Replace the rotten planks', icon: '🔨', kind: 'repair', stage: 1, spot: [-3.5, -5], line: 'No more holes. The wind stays outside now.' },
  { id: 'roof', name: 'Fix the roof', icon: '🏠', kind: 'repair', stage: 1, spot: [0, -3], line: 'A proper roof! Pick any style you like.', swatches: ROOFS },
  { id: 'windows', name: 'Mend the windows', icon: '🪟', kind: 'repair', stage: 1, spot: [3.5, -5], line: 'Clean glass, and a view of the sea.' },
  { id: 'door', name: 'Hang a new door', icon: '🚪', kind: 'repair', stage: 1, spot: [0, -3], line: 'It opens! It closes! It does not fall off!', swatches: PAINTS },
  { id: 'paint', name: 'Paint the shack', icon: '🎨', kind: 'paint', stage: 1, spot: [-3, -3], line: 'What a colour. The whole beach looks happier.', swatches: PAINTS },
  { id: 'polish', name: 'Polish the floor', icon: '✨', kind: 'clean', stage: 1, spot: [0, -3.5], line: 'So shiny I can see my nose in it.' },
  { id: 'deck', name: 'Build the porch deck', icon: '🪚', kind: 'build', stage: 1, spot: [0, -1.5], line: 'A deck for sitting, napping and watching waves.', swatches: [PAINTS[7], PAINTS[5], PAINTS[0], PAINTS[2]] },
  // Stage 3 — open the café
  { id: 'counter', name: 'Build the onigiri counter', icon: '🍙', kind: 'build', stage: 2, spot: [0, -2], line: 'The best onigiri on the shore, served right here.', swatches: PAINTS },
  { id: 'kitchen', name: 'Set up the rice cooker', icon: '🍚', kind: 'build', stage: 2, spot: [2.5, -6], line: 'Fluffy rice, coming right up!' },
  { id: 'sign', name: 'Put up the café sign', icon: '🪧', kind: 'build', stage: 2, spot: [0, -1], line: 'Now everyone knows where the snacks are.', swatches: PAINTS },
  { id: 'tables', name: 'Add tables and stools', icon: '🪑', kind: 'build', stage: 2, spot: [-5, 1], line: 'Seats with a sea view. Fancy!', swatches: PAINTS },
  { id: 'parasols', name: 'Open the beach parasols', icon: '⛱️', kind: 'build', stage: 2, spot: [5, 1.5], line: 'Shade for everyone. Pick the stripes!', swatches: PAINTS },
  { id: 'lanterns', name: 'Hang paper lanterns', icon: '🏮', kind: 'build', stage: 2, spot: [0, -1], line: 'Wait until night — they glow!' },
  { id: 'path', name: 'Lay a stepping-stone path', icon: '🪨', kind: 'build', stage: 2, spot: [0, 3], line: 'No more hot sand on sensitive paws.' },
  // Stage 4 — beach life
  { id: 'flowers', name: 'Plant flower beds', icon: '🌺', kind: 'build', stage: 3, spot: [-4, -1], line: 'Flowers! I will not dig them up. Probably.', swatches: FLOWERS },
  { id: 'palms', name: 'Plant new palm trees', icon: '🌴', kind: 'build', stage: 3, spot: [-9, -4], line: 'More shade, more coconuts, more swaying.' },
  { id: 'boat', name: 'Restore the rowboat', icon: '🛶', kind: 'repair', stage: 3, spot: [9, 6], line: 'Good as new. Want to paint her?', swatches: PAINTS },
  { id: 'pier', name: 'Repair the pier', icon: '🌉', kind: 'repair', stage: 3, spot: [13, 7], line: 'Safe to walk on again. Mind the splashy end.' },
  { id: 'loungers', name: 'Set out sun loungers', icon: '🏖️', kind: 'build', stage: 3, spot: [8, 2], line: 'Perfect for a long nap in the sun.', swatches: PAINTS },
  { id: 'tower', name: 'Build a lifeguard tower', icon: '🛟', kind: 'build', stage: 3, spot: [-10, 6], line: 'I will keep an eye on everyone. Woof!' },
  { id: 'bonfire', name: 'Dig a bonfire pit', icon: '🔥', kind: 'build', stage: 3, spot: [-7, 6], line: 'Toasty evenings by the sea. Come back at night!' },
  { id: 'hammock', name: 'String a hammock', icon: '🧺', kind: 'build', stage: 3, spot: [-12, -2], line: 'Swing, swing… zzz…', swatches: PAINTS },
  { id: 'lights', name: 'Hang string lights', icon: '💡', kind: 'build', stage: 3, spot: [3, 2], line: 'Twinkly! It looks magical after dark.' },
  { id: 'opening', name: 'Grand opening!', icon: '🎉', kind: 'build', stage: 3, spot: [0, 1], line: 'The café is open! Thank you for everything, friend!' },
];

/** Rare finds from Dig and Fetch that decorate the café. */
export interface Decor {
  id: string;
  name: string;
  icon: string;
  spot: [number, number];
}

export const DECOR: Decor[] = [
  { id: 'golden-shell', name: 'Golden Shell', icon: '🐚', spot: [-2.2, 2.2] },
  { id: 'treasure-chest', name: 'Treasure Chest', icon: '🧰', spot: [17.5, -1.5] },
  { id: 'ship-wheel', name: 'Ship’s Wheel', icon: '☸️', spot: [3.8, -2.4] },
  { id: 'giant-pearl', name: 'Giant Pearl', icon: '🫧', spot: [2.2, 2.2] },
  { id: 'starfish', name: 'Starfish Statue', icon: '⭐', spot: [-8, 2] },
  { id: 'anchor', name: 'Old Anchor', icon: '⚓', spot: [15, 2] },
  { id: 'coral-arch', name: 'Coral Arch', icon: '🪸', spot: [0, 6] },
  { id: 'flag', name: 'Pirate Flag', icon: '🏴‍☠️', spot: [-14, -6] },
];

export interface CafeState {
  done: string[];
  choice: Record<string, string>;
  decor: string[];
  life?: CafeLife;
}

/** The café as a running business, once it has a counter. */
export interface CafeLife {
  /** Onigiri ready to sell. */
  stock: number;
  /** A worker has been hired to run the counter. */
  worker: boolean;
  /** Coins the worker has earned, waiting in the tip jar. */
  bank: number;
  /** When the bank was last topped up (epoch ms). */
  tick: number;
  /** The day the per-day counters below belong to. */
  day: string;
  /** Uses today, by spot (palms shaken, casts fished, marshmallows…). */
  used: Record<string, number>;
  /** The real day the player last slept in the hammock. */
  slept: string;
  /** Onigiri sold, ever. */
  sold: number;
}

export const ONIGIRI_PRICE = 14;
export const COOK_BATCH = 12;
export const STOCK_MAX = 36;
export const WORKER_COST = 2500;
/** The worker earns a coin this often, while you are away too. */
export const WORKER_MS_PER_COIN = 20_000;
/** …up to this much, so the tip jar wants emptying now and then. */
export const BANK_CAP_MS = 6 * 60 * 60 * 1000;

export function cafeLife(profile: Profile): CafeLife {
  const state = cafeState(profile);
  const life = (state.life = state.life ?? { stock: 6, worker: false, bank: 0, tick: Date.now(), day: today(), used: {}, slept: '', sold: 0 });
  life.used = life.used ?? {};
  if (life.day !== today()) {
    life.day = today();
    life.used = {};
  }
  // The worker keeps earning while you are away, up to the cap.
  const now = Date.now();
  if (life.worker) {
    const span = Math.min(now - life.tick, BANK_CAP_MS);
    const coins = Math.floor(span / WORKER_MS_PER_COIN);
    if (coins > 0) {
      life.bank = Math.min(life.bank + coins, Math.floor(BANK_CAP_MS / WORKER_MS_PER_COIN));
      life.tick = now - ((now - life.tick) % WORKER_MS_PER_COIN);
    }
    if (now - life.tick > BANK_CAP_MS) life.tick = now;
  } else {
    life.tick = now;
  }
  return life;
}

/** Uses one of a spot's daily allowance; false when it is used up. */
export function useDaily(profile: Profile, key: string, limit: number): boolean {
  const life = cafeLife(profile);
  const n = life.used[key] ?? 0;
  if (n >= limit) return false;
  life.used[key] = n + 1;
  return true;
}

export function dailyLeft(profile: Profile, key: string, limit: number): number {
  return Math.max(0, limit - (cafeLife(profile).used[key] ?? 0));
}

export function cafeState(profile: Profile): CafeState {
  const world = (profile.world = profile.world ?? {});
  const s = (world.cafe = world.cafe ?? { done: [], choice: {}, decor: [] });
  s.done = s.done ?? [];
  s.choice = s.choice ?? {};
  s.decor = s.decor ?? [];
  return s;
}

/** Coins for the task at position `index` in the list. */
export function cafeCost(index: number): number {
  return Math.round((250 + index * 45) / 10) * 10;
}

export function taskCost(id: string): number {
  return cafeCost(CAFE_TASKS.findIndex((t) => t.id === id));
}

/** The stage being worked on: the first with anything left to do. */
export function currentStage(state: CafeState): number {
  for (let s = 0; s < STAGES.length; s++) {
    if (CAFE_TASKS.some((t) => t.stage === s && !state.done.includes(t.id))) return s;
  }
  return STAGES.length;
}

/** Tasks that can be done right now. */
export function openTasks(state: CafeState): CafeTask[] {
  const stage = currentStage(state);
  return CAFE_TASKS.filter((t) => t.stage === stage && !state.done.includes(t.id));
}

export function cafeComplete(profile: Profile): boolean {
  return cafeState(profile).done.length >= CAFE_TASKS.length;
}

/** A colour choice for a task, falling back to its first swatch. */
export function choiceOf(state: CafeState, id: string): Swatch | null {
  const task = CAFE_TASKS.find((t) => t.id === id);
  if (!task?.swatches) return null;
  return task.swatches.find((s) => s.id === state.choice[id]) ?? task.swatches[0];
}

export type DoResult = { ok: true; task: CafeTask; finished: boolean } | { ok: false; short: number };

/** Pays for and completes a task. */
export function doTask(profile: Profile, id: string, choice?: string): DoResult {
  const state = cafeState(profile);
  const task = openTasks(state).find((t) => t.id === id);
  if (!task) return { ok: false, short: 0 };
  const cost = taskCost(id);
  if (!profile.infiniteCoins && profile.coins < cost) return { ok: false, short: cost - profile.coins };
  if (!profile.infiniteCoins) profile.coins -= cost;
  state.done.push(id);
  if (choice) state.choice[id] = choice;
  return { ok: true, task, finished: state.done.length >= CAFE_TASKS.length };
}

/** A rare decoration not yet found, or null when all are found. */
export function rollDecor(profile: Profile): Decor | null {
  const state = cafeState(profile);
  const left = DECOR.filter((d) => !state.decor.includes(d.id));
  return left.length ? left[Math.floor(Math.random() * left.length)] : null;
}

export function grantDecor(profile: Profile, id: string): void {
  const state = cafeState(profile);
  if (!state.decor.includes(id)) state.decor.push(id);
}
