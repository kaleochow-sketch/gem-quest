/**
 * The building meta-game. Each region has its own project: a little place the
 * dog fixes up one piece at a time with coins earned from levels. Finishing a
 * project, or reaching the next region, opens the next one.
 */
import { BoosterId } from './upgrades.js';
import type { Profile } from './save.js';
import { LEVELS_PER_REGION, TOTAL_LEVELS } from './levels.js';

export interface BuildStep {
  name: string;
  icon: string;
  /** What the dog says when it goes up. */
  line: string;
}

export interface BuildProject {
  id: string;
  name: string;
  blurb: string;
  /** The ground the diorama sits on. */
  ground: [string, string];
  steps: BuildStep[];
}

/**
 * Where each step stands in the diorama, in percent of its box. The first
 * slot is the centrepiece at the back; the rest fan out towards the front.
 */
export const SLOTS: { x: number; y: number; size: number }[] = [
  { x: 50, y: 50, size: 1.9 },
  { x: 21, y: 60, size: 1.3 },
  { x: 79, y: 60, size: 1.3 },
  { x: 35, y: 77, size: 1.15 },
  { x: 65, y: 78, size: 1.15 },
  { x: 12, y: 79, size: 1 },
  { x: 88, y: 79, size: 1 },
];

export const PROJECTS: BuildProject[] = [
  {
    id: 'cafe',
    name: 'Seaside Onigiri Café',
    blurb: 'A boarded-up beach hut that could be the best snack stop on the shore.',
    ground: ['#ffe9b8', '#f2c77f'],
    steps: [
      { name: 'Café hut', icon: '🛖', line: 'A roof over our heads! Well… over the rice.' },
      { name: 'Onigiri counter', icon: '🍙', line: 'Fresh onigiri, shaped with love (and paws).' },
      { name: 'Beach parasols', icon: '⛱️', line: 'Shade! My nose was getting sunburnt.' },
      { name: 'Paper lanterns', icon: '🏮', line: 'So cosy when the sun goes down.' },
      { name: 'Little sailboat', icon: '⛵', line: 'Deliveries by sea. Very fancy.' },
      { name: 'Seashell garden', icon: '🐚', line: 'I promise not to bury these.' },
      { name: 'Driftwood sign', icon: '🪧', line: 'Open for business! Tell everyone!' },
    ],
  },
  {
    id: 'park',
    name: "Pup's Dog Park",
    blurb: 'An empty field with a lot of potential and very few tennis balls.',
    ground: ['#bff0b8', '#7fcf86'],
    steps: [
      { name: 'Kennel', icon: '🏠', line: 'Home sweet home. It smells like me already.' },
      { name: 'Tennis court', icon: '🎾', line: 'Balls! So many balls! This is the best day.' },
      { name: 'Duck pond', icon: '🦆', line: 'I will make friends with the ducks. Probably.' },
      { name: 'Treat stand', icon: '🦴', line: 'Every good park needs a snack stop.' },
      { name: 'Flower beds', icon: '🌷', line: 'I will not dig here. I will not dig here…' },
      { name: 'Picnic tree', icon: '🌳', line: 'Perfect for napping under.' },
      { name: 'Fountain', icon: '⛲', line: 'A drink, a splash, a zoomie. Perfect.' },
    ],
  },
  {
    id: 'lodge',
    name: 'Cosy Ski Lodge',
    blurb: 'A snowed-in cabin halfway up the pass, waiting for a warm fire.',
    ground: ['#ffffff', '#d5e6f7'],
    steps: [
      { name: 'Log cabin', icon: '🏡', line: 'Out of the wind at last. Brrr!' },
      { name: 'Fireplace', icon: '🔥', line: 'Toasty toes. Toasty everything.' },
      { name: 'Ski rack', icon: '🎿', line: 'Four legs, two skis. We will figure it out.' },
      { name: 'Sled run', icon: '🛷', line: 'Wheeeeee! Again! Again!' },
      { name: 'Cocoa bar', icon: '☕', line: 'With extra marshmallows, please.' },
      { name: 'Snow buddy', icon: '⛄', line: 'He is a very good listener.' },
      { name: 'Cable car', icon: '🚡', line: 'Now everyone can come and visit!' },
    ],
  },
  {
    id: 'oasis',
    name: 'Desert Oasis Camp',
    blurb: 'A dry little spring in the dunes that just needs some care.',
    ground: ['#ffe2a8', '#f0b866'],
    steps: [
      { name: 'Palm grove', icon: '🌴', line: 'Shade and coconuts. Living the dream.' },
      { name: 'Camp tent', icon: '⛺', line: 'A bed under the stars. Paws crossed for no sand.' },
      { name: 'Water well', icon: '🪣', line: 'Cool, clear water for every traveller.' },
      { name: 'Camel stable', icon: '🐫', line: 'New friend! He is very tall.' },
      { name: 'Pottery stall', icon: '🏺', line: 'Handmade. Only slightly nibbled.' },
      { name: 'Cactus garden', icon: '🌵', line: 'Look, do not sniff. Lesson learned.' },
      { name: 'Kite flyer', icon: '🪁', line: 'The desert wind is perfect for this!' },
    ],
  },
  {
    id: 'aquarium',
    name: 'Coral Aquarium Dome',
    blurb: 'An old glass dome on the sea floor, ready to be a home for sea friends.',
    ground: ['#bdeefa', '#6fc7de'],
    steps: [
      { name: 'Glass dome', icon: '🫧', line: 'Watertight! I checked. Twice.' },
      { name: 'Coral reef', icon: '🪸', line: 'So many colours. So many fish snacks. No!' },
      { name: 'Clownfish family', icon: '🐠', line: 'They are hilarious, as promised.' },
      { name: 'Sea turtle', icon: '🐢', line: 'Slow and steady. A wise friend.' },
      { name: 'Octopus', icon: '🐙', line: 'Eight arms means eight belly rubs.' },
      { name: 'Old anchor', icon: '⚓', line: 'From a shipwreck. Spooky but cool.' },
      { name: 'Friendly whale', icon: '🐳', line: 'The biggest visitor yet! Hello!' },
    ],
  },
  {
    id: 'station',
    name: 'Mesa Weather Station',
    blurb: 'A rickety lookout on the mesa that could predict every storm.',
    ground: ['#f3c9a8', '#cf9473'],
    steps: [
      { name: 'Lookout tower', icon: '🗼', line: 'I can see my kennel from here!' },
      { name: 'Wind chimes', icon: '🎐', line: 'Ting ting. The wind says hello.' },
      { name: 'Rain shelter', icon: '☂️', line: 'No more soggy fur.' },
      { name: 'Lightning rod', icon: '⚡', line: 'Zap it here, not on me, please.' },
      { name: 'Weather balloon', icon: '🎈', line: 'Up, up and away with the forecast.' },
      { name: 'Radar dish', icon: '📡', line: 'Beep boop. Storm in three… two…' },
      { name: 'Rainbow catcher', icon: '🌈', line: 'After every storm, a rainbow!' },
    ],
  },
  {
    id: 'workshop',
    name: 'Crystal Workshop',
    blurb: 'A forgotten mine tunnel where the crystals still glow.',
    ground: ['#bcb0e0', '#7f6fb6'],
    steps: [
      { name: 'Tool rack', icon: '⛏️', line: 'Helmets on, everyone. Safety first.' },
      { name: 'Mine cart', icon: '🚃', line: 'All aboard the rattly express!' },
      { name: 'Work lamps', icon: '🔦', line: 'Now I can find my ball down here.' },
      { name: 'Glow mushrooms', icon: '🍄', line: 'Pretty. Not for eating. Got it.' },
      { name: 'Little forge', icon: '⚒️', line: 'Clang clang! Making something shiny.' },
      { name: 'Crystal display', icon: '💎', line: 'Look how they sparkle!' },
      { name: 'Gem crown', icon: '👑', line: 'Fit for a very good dog.' },
    ],
  },
  {
    id: 'toyshop',
    name: 'Clockwork Toy Shop',
    blurb: 'A dusty shop under the clock tower, full of toys that need winding.',
    ground: ['#f6d7b5', '#d4a072'],
    steps: [
      { name: 'Grand clock', icon: '🕰️', line: 'Tick tock — it is always play o’clock.' },
      { name: 'Gear wall', icon: '⚙️', line: 'Everything turns together. Teamwork!' },
      { name: 'Teddy shelf', icon: '🧸', line: 'Very soft. Very tempting to chew.' },
      { name: 'Toy train', icon: '🚂', line: 'Choo choo! Round and round it goes.' },
      { name: 'Wind-up robot', icon: '🤖', line: 'Beep! He wants to be friends.' },
      { name: 'Carousel', icon: '🎠', line: 'Round and round. I am a bit dizzy.' },
      { name: 'Ferris wheel', icon: '🎡', line: 'The whole city lit up. Wow.' },
    ],
  },
  {
    id: 'igloo',
    name: 'Stargazer Igloo',
    blurb: 'A snowy camp under the northern lights, perfect for watching the sky.',
    ground: ['#eef5ff', '#b9cdee'],
    steps: [
      { name: 'Igloo', icon: '🧊', line: 'Cold outside, cosy inside. Somehow.' },
      { name: 'Penguin pals', icon: '🐧', line: 'They waddle! I waddle! We are the same.' },
      { name: 'Seal slide', icon: '🦭', line: 'Belly slides are the best slides.' },
      { name: 'Telescope', icon: '🔭', line: 'Is that a star shaped like a bone?' },
      { name: 'Snowflake lights', icon: '❄️', line: 'Each one is different, just like friends.' },
      { name: 'Moon swing', icon: '🌙', line: 'Swinging under the aurora. Magical.' },
      { name: 'Arctic fox', icon: '🦊', line: 'A fluffy new neighbour!' },
    ],
  },
  {
    id: 'island',
    name: 'Floating Garden Island',
    blurb: 'A bare rock drifting above the clouds. The last and best project.',
    ground: ['#d9f7c8', '#9fdc8a'],
    steps: [
      { name: 'Fairy castle', icon: '🏰', line: 'A castle in the clouds. We did it!' },
      { name: 'Big oak', icon: '🌳', line: 'Roots in the sky. That is new.' },
      { name: 'Sunflowers', icon: '🌻', line: 'They follow the sun. I follow the snacks.' },
      { name: 'Butterflies', icon: '🦋', line: 'Too fast to catch. Not that I tried.' },
      { name: 'Hot-air balloon', icon: '🎈', line: 'Our ride home, whenever we want it.' },
      { name: 'Rainbow arch', icon: '🌈', line: 'Every colour from every region.' },
      { name: 'Star fountain', icon: '⛲', line: 'Everything is built. Thank you, friend!' },
    ],
  },
];

