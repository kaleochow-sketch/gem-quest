/**
 * Entry points to the 3D world. The renderer and the beach are created on
 * first use and then kept, since setting up WebGL is the slow part.
 */
import { World } from './engine.js';
import { Beach } from './beach.js';
import { BigBeach } from './bigbeach.js';
import { PlaceDeps, PlaceMode } from './placeMode.js';
import { RegionSite } from './region.js';
import { THEMES } from './themes.js';
import { placeFor } from '../game/places.js';
import type { Site } from './site.js';
import { FetchMode, FetchResult } from './fetch3d.js';
import { DigFind, DigMode, DigSetup } from './dig3d.js';
import { cafeState } from '../game/cafe.js';
import type { Profile } from '../game/save.js';
import { loadModels } from './assets.js';

export type { FetchResult, DigFind, DigSetup };

let world: World | null = null;
let beach: Beach | null = null;
let bigBeach: BigBeach | null = null;
/** Each region's site, built the first time it is visited. */
const sites = new Map<number, Site>();

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

/** Opens a region's 3D place: the café beach for region 0, a themed site otherwise. */
export function openPlace(region: number, profile: Profile, deps: PlaceDeps): void {
  void loadModels().then(() => openPlaceNow(region, profile, deps));
}

function openPlaceNow(region: number, profile: Profile, deps: PlaceDeps): void {
  const { world: w, beach: b } = ensure(profile);
  const data = placeFor(region);
  let site: Site = b;
  if (region > 0) {
    let s = sites.get(region);
    if (!s) {
      s = new RegionSite(w, THEMES[region - 1], data);
      sites.set(region, s);
    }
    site = s;
  }
  site.build(data.state(profile));
  w.setPlace(site);
  w.open(
    new PlaceMode(site, data, {
      ...deps,
      exit: () => {
        w.close();
        deps.exit();
      },
      play: () => {
        w.close();
        deps.play();
      },
      places: deps.places
        ? () => {
            w.close();
            deps.places!();
          }
        : undefined,
    }),
  );
}

export function playFetch(profile: Profile, done: (r: FetchResult) => void): void {
  void loadModels().then(() => playFetchNow(profile, done));
}

function playFetchNow(profile: Profile, done: (r: FetchResult) => void): void {
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
  void loadModels().then(() => playDigNow(profile, setup, done));
}

function playDigNow(profile: Profile, setup: DigSetup, done: (found: DigFind[], bone: boolean) => void): void {
  const { world: w, beach: b } = ensure(profile);
  w.open(
    new DigMode(b, setup, (found, bone) => {
      w.close();
      done(found, bone);
    }),
  );
}
