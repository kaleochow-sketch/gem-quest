/**
 * Every region's 3D place, behind one interface. The Seaside Café keeps its
 * hand-written job list (cafe.ts); the other nine places share a job
 * template themed per region: clear the grounds, fix the building, open the
 * shop, then bring it to life. Each runs as a little business (visitors,
 * stock, a hireable worker, a tip jar) with daily things to do, and one
 * sleep a day across all places.
 */
import {
  CAFE_TASKS,
  COOK_BATCH,
  CafeLife,
  CafeState,
  CafeTask,
  DECOR,
  ONIGIRI_PRICE,
  PAINTS,
  STAGES as CAFE_STAGES,
  STOCK_MAX,
  Swatch,
  WORKER_COST,
  BANK_CAP_MS,
  WORKER_MS_PER_COIN,
  cafeLife,
  cafeState,
  choiceOf as cafeChoice,
  currentStage as cafeStage,
  doTask as cafeDo,
  grantDecor,
  openTasks as cafeOpen,
  rollDecor,
  taskCost as cafeCost,
} from './cafe.js';
import { Profile, today } from './save.js';

export type PlaceTask = CafeTask;
export type PlaceState = CafeState;
export type PlaceLife = CafeLife;

export interface Product {
  name: string;
  icon: string;
  price: number;
  /** What restocking is called ("Cook rice", "Brew cocoa"…). */
  make: string;
  batch: number;
  max: number;
}

export interface PlaceData {
  id: string;
  region: number;
  name: string;
  tasks: PlaceTask[];
  stages: string[];
  product: Product;
  workerCost: number;
  state(p: Profile): PlaceState;
  life(p: Profile): PlaceLife;
  cost(id: string): number;
  open(state: PlaceState): PlaceTask[];
  stage(state: PlaceState): number;
  choice(state: PlaceState, id: string): Swatch | null;
  doTask(p: Profile, id: string, choice?: string): { ok: true; task: PlaceTask; finished: boolean } | { ok: false; short: number };
  useDaily(p: Profile, key: string, limit: number): boolean;
  dailyLeft(p: Profile, key: string, limit: number): number;
  /** Rare finds that decorate the place (the café has them). */
  rollDecor?(p: Profile): { id: string; name: string; icon: string } | null;
  grantDecor?(p: Profile, id: string): void;
}

/* ------------------------------------------------------------------ *
 * Sleep: once a real day, wherever you are
 * ------------------------------------------------------------------ */

export function sleptToday(p: Profile): boolean {
  const w = (p.world = p.world ?? {});
  return w.slept === today() || w.cafe?.life?.slept === today();
}

export function markSlept(p: Profile): void {
  const w = (p.world = p.world ?? {});
  w.slept = today();
}

/* ------------------------------------------------------------------ *
 * The café, through the same interface
 * ------------------------------------------------------------------ */

const daily = (life: PlaceLife, key: string) => life.used[key] ?? 0;

export const CAFE_PLACE: PlaceData = {
  id: 'cafe',
  region: 0,
  name: 'Seaside Onigiri Café',
  tasks: CAFE_TASKS,
  stages: CAFE_STAGES,
  product: { name: 'onigiri', icon: '🍙', price: ONIGIRI_PRICE, make: 'Cook rice', batch: COOK_BATCH, max: STOCK_MAX },
  workerCost: WORKER_COST,
  state: cafeState,
  life: cafeLife,
  cost: cafeCost,
  open: cafeOpen,
  stage: cafeStage,
  choice: cafeChoice,
  doTask: cafeDo,
  useDaily(p, key, limit) {
    const life = cafeLife(p);
    if (daily(life, key) >= limit) return false;
    life.used[key] = daily(life, key) + 1;
    return true;
  },
  dailyLeft(p, key, limit) {
    return Math.max(0, limit - daily(cafeLife(p), key));
  },
  rollDecor(p) {
    const d = rollDecor(p);
    return d ? { id: d.id, name: d.name, icon: d.icon } : null;
  },
  grantDecor,
};

