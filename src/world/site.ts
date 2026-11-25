/**
 * What a 3D place offers the shared play mode: its rebuildable contents,
 * where things are, and how visitors arrive. The café beach and every
 * region site implement this.
 */
import * as THREE from 'three';
import type { PlaceState } from '../game/places.js';
import type { Place } from './engine.js';

export type SpotKind =
  | 'hammock'
  | 'counter'
  | 'kitchen'
  | 'bonfire'
  | 'palm'
  | 'gather'
  | 'pier'
  | 'boat'
  | 'lounger'
  | 'tower'
  | 'table'
  | 'flowers'
  | 'landmark';

/** Somewhere the dog can do something (sleep, serve, fish…). */
export interface Spot {
  kind: SpotKind;
  x: number;
  z: number;
  /** How close the dog must be. */
  r: number;
  /** Distinguishes several of a kind (each tree can be picked once a day). */
  key: string;
  /** Where the dog rests or stands to use it (seat, bed, tower top, pier end). */
  at?: [number, number, number];
  /** Where the dog steps off afterwards. */
  exit?: [number, number];
  facing?: number;
  /** Fishing: where the float lands. */
  bob?: [number, number, number];
  /** Gathering: what it is called, its icon and coins. */
  label?: string;
  icon?: string;
  reward?: number;
}

export interface Seat {
  x: number;
  z: number;
  y: number;
  facing: number;
}

/** A ride visitors take in: it travels from `from` to `dock`, they step off at `land` and walk in. */
export interface Ferry {
  kind: 'boat' | 'balloon';
  from: [number, number, number];
  dock: [number, number, number];
  land: [number, number, number];
  /** The walk from `land` to the yard. */
  walk: [number, number][];
}

export interface Site extends Place {
  /** The rebuildable contents (buildings, props), for tapping. */
  readonly content: THREE.Group;
  readonly paintable: Map<string, THREE.Object3D>;
  spots: Spot[];
  seats: Seat[];
  build(state: PlaceState, preview?: { task: string; swatch: string }): void;
  /** Ways visitors walk in: each a list of points from the edge to the yard. */
  walkRoutes(): [number, number][][];
  /** How some visitors arrive other than on foot (a rowboat, a balloon), if at all right now. */
  ferry(): Ferry | null;
  /** Spots in the queue in front of the counter, front first. */
  readonly queue: [number, number][];
  /** Where a hired worker stands, behind the counter. */
  readonly workerAt: [number, number, number];
  /** Where the dog appears. */
  readonly start: [number, number];
}
