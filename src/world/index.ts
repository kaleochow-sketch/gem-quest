/**
 * Entry points to the 3D world. The renderer and the beach are created on
 * first use and then kept, since setting up WebGL is the slow part.
 */
import { World } from './engine.js';
import { Beach } from './beach.js';
import { BigBeach } from './bigbeach.js';
import { CafeDeps, CafeMode } from './cafeMode.js';
import { FetchMode, FetchResult } from './fetch3d.js';
import { DigFind, DigMode, DigSetup } from './dig3d.js';
import { cafeState } from '../game/cafe.js';
import type { Profile } from '../game/save.js';

export type { FetchResult, DigFind, DigSetup };

let world: World | null = null;
let beach: Beach | null = null;
let bigBeach: BigBeach | null = null;

/** WebGL can be missing on very old devices; the 2D versions remain. */
export function has3d(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}

function ensure(profile: Profile): { world: World; beach: Beach } {
  if (!world || !beach) {
    world = new World();
    beach = new Beach(world);
  }
  beach.build(cafeState(profile));
  world.setPlace(beach);
  // With dev tools on, the 3D world is reachable from the console.
  if (profile.dev) (window as unknown as { matchaWorld?: World }).matchaWorld = world;
  return { world, beach };
}

export function closeWorld(): void {
  world?.close();
}

export function openCafe(profile: Profile, deps: CafeDeps): void {
  const { world: w, beach: b } = ensure(profile);
  w.open(
    new CafeMode(b, {
      ...deps,
      exit: () => {
        w.close();
        deps.exit();
      },
      play: () => {
        w.close();
        deps.play();
      },
    }),
  );
}

export function playFetch(profile: Profile, done: (r: FetchResult) => void): void {
  const { world: w } = ensure(profile);
  // Fetch is played on the big beach, away from the café.
  bigBeach = bigBeach ?? new BigBeach(w);
  w.open(
    new FetchMode(bigBeach, (r) => {
      w.close();
      done(r);
    }),
  );
}

export function playDig(profile: Profile, setup: DigSetup, done: (found: DigFind[], bone: boolean) => void): void {
  const { world: w, beach: b } = ensure(profile);
  w.open(
    new DigMode(b, setup, (found, bone) => {
      w.close();
      done(found, bone);
    }),
  );
}