/* ------------------------------------------------------------------ *
 * The other nine places, from one template
 * ------------------------------------------------------------------ */

export interface PlaceWords {
  region: number;
  id: string;
  name: string;
  /** The building, e.g. "lodge". */
  building: string;
  /** The shop's stall, e.g. "cocoa bar". */
  shop: string;
  product: Omit<Product, 'batch' | 'max'>;
  /** Four kinds of mess to clear, with an icon and a line each. */
  mess: [string, string, string][];
  roofs: Swatch[];
  plants: Swatch[];
  /** Plant and tree names ("Plant snowy shrubs", "Plant pines"). */
  plantName: string;
  treeName: string;
  landmark: [string, string, string];
  bed: [string, string];
  stageNames: [string, string, string, string];
}

/** The job list every themed place follows, worded for its region. */
function makeTasks(w: PlaceWords): PlaceTask[] {
  const t: PlaceTask[] = [];
  const add = (task: PlaceTask) => t.push(task);
  const spots: [number, number][] = [[-6, 3], [6, 5], [-4, -3], [5, -2]];
  w.mess.forEach(([name, icon, line], i) =>
    add({ id: `mess${i}`, name, icon, kind: 'clean', stage: 0, spot: spots[i], line }),
  );
  add({ id: 'floor', name: `Sweep out the ${w.building}`, icon: '🧹', kind: 'clean', stage: 0, spot: [0, -3.5], line: 'Swish swish. Much better!' });

  add({ id: 'walls', name: `Rebuild the ${w.building} walls`, icon: '🔨', kind: 'repair', stage: 1, spot: [-3.5, -4.8], line: 'Solid walls again. The wind stays outside!' });
  add({ id: 'roof', name: 'Fix the roof', icon: '🏠', kind: 'repair', stage: 1, spot: [0, -3], line: 'No more leaks. Pick a style you like!', swatches: w.roofs });
  add({ id: 'windows', name: 'Mend the windows', icon: '🪟', kind: 'repair', stage: 1, spot: [3.5, -4.8], line: 'Clear windows, and what a view.' });
  add({ id: 'door', name: 'Hang a new door', icon: '🚪', kind: 'repair', stage: 1, spot: [0, -3], line: 'A door that opens and closes. Fancy!', swatches: PAINTS });
  add({ id: 'paint', name: `Paint the ${w.building}`, icon: '🎨', kind: 'paint', stage: 1, spot: [-3, -3], line: 'What a colour. Everyone will notice!', swatches: PAINTS });
  add({ id: 'deck', name: 'Build the porch', icon: '🪚', kind: 'build', stage: 1, spot: [0, -1.5], line: 'A porch for sitting and watching the world.', swatches: [PAINTS[7], PAINTS[5], PAINTS[0], PAINTS[2]] });

  add({ id: 'counter', name: `Build the ${w.shop}`, icon: w.product.icon, kind: 'build', stage: 2, spot: [0, -2], line: `The best ${w.product.name} around, served right here.`, swatches: PAINTS });
  add({ id: 'kitchen', name: `Set up the ${w.product.make.toLowerCase().replace(/^\w+\s/, '')} station`, icon: '🍳', kind: 'build', stage: 2, spot: [2.5, -3.4], line: 'All set up. Time to make something tasty!' });
  add({ id: 'sign', name: 'Put up a sign', icon: '🪧', kind: 'build', stage: 2, spot: [0, -1], line: 'Now everyone knows where to find us.', swatches: PAINTS });
  add({ id: 'tables', name: 'Add tables and stools', icon: '🪑', kind: 'build', stage: 2, spot: [-5, 1], line: 'Seats for everyone!', swatches: PAINTS });
  add({ id: 'parasols', name: 'Put up some shade', icon: '⛱️', kind: 'build', stage: 2, spot: [5, 1.5], line: 'A cosy spot out of the weather.', swatches: PAINTS });
  add({ id: 'lanterns', name: 'Hang lanterns', icon: '🏮', kind: 'build', stage: 2, spot: [0, -1], line: 'Wait until night — they glow!' });
  add({ id: 'path', name: 'Lay a stone path', icon: '🪨', kind: 'build', stage: 2, spot: [0, 3], line: 'A proper path for visitors.' });

  add({ id: 'flowers', name: w.plantName, icon: '🌺', kind: 'build', stage: 3, spot: [-4, -1], line: 'Look at that! So pretty.', swatches: w.plants });
  add({ id: 'palms', name: w.treeName, icon: '🌳', kind: 'build', stage: 3, spot: [-9, -4], line: 'More trees, more shade, more nature.' });
  add({ id: 'landmark', name: w.landmark[0], icon: w.landmark[1], kind: 'build', stage: 3, spot: [8, 3], line: w.landmark[2] });
  add({ id: 'tower', name: 'Build a lookout tower', icon: '🔭', kind: 'build', stage: 3, spot: [-10, 6], line: 'I can see for miles up here!' });
  add({ id: 'bonfire', name: 'Build a fire pit', icon: '🔥', kind: 'build', stage: 3, spot: [-7, 6], line: 'Toasty evenings. Come back at night!' });
  add({ id: 'hammock', name: w.bed[0], icon: '🛏️', kind: 'build', stage: 3, spot: [-12, -2], line: w.bed[1], swatches: PAINTS });
  add({ id: 'lights', name: 'Hang string lights', icon: '💡', kind: 'build', stage: 3, spot: [3, 2], line: 'Twinkly! Magical after dark.' });
  add({ id: 'opening', name: 'Grand opening!', icon: '🎉', kind: 'build', stage: 3, spot: [0, 1], line: `The ${w.building} is open! Thank you, friend!` });
  return t;
}

