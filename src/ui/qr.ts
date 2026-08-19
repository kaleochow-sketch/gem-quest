/**
 * Minimal QR encoder — byte mode, error-correction level M, versions 1-10.
 *
 * Written by hand because the game ships as a self-contained offline app and
 * cannot pull a library from a CDN at runtime.
 */

const EC_LEVEL_M = 0;

/** Data codeword capacity in byte mode at level M, indexed by version. */
const BYTE_CAPACITY = [0, 14, 26, 42, 62, 84, 106, 122, 152, 180, 213];

/** [ecCodewordsPerBlock, group1Blocks, group1Data, group2Blocks, group2Data] */
const BLOCKS_M: number[][] = [
  [],
  [10, 1, 16, 0, 0],
  [16, 1, 28, 0, 0],
  [26, 1, 44, 0, 0],
  [18, 2, 32, 0, 0],
  [24, 2, 43, 0, 0],
  [16, 4, 27, 0, 0],
  [18, 4, 31, 0, 0],
  [22, 2, 38, 2, 39],
  [22, 3, 36, 2, 37],
  [26, 4, 43, 1, 44],
];

const ALIGNMENT: number[][] = [
  [],
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
];

/** 15-bit format strings for level M, one per mask. */
const FORMAT_M = [0x5412, 0x5125, 0x5e7c, 0x5b4b, 0x45f9, 0x40ce, 0x4f97, 0x4aa0];

/** 18-bit version strings, needed from version 7 up. */
const VERSION_BITS: Record<number, number> = {
  7: 0x07c94,
  8: 0x085bc,
  9: 0x09a99,
  10: 0x0a4d3,
};

/* ------------------------------------------------------------------ *
 * GF(256) arithmetic for Reed-Solomon
 * ------------------------------------------------------------------ */

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

