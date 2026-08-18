/** Board coordinate. */
export interface Pos {
  r: number;
  c: number;
}

export const enum Special {
  None = 0,
  /** Clears its whole row. */
  RocketH = 1,
  /** Clears its whole column. */
  RocketV = 2,
  /** Blasts a 3x3 area. */
  Bomb = 3,
  /** Swap with any gem to clear every gem of that colour. */
  Rainbow = 4,
}

export const enum GemKind {
  Normal = 0,
  /** Falls with gravity, never matches; must be dropped off the bottom. */
  Ingredient = 1,
}

export interface Gem {
  kind: GemKind;
  /**
   * Countdown on a fuse gem: ticks down once per player move and ends the
   * level if it reaches zero. 0 means this gem carries no fuse.
   */
  fuse?: number;
  /** Palette index 0..colorCount-1. Ignored for ingredients and rainbows. */
  color: number;
  special: Special;
  /** Unique id so the renderer can track a gem across falls and cascades. */
  id: number;
}

export type BlockerKind = 'crate' | 'stone';

export interface Blocker {
  kind: BlockerKind;
  hp: number;
}

export interface Cell {
  /** Not part of the playfield — nothing spawns, falls through or renders here. */
  hole: boolean;
  gem: Gem | null;
  /** Layers of jelly under the gem; jelly levels require clearing every layer. */
  jelly: number;
  /** Occupies the cell instead of a gem, and stops gems falling through. */
  blocker: Blocker | null;
  /** Chain over a gem: it cannot be swapped until a match frees it. */
  locked: boolean;
}

export interface BoardConfig {
  width: number;
  height: number;
  colorCount: number;
  /** Columns whose top cell refills from off-screen. */
  spawnColumns: number[];
  /** Cells that collect ingredients when one lands on them. */
  exits: Pos[];
}

/* ------------------------------------------------------------------ *
 * Resolution timeline — the renderer replays these in order.
 * ------------------------------------------------------------------ */

export interface SwapStep {
  type: 'swap';
  a: Pos;
  b: Pos;
  /** false => the swap produced no match and is bounced back. */
  valid: boolean;
}

export interface ClearStep {
  type: 'clear';
  /** Gems removed this step, with the gem as it was before removal. */
  cleared: { pos: Pos; gem: Gem }[];
  /** Special gems that detonated, for effect rendering. */
  detonations: { pos: Pos; special: Special; color: number }[];
  /** Blockers that took damage; `destroyed` when hp hit zero. */
  damaged: { pos: Pos; kind: BlockerKind; hpLeft: number; destroyed: boolean }[];
  /** New special gems created in place by this match. */
  created: { pos: Pos; gem: Gem }[];
  jelly: { pos: Pos; layersLeft: number }[];
  unlocked: Pos[];
  /** Ingredients that reached an exit. */
  collected: { pos: Pos; gem: Gem }[];
  /** Fuse gems defused by this clear. */
  defused: Pos[];
  score: number;
  /** 1 for the initial match, 2+ for each cascade. */
  cascade: number;
}

export interface FallStep {
  type: 'fall';
  moves: { from: Pos; to: Pos; id: number }[];
  /** `fromRow` is negative: how far above the board the gem starts. */
  spawns: { to: Pos; gem: Gem; fromRow: number }[];
}

export interface ShuffleStep {
  type: 'shuffle';
  /** Final gem placement after the reshuffle. */
  layout: { pos: Pos; gem: Gem }[];
}

export type Step = SwapStep | ClearStep | FallStep | ShuffleStep;

export function samePos(a: Pos, b: Pos): boolean {
  return a.r === b.r && a.c === b.c;
}

export function isAdjacent(a: Pos, b: Pos): boolean {
  return Math.abs(a.r - b.r) + Math.abs(a.c - b.c) === 1;
}