/** Twenty-six jobs priced to take about the region's hundred levels. */
function regionCost(region: number, index: number): number {
  return Math.round(((250 + index * 52) * (1 + region * 0.25)) / 10) * 10;
}

export function makePlace(w: PlaceWords): PlaceData {
  const tasks = makeTasks(w);
  const stages = w.stageNames.slice();
  const state = (p: Profile): PlaceState => {
    const world = (p.world = p.world ?? {});
    const all = world as unknown as Record<string, PlaceState>;
    const s = (all[w.id] = all[w.id] ?? { done: [], choice: {}, decor: [] });
    s.done = s.done ?? [];
    s.choice = s.choice ?? {};
    s.decor = s.decor ?? [];
    return s;
  };
  const stageOf = (s: PlaceState): number => {
    for (let i = 0; i < stages.length; i++) {
      if (tasks.some((t) => t.stage === i && !s.done.includes(t.id))) return i;
    }
    return stages.length;
  };
  const open = (s: PlaceState) => {
    const st = stageOf(s);
    return tasks.filter((t) => t.stage === st && !s.done.includes(t.id));
  };
  const cost = (id: string) => regionCost(w.region, tasks.findIndex((t) => t.id === id));
  const life = (p: Profile): PlaceLife => {
    const s = state(p);
    const l = (s.life = s.life ?? { stock: 6, worker: false, bank: 0, tick: Date.now(), day: today(), used: {}, slept: '', sold: 0 });
    l.used = l.used ?? {};
    if (l.day !== today()) {
      l.day = today();
      l.used = {};
    }
    const now = Date.now();
    if (l.worker) {
      // Pricier places earn a little faster.
      const per = WORKER_MS_PER_COIN / (1 + w.region * 0.15);
      const span = Math.min(now - l.tick, BANK_CAP_MS);
      const coins = Math.floor(span / per);
      if (coins > 0) {
        l.bank = Math.min(l.bank + coins, Math.floor(BANK_CAP_MS / per));
        l.tick = now - ((now - l.tick) % per);
      }
      if (now - l.tick > BANK_CAP_MS) l.tick = now;
    } else {
      l.tick = now;
    }
    return l;
  };
  const data: PlaceData = {
    id: w.id,
    region: w.region,
    name: w.name,
    tasks,
    stages,
    product: { ...w.product, batch: 12, max: 36 },
    workerCost: Math.round((WORKER_COST * (1 + w.region * 0.35)) / 100) * 100,
    state,
    life,
    cost,
    open,
    stage: stageOf,
    choice(s, id) {
      const task = tasks.find((t) => t.id === id);
      if (!task?.swatches) return null;
      return task.swatches.find((x) => x.id === s.choice[id]) ?? task.swatches[0];
    },
    doTask(p, id, choice) {
      const s = state(p);
      const task = open(s).find((t) => t.id === id);
      if (!task) return { ok: false, short: 0 };
      const c = cost(id);
      if (!p.infiniteCoins && p.coins < c) return { ok: false, short: c - p.coins };
      if (!p.infiniteCoins) p.coins -= c;
      s.done.push(id);
      if (choice) s.choice[id] = choice;
      return { ok: true, task, finished: s.done.length >= tasks.length };
    },
    useDaily(p, key, limit) {
      const l = life(p);
      if (daily(l, key) >= limit) return false;
      l.used[key] = daily(l, key) + 1;
      return true;
    },
    dailyLeft(p, key, limit) {
      return Math.max(0, limit - daily(life(p), key));
    },
  };
  return data;
}