/** Coins for step `step` of the project in region `region`. */
export function stepCost(region: number, step: number): number {
  return Math.round(((300 + step * 180) * (1 + region * 0.25)) / 10) * 10;
}

/** Bonus for finishing a whole project. */
export function projectReward(region: number): { coins: number; item: BoosterId } {
  return { coins: Math.round((600 * (1 + region * 0.25)) / 10) * 10, item: 'rainbowStart' };
}

export function stepsBuilt(profile: Profile, index: number): number {
  return Math.min(PROJECTS[index].steps.length, profile.build?.[PROJECTS[index].id] ?? 0);
}

export function isComplete(profile: Profile, index: number): boolean {
  return stepsBuilt(profile, index) >= PROJECTS[index].steps.length;
}

/** The region the player's furthest open level is in (0-based). */
function regionReached(profile: Profile): number {
  return Math.floor((Math.min(profile.unlocked, TOTAL_LEVELS) - 1) / LEVELS_PER_REGION);
}

/**
 * How many projects are open. The next project opens when the one before it
 * is finished, or when the player reaches its region, whichever comes first.
 */
export function projectsUnlocked(profile: Profile): number {
  let open = regionReached(profile) + 1;
  for (let i = 0; i < PROJECTS.length - 1; i++) {
    if (i < open && isComplete(profile, i)) open = Math.max(open, i + 2);
  }
  return Math.min(PROJECTS.length, open);
}