/** Generator polynomial for `n` error-correction codewords. */
function rsGenerator(n: number): number[] {
  let poly = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

function rsEncode(data: number[], ecCount: number): number[] {
  const gen = rsGenerator(ecCount);
  const result = new Array(ecCount).fill(0);
  for (const byte of data) {
    const factor = byte ^ result[0];
    result.shift();
    result.push(0);
    for (let i = 0; i < gen.length - 1; i++) {
      result[i] ^= gfMul(gen[i + 1], factor);
    }
  }
  return result;
}

/* ------------------------------------------------------------------ *
 * Encoding
 * ------------------------------------------------------------------ */

class BitBuffer {
  private bits: number[] = [];

  put(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }

  get length(): number {
    return this.bits.length;
  }

  toBytes(): number[] {
    const bytes: number[] = [];
    for (let i = 0; i < this.bits.length; i += 8) {
      let byte = 0;
      for (let j = 0; j < 8; j++) byte = (byte << 1) | (this.bits[i + j] ?? 0);
      bytes.push(byte);
    }
    return bytes;
  }
}

function chooseVersion(byteLength: number): number {
  for (let v = 1; v <= 10; v++) {
    if (byteLength <= BYTE_CAPACITY[v]) return v;
  }
  throw new Error('text too long for a version-10 QR code');
}

function buildCodewords(bytes: number[], version: number): number[] {
  const [ecPerBlock, g1Blocks, g1Data, g2Blocks, g2Data] = BLOCKS_M[version];
  const totalData = g1Blocks * g1Data + g2Blocks * g2Data;

  const buffer = new BitBuffer();
  buffer.put(4, 4); // byte mode
  // Character count is 8 bits for versions 1-9, 16 bits from version 10.
  buffer.put(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) buffer.put(b, 8);

  // Terminator, then pad to a byte boundary.
  const capacityBits = totalData * 8;
  const terminator = Math.min(4, capacityBits - buffer.length);
  buffer.put(0, terminator);
  if (buffer.length % 8) buffer.put(0, 8 - (buffer.length % 8));

  const data = buffer.toBytes();
  const PAD = [0xec, 0x11];
  let padIndex = 0;
  while (data.length < totalData) data.push(PAD[padIndex++ % 2]);

  // Split into blocks, compute EC for each, then interleave.
  const blocks: number[][] = [];
  const ecBlocks: number[][] = [];
  let offset = 0;
  for (let i = 0; i < g1Blocks; i++) {
    const block = data.slice(offset, offset + g1Data);
    offset += g1Data;
    blocks.push(block);
    ecBlocks.push(rsEncode(block, ecPerBlock));
  }
  for (let i = 0; i < g2Blocks; i++) {
    const block = data.slice(offset, offset + g2Data);
    offset += g2Data;
    blocks.push(block);
    ecBlocks.push(rsEncode(block, ecPerBlock));
  }

  const out: number[] = [];
  const maxData = Math.max(g1Data, g2Data || 0);
  for (let i = 0; i < maxData; i++) {
    for (const block of blocks) if (i < block.length) out.push(block[i]);
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (const block of ecBlocks) out.push(block[i]);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Matrix
 * ------------------------------------------------------------------ */

function placeFunctionPatterns(size: number, version: number) {
  const modules: (boolean | null)[][] = Array.from({ length: size }, () =>
    new Array(size).fill(null),
  );
  const reserved: boolean[][] = Array.from({ length: size }, () => new Array(size).fill(false));

  const setFn = (r: number, c: number, dark: boolean) => {
    modules[r][c] = dark;
    reserved[r][c] = true;
  };

  // Finder patterns and their separators.
  const finder = (row: number, col: number) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = row + r;
        const cc = col + c;
        if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
        const inRing =
          (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
          (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
          (r >= 2 && r <= 4 && c >= 2 && c <= 4);
        setFn(rr, cc, inRing);
      }
    }
  };
  finder(0, 0);
  finder(0, size - 7);
  finder(size - 7, 0);

  // Timing patterns.
  for (let i = 8; i < size - 8; i++) {
    setFn(6, i, i % 2 === 0);
    setFn(i, 6, i % 2 === 0);
  }

  // Alignment patterns, skipping those that collide with finders.
  const centres = ALIGNMENT[version];
  for (const r of centres) {
    for (const c of centres) {
      const nearFinder =
        (r <= 8 && c <= 8) || (r <= 8 && c >= size - 9) || (r >= size - 9 && c <= 8);
      if (nearFinder) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const ring = Math.max(Math.abs(dr), Math.abs(dc));
          setFn(r + dr, c + dc, ring !== 1);
        }
      }
    }
  }

  // Dark module.
  setFn(size - 8, 8, true);

  // Reserve the format areas.
  for (let i = 0; i < 9; i++) {
    if (!reserved[8][i]) {
      modules[8][i] = false;
      reserved[8][i] = true;
    }
    if (!reserved[i][8]) {
      modules[i][8] = false;
      reserved[i][8] = true;
    }
  }
  for (let i = 0; i < 8; i++) {
    if (!reserved[8][size - 1 - i]) {
      modules[8][size - 1 - i] = false;
      reserved[8][size - 1 - i] = true;
    }
    if (!reserved[size - 1 - i][8]) {
      modules[size - 1 - i][8] = false;
      reserved[size - 1 - i][8] = true;
    }
  }

  // Reserve the version areas.
  if (version >= 7) {
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 3; j++) {
        modules[size - 11 + j][i] = false;
        reserved[size - 11 + j][i] = true;
        modules[i][size - 11 + j] = false;
        reserved[i][size - 11 + j] = true;
      }
    }
  }

  return { modules, reserved };
}

function placeData(
  modules: (boolean | null)[][],
  reserved: boolean[][],
  codewords: number[],
  size: number,
): void {
  let bitIndex = 0;
  let upward = true;

  for (let right = size - 1; right > 0; right -= 2) {
    // Column 6 is the vertical timing pattern and is skipped entirely.
    if (right === 6) right = 5;
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step;
      for (let k = 0; k < 2; k++) {
        const col = right - k;
        if (reserved[row][col]) continue;
        const byte = codewords[bitIndex >>> 3];
        const bit = byte === undefined ? 0 : (byte >>> (7 - (bitIndex & 7))) & 1;
        modules[row][col] = bit === 1;
        bitIndex++;
      }
    }
    upward = !upward;
  }
}

function maskBit(mask: number, r: number, c: number): boolean {
  switch (mask) {
    case 0: return (r + c) % 2 === 0;
    case 1: return r % 2 === 0;
    case 2: return c % 3 === 0;
    case 3: return (r + c) % 3 === 0;
    case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
    case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
    default: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
  }
}