const FLOWERS: Swatch[] = [
  { id: 'red', label: 'Poppy red', color: '#ff5a6e' },
  { id: 'yellow', label: 'Sunny', color: '#ffd23f' },
  { id: 'purple', label: 'Lavender', color: '#a77bff' },
  { id: 'white', label: 'Snow white', color: '#ffffff' },
];
const roofs = (...c: [string, string, string][]): Swatch[] => c.map(([id, label, color]) => ({ id, label, color }));

export const PLACE_WORDS: PlaceWords[] = [
  {
    region: 1, id: 'park', name: "Pup's Dog Park", building: 'clubhouse', shop: 'treat stand',
    product: { name: 'dog treats', icon: '🦴', price: 18, make: 'Bake treats' },
    mess: [['Pick up the litter', '🗑️', 'Bottles and wrappers, gone!'], ['Clear fallen branches', '🌿', 'Snap, crunch — all cleared.'], ['Pull the brambles', '🌾', 'Ouch, prickly! But gone.'], ['Fill in the molehills', '🕳️', 'Smooth lawn again. Sorry, moles!']],
    roofs: roofs(['green', 'Moss green', '#5fa56b'], ['red', 'Barn red', '#c9544a'], ['slate', 'Slate', '#5b6b85'], ['honey', 'Honey', '#e0a94a']),
    plants: FLOWERS, plantName: 'Plant flower beds', treeName: 'Plant oak trees',
    landmark: ['Build a fountain', '⛲', 'A splash fountain! Zoomies time!'], bed: ['Put a dog bed under the oak', 'The comfiest bed in the park.'],
    stageNames: ['Tidy the park', 'Fix the clubhouse', 'Open the treat stand', 'Park life'],
  },
  {
    region: 2, id: 'lodge', name: 'Cosy Ski Lodge', building: 'lodge', shop: 'cocoa bar',
    product: { name: 'hot cocoa', icon: '☕', price: 22, make: 'Brew cocoa' },
    mess: [['Shovel the snowdrifts', '❄️', 'Phew! Shovelled clear.'], ['Knock down the icicles', '🧊', 'Clink clink. Safe now!'], ['Clear the broken skis', '🎿', 'Snapped skis, cleared away.'], ['Stack the scattered logs', '🪵', 'A tidy woodpile. Fire later!']],
    roofs: roofs(['snow', 'Snowy red', '#b8453d'], ['pine', 'Pine green', '#3f6e4f'], ['bark', 'Dark bark', '#5a3f2e'], ['sky', 'Ice blue', '#6fa8d6']),
    plants: [{ id: 'holly', label: 'Holly', color: '#d23a3a' }, { id: 'frost', label: 'Frost', color: '#cfe8ff' }, { id: 'gold', label: 'Gold', color: '#ffd23f' }, { id: 'plum', label: 'Plum', color: '#9b6bd6' }],
    plantName: 'Plant winter shrubs', treeName: 'Plant pine trees',
    landmark: ['Build a giant snowman', '⛄', 'Meet Mr Snowman. He is very cool.'], bed: ['Lay a sleeping bag by the fire', 'Warm and snug. So sleepy…'],
    stageNames: ['Dig out the lodge', 'Fix the lodge', 'Open the cocoa bar', 'Mountain life'],
  },
  {
    region: 3, id: 'oasis', name: 'Desert Oasis Camp', building: 'house', shop: 'juice stall',
    product: { name: 'fresh juice', icon: '🧃', price: 26, make: 'Press juice' },
    mess: [['Clear the sand drifts', '🏜️', 'Sand everywhere — but not here any more!'], ['Roll away the tumbleweeds', '🌾', 'Bye bye, tumbleweeds!'], ['Clear the broken pots', '🏺', 'Shards swept up. Careful paws!'], ['Move the fallen rocks', '🪨', 'Heave! Rocks moved.']],
    roofs: roofs(['clay', 'Clay', '#d9895a'], ['sand', 'Sand', '#e8c58a'], ['teal', 'Teal tile', '#3fa7a0'], ['white', 'Whitewash', '#f7f1e3']),
    plants: [{ id: 'pink', label: 'Desert rose', color: '#ff7fa8' }, { id: 'orange', label: 'Marigold', color: '#ffa23f' }, { id: 'violet', label: 'Violet', color: '#a77bff' }, { id: 'yellow', label: 'Sunburst', color: '#ffd23f' }],
    plantName: 'Plant cactus planters', treeName: 'Plant date palms',
    landmark: ['Dig a well', '🪣', 'Fresh cool water, right here in the desert!'], bed: ['String a hammock in the shade', 'Swaying in the warm breeze…'],
    stageNames: ['Clear the camp', 'Fix the house', 'Open the juice stall', 'Oasis life'],
  },
  {
    region: 4, id: 'aquarium', name: 'Coral Aquarium Dome', building: 'dome', shop: 'snack kiosk',
    product: { name: 'seaweed snacks', icon: '🍘', price: 30, make: 'Toast snacks' },
    mess: [['Rake up the seaweed', '🌿', 'Slimy! But the sand is lovely underneath.'], ['Clear the washed-up nets', '🕸️', 'Tangled nets, untangled and gone.'], ['Clear the barnacled rubble', '🪨', 'Crunch. All cleared.'], ['Pick up the driftwood', '🪵', 'Driftwood stacked for later.']],
    roofs: roofs(['aqua', 'Aqua glass', '#7fd6e6'], ['blue', 'Deep blue', '#3d7fc9'], ['pearl', 'Pearl', '#f2eefc'], ['coral', 'Coral', '#ff8f8f']),
    plants: [{ id: 'pink', label: 'Pink coral', color: '#ff7fa8' }, { id: 'orange', label: 'Orange coral', color: '#ffa45c' }, { id: 'purple', label: 'Purple coral', color: '#c38bff' }, { id: 'yellow', label: 'Sun coral', color: '#ffd23f' }],
    plantName: 'Plant coral gardens', treeName: 'Plant palm trees',
    landmark: ['Build a whale fountain', '🐳', 'Splooosh! The whale says hello.'], bed: ['Hang a hammock by the water', 'The sound of waves… zzz…'],
    stageNames: ['Clean the shore', 'Fix the dome', 'Open the snack kiosk', 'Lagoon life'],
  },
  {
    region: 5, id: 'station', name: 'Mesa Weather Station', building: 'station', shop: 'soda stand',
    product: { name: 'storm soda', icon: '🥤', price: 34, make: 'Mix soda' },
    mess: [['Clear the storm debris', '🌪️', 'All the storm’s mess, cleared.'], ['Pull the tumbleweeds', '🌾', 'Tumbleweeds, tumbled away.'], ['Clear the scrap metal', '🔩', 'Clank! Scrap stacked for recycling.'], ['Shift the fallen boulders', '🪨', 'Boulders rolled aside.']],
    roofs: roofs(['steel', 'Steel', '#8a94a8'], ['red', 'Mesa red', '#c9654a'], ['white', 'White', '#f2f2f2'], ['navy', 'Navy', '#3d5a99']),
    plants: [{ id: 'orange', label: 'Desert poppy', color: '#ff8a3c' }, { id: 'yellow', label: 'Brittlebush', color: '#ffd23f' }, { id: 'pink', label: 'Cactus bloom', color: '#ff7fa8' }, { id: 'white', label: 'Yucca', color: '#f7f1e3' }],
    plantName: 'Plant desert blooms', treeName: 'Plant mesquite trees',
    landmark: ['Build a windmill', '🌬️', 'Whirr! Power for the whole station.'], bed: ['Set up a camp cot', 'Listening to the thunder… so cosy.'],
    stageNames: ['Clear the mesa', 'Fix the station', 'Open the soda stand', 'Storm life'],
  },
  {
    region: 6, id: 'workshop', name: 'Crystal Workshop', building: 'workshop', shop: 'candy counter',
    product: { name: 'crystal candy', icon: '🍬', price: 38, make: 'Boil candy' },
    mess: [['Clear the rock rubble', '🪨', 'Rubble cleared. Hard hats off!'], ['Sweep up the coal dust', '⚫', 'Achoo! But clean.'], ['Clear the broken carts', '🛒', 'Wonky carts, wheeled away.'], ['Clear the cobwebs', '🕸️', 'Sorry, spiders. New homes for you!']],
    roofs: roofs(['slate', 'Slate', '#4a4f63'], ['copper', 'Copper', '#c9774a'], ['amethyst', 'Amethyst', '#8f6bd6'], ['teal', 'Teal', '#3fa7a0']),
    plants: [{ id: 'cyan', label: 'Glow cyan', color: '#7fe3ff' }, { id: 'pink', label: 'Glow pink', color: '#ff8fe0' }, { id: 'violet', label: 'Glow violet', color: '#b7a4ff' }, { id: 'green', label: 'Glow green', color: '#8fffb0' }],
    plantName: 'Grow glowing mushrooms', treeName: 'Grow crystal clusters',
    landmark: ['Raise a giant crystal', '💎', 'It hums when you stand near it!'], bed: ['String a hammock in the alcove', 'Cool and quiet. Perfect for a nap.'],
    stageNames: ['Clear the quarry', 'Fix the workshop', 'Open the candy counter', 'Crystal life'],
  },
  {
    region: 7, id: 'toyshop', name: 'Clockwork Toy Shop', building: 'shop', shop: 'toy counter',
    product: { name: 'wind-up toys', icon: '🧸', price: 42, make: 'Wind toys' },
    mess: [['Sweep up loose cogs', '⚙️', 'Cogs everywhere! Swept up now.'], ['Clear the scrap piles', '🔩', 'Scrap sorted. Very tidy.'], ['Mop the oil puddles', '🛢️', 'Slippery! But clean now.'], ['Clear the broken crates', '📦', 'Splinters swept away.']],
    roofs: roofs(['copper', 'Copper', '#c9774a'], ['slate', 'Slate', '#5b6478'], ['green', 'Verdigris', '#5fae9a'], ['red', 'Brick red', '#b5523d']),
    plants: [{ id: 'red', label: 'Geranium', color: '#ff5a6e' }, { id: 'blue', label: 'Cornflower', color: '#5b8def' }, { id: 'yellow', label: 'Primrose', color: '#ffd23f' }, { id: 'white', label: 'Daisy', color: '#ffffff' }],
    plantName: 'Fill the window boxes', treeName: 'Plant street trees',
    landmark: ['Build a clock tower', '🕰️', 'Tick tock! Always play o’clock.'], bed: ['Bring in a cosy armchair', 'Tick… tock… zzz…'],
    stageNames: ['Tidy the yard', 'Fix the shop', 'Open the toy counter', 'City life'],
  },
  {
    region: 8, id: 'igloo', name: 'Stargazer Igloo', building: 'igloo', shop: 'cookie hatch',
    product: { name: 'star cookies', icon: '🍪', price: 46, make: 'Bake cookies' },
    mess: [['Shovel the snowdrifts', '❄️', 'Cleared! Snow angel later.'], ['Chip away the ice slabs', '🧊', 'Chip chip — all gone.'], ['Clear the frozen junk', '📦', 'Frozen junk, thawed and tidied.'], ['Stack the driftwood', '🪵', 'Firewood for starry nights.']],
    roofs: roofs(['ice', 'Ice', '#dff1ff'], ['blue', 'Glacier', '#8fc3f0'], ['lilac', 'Aurora lilac', '#c9b8ff'], ['mint', 'Aurora mint', '#a8f0d8']),
    plants: [{ id: 'blue', label: 'Frost blue', color: '#8fc3f0' }, { id: 'violet', label: 'Arctic violet', color: '#a77bff' }, { id: 'white', label: 'Snowbell', color: '#ffffff' }, { id: 'pink', label: 'Fireweed', color: '#ff7fa8' }],
    plantName: 'Plant arctic flowers', treeName: 'Plant snowy pines',
    landmark: ['Build a big telescope', '🔭', 'So many stars! Is that one shaped like a bone?'], bed: ['Lay out soft furs', 'Toasty under the northern lights.'],
    stageNames: ['Dig out the camp', 'Fix the igloo', 'Open the cookie hatch', 'Starry life'],
  },
  {
    region: 9, id: 'island', name: 'Floating Garden Island', building: 'cottage', shop: 'ice cream cart',
    product: { name: 'rainbow ice cream', icon: '🍦', price: 50, make: 'Churn ice cream' },
    mess: [['Clear the fallen stars', '⭐', 'Stardust everywhere! Swept up.'], ['Clear the cloud fluff', '☁️', 'Poof! The fluff floated off.'], ['Clear the cracked crystals', '💎', 'Sharp bits, safely gone.'], ['Untangle the vines', '🌿', 'Untangled and tidy.']],
    roofs: roofs(['pink', 'Candy pink', '#ffb3d6'], ['lilac', 'Lilac', '#c9b8ff'], ['mint', 'Mint', '#a8f0d8'], ['gold', 'Gold', '#ffd66b']),
    plants: [{ id: 'rainbow', label: 'Rainbow', color: '#ff9aa2' }, { id: 'sky', label: 'Sky', color: '#9ed8ff' }, { id: 'sun', label: 'Sun', color: '#fff19a' }, { id: 'mint', label: 'Mint', color: '#a8f0b8' }],
    plantName: 'Plant sky gardens', treeName: 'Plant pastel trees',
    landmark: ['Build a rainbow arch', '🌈', 'Every colour from every region!'], bed: ['Fluff up a cloud bed', 'Softest nap in the whole sky.'],
    stageNames: ['Tidy the island', 'Fix the cottage', 'Open the ice cream cart', 'Sky life'],
  },
];

export const REGION_PLACES: PlaceData[] = PLACE_WORDS.map(makePlace);

/** The place for a region (0 is the café). */
export function placeFor(region: number): PlaceData {
  return region === 0 ? CAFE_PLACE : REGION_PLACES[region - 1];
}

// Re-exported so callers can show the café's decorations list.
export { DECOR };