/** The project to show first: the earliest open one not yet finished. */
export function activeProject(profile: Profile): number {
  const open = projectsUnlocked(profile);
  for (let i = 0; i < open; i++) if (!isComplete(profile, i)) return i;
  return open - 1;
}

export type BuildResult =
  | { ok: false; reason: 'locked' | 'done' | 'coins'; short?: number }
  | { ok: true; step: BuildStep; stepIndex: number; finished: boolean; opened: number | null };

/** Spends coins on the next piece of a project. */
export function buildNext(profile: Profile, index: number): BuildResult {
  if (index >= projectsUnlocked(profile)) return { ok: false, reason: 'locked' };
  const project = PROJECTS[index];
  const done = stepsBuilt(profile, index);
  if (done >= project.steps.length) return { ok: false, reason: 'done' };
  const cost = stepCost(index, done);
  if (!profile.infiniteCoins && profile.coins < cost) {
    return { ok: false, reason: 'coins', short: cost - profile.coins };
  }

  const openBefore = projectsUnlocked(profile);
  if (!profile.infiniteCoins) profile.coins -= cost;
  profile.build = { ...(profile.build ?? {}), [project.id]: done + 1 };
  const finished = done + 1 >= project.steps.length;
  if (finished) {
    const reward = projectReward(index);
    profile.coins += reward.coins;
    profile.inventory[reward.item] = (profile.inventory[reward.item] ?? 0) + 1;
  }
  const openAfter = projectsUnlocked(profile);
  return {
    ok: true,
    step: project.steps[done],
    stepIndex: done,
    finished,
    opened: openAfter > openBefore ? openAfter - 1 : null,
  };
}