function penalty(grid: boolean[][], size: number): number {
  let score = 0;

  // Rule 1: runs of five or more.
  for (let i = 0; i < size; i++) {
    for (const horizontal of [true, false]) {
      let run = 1;
      for (let j = 1; j < size; j++) {
        const a = horizontal ? grid[i][j] : grid[j][i];
        const b = horizontal ? grid[i][j - 1] : grid[j - 1][i];
        if (a === b) {
          run++;
        } else {
          if (run >= 5) score += 3 + (run - 5);
          run = 1;
        }
      }
      if (run >= 5) score += 3 + (run - 5);
    }
  }

  // Rule 2: 2x2 blocks of one colour.
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = grid[r][c];
      if (v === grid[r][c + 1] && v === grid[r + 1][c] && v === grid[r + 1][c + 1]) score += 3;
    }
  }

  // Rule 3: finder-like patterns.
  const p1 = [true, false, true, true, true, false, true, false, false, false, false];
  const p2 = [false, false, false, false, true, false, true, true, true, false, true];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      for (const horizontal of [true, false]) {
        if (horizontal ? c + 11 > size : r + 11 > size) continue;
        let m1 = true;
        let m2 = true;
        for (let k = 0; k < 11; k++) {
          const v = horizontal ? grid[r][c + k] : grid[r + k][c];
          if (v !== p1[k]) m1 = false;
          if (v !== p2[k]) m2 = false;
        }
        if (m1) score += 40;
        if (m2) score += 40;
      }
    }
  }

  // Rule 4: overall balance of dark modules.
  let dark = 0;
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (grid[r][c]) dark++;
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;

  return score;
}

function writeFormat(grid: boolean[][], size: number, mask: number): void {
  const bits = FORMAT_M[mask];
  for (let i = 0; i < 15; i++) {
    const on = ((bits >>> i) & 1) === 1;
    // Top-left copy.
    if (i < 6) grid[8][i] = on;
    else if (i === 6) grid[8][7] = on;
    else if (i === 7) grid[8][8] = on;
    else if (i === 8) grid[7][8] = on;
    else grid[14 - i][8] = on;
    // Split copy beside the other two finders.
    if (i < 8) grid[8][size - 1 - i] = on;
    else grid[size - 15 + i][8] = on;
  }
  grid[size - 8][8] = true;
}

function writeVersion(grid: boolean[][], size: number, version: number): void {
  if (version < 7) return;
  const bits = VERSION_BITS[version];
  for (let i = 0; i < 18; i++) {
    const on = ((bits >>> i) & 1) === 1;
    const r = Math.floor(i / 3);
    const c = i % 3;
    grid[size - 11 + c][r] = on;
    grid[r][size - 11 + c] = on;
  }
}

/** Encodes `text` and returns the module grid; true means a dark module. */
export function qrMatrix(text: string): boolean[][] {
  const bytes = Array.from(new TextEncoder().encode(text));
  const version = chooseVersion(bytes.length);
  const size = version * 4 + 17;
  const codewords = buildCodewords(bytes, version);

  const { modules, reserved } = placeFunctionPatterns(size, version);
  placeData(modules, reserved, codewords, size);

  let best: boolean[][] | null = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const grid: boolean[][] = modules.map((row, r) =>
      row.map((value, c) => {
        const v = value === null ? false : value;
        return reserved[r][c] ? v : v !== maskBit(mask, r, c);
      }),
    );
    writeFormat(grid, size, mask);
    writeVersion(grid, size, version);
    const score = penalty(grid, size);
    if (score < bestScore) {
      bestScore = score;
      best = grid;
    }
  }
  void EC_LEVEL_M;
  return best!;
}

/** Renders a matrix as a standalone SVG string. */
export function qrSvg(text: string, options: { light?: string; dark?: string } = {}): string {
  const grid = qrMatrix(text);
  const size = grid.length;
  const quiet = 4;
  const total = size + quiet * 2;
  const light = options.light ?? '#ffffff';
  const dark = options.dark ?? '#141a33';

  let path = '';
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (grid[r][c]) path += `M${c + quiet} ${r + quiet}h1v1h-1z`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges"><rect width="${total}" height="${total}" fill="${light}"/><path d="${path}" fill="${dark}"/></svg>`;
}
