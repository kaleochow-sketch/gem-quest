/**
 * Animated, hand-drawn backdrops: one storybook scene per region, painted
 * behind every screen. Everything is drawn in code so the game stays a single
 * offline bundle with nothing to download.
 *
 * Each scene has three parts: a static back layer (sky and far scenery) and a
 * static front layer (near ground), both painted once per size into offscreen
 * canvases, and a light animated layer between them. The animation is
 * stateless — every moving thing is a pure function of time — so there is
 * nothing to update, only to draw, and it runs at a modest frame rate.
 */

type Painter = (g: CanvasRenderingContext2D, w: number, h: number) => void;
type Animator = (g: CanvasRenderingContext2D, w: number, h: number, t: number) => void;

interface Scene {
  /** Solid colour behind everything, also used for the browser chrome. */
  base: string;
  back: Painter;
  anim: Animator;
  front: Painter;
}

const TAU = Math.PI * 2;

/* ------------------------------------------------------------------ *
 * Small deterministic helpers
 * ------------------------------------------------------------------ */

/** Seeded random, so a scene lays out the same way every time it is drawn. */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let x = s;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/** A stable pseudo-random value for particle `i`, in 0..1. */
function hash(i: number, salt = 0): number {
  const x = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453;
  return x - Math.floor(x);
}

function vGradient(
  g: CanvasRenderingContext2D,
  y0: number,
  y1: number,
  stops: [number, string][],
): CanvasGradient {
  const grad = g.createLinearGradient(0, y0, 0, y1);
  for (const [at, color] of stops) grad.addColorStop(at, color);
  return grad;
}

function sky(g: CanvasRenderingContext2D, w: number, h: number, stops: [number, string][]): void {
  g.fillStyle = vGradient(g, 0, h, stops);
  g.fillRect(0, 0, w, h);
}

function glow(g: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, alpha = 1): void {
  const grad = g.createRadialGradient(x, y, 0, x, y, r);
  grad.addColorStop(0, color);
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.save();
  g.globalAlpha = alpha;
  g.fillStyle = grad;
  g.fillRect(x - r, y - r, r * 2, r * 2);
  g.restore();
}

/** A rolling ridge line filled down to the bottom of the canvas. */
function ridge(
  g: CanvasRenderingContext2D,
  w: number,
  h: number,
  baseY: number,
  amp: number,
  waves: [number, number][],
  fill: string | CanvasGradient,
): void {
  g.beginPath();
  g.moveTo(0, h);
  for (let x = 0; x <= w + 8; x += 8) {
    let y = baseY;
    for (const [freq, phase] of waves) y += Math.sin((x / w) * freq * TAU + phase) * amp;
    g.lineTo(x, y);
  }
  g.lineTo(w, h);
  g.closePath();
  g.fillStyle = fill;
  g.fill();
}

/** Height of a ridge at x, matching `ridge`, so things can stand on it. */
function ridgeY(x: number, w: number, baseY: number, amp: number, waves: [number, number][]): number {
  let y = baseY;
  for (const [freq, phase] of waves) y += Math.sin((x / w) * freq * TAU + phase) * amp;
  return y;
}

/** A puffy cartoon cloud with a soft shaded underside. */
function cloud(g: CanvasRenderingContext2D, x: number, y: number, s: number, tint = '#ffffff', shade = '#e0e9f5'): void {
  const puffs: [number, number, number][] = [
    [-1.1, 0.15, 0.62],
    [-0.45, -0.25, 0.85],
    [0.35, -0.38, 0.95],
    [1.05, 0.0, 0.7],
    [0.0, 0.2, 0.8],
  ];
  g.save();
  g.translate(x, y);
  g.fillStyle = shade;
  for (const [px, py, pr] of puffs) {
    g.beginPath();
    g.arc(px * s, py * s + s * 0.1, pr * s, 0, TAU);
    g.fill();
  }
  g.fillStyle = tint;
  for (const [px, py, pr] of puffs) {
    g.beginPath();
    g.arc(px * s, py * s - s * 0.04, pr * s * 0.93, 0, TAU);
    g.fill();
  }
  g.restore();
}

/** A happy face: closed ^^ eyes, rosy cheeks and a little smile. */
function face(g: CanvasRenderingContext2D, x: number, y: number, s: number, ink = '#7a3b2e', blush = 'rgba(255,120,140,0.55)'): void {
  g.save();
  g.translate(x, y);
  g.strokeStyle = ink;
  g.lineCap = 'round';
  g.lineWidth = Math.max(1.5, s * 0.09);
  for (const side of [-1, 1]) {
    g.beginPath();
    g.arc(side * s * 0.36, -s * 0.02, s * 0.13, Math.PI * 1.1, Math.PI * 1.9);
    g.stroke();
  }
  g.beginPath();
  g.arc(0, s * 0.14, s * 0.14, Math.PI * 0.15, Math.PI * 0.85);
  g.stroke();
  g.fillStyle = blush;
  for (const side of [-1, 1]) {
    g.beginPath();
    g.ellipse(side * s * 0.56, s * 0.17, s * 0.14, s * 0.09, 0, 0, TAU);
    g.fill();
  }
  g.restore();
}

function sun(g: CanvasRenderingContext2D, x: number, y: number, r: number, inner: string, outer: string, smile = true): void {
  glow(g, x, y, r * 3.2, 'rgba(255,240,200,0.75)');
  const body = g.createRadialGradient(x - r * 0.3, y - r * 0.35, r * 0.1, x, y, r);
  body.addColorStop(0, inner);
  body.addColorStop(1, outer);
  g.fillStyle = body;
  g.beginPath();
  g.arc(x, y, r, 0, TAU);
  g.fill();
  if (smile) face(g, x, y + r * 0.08, r * 0.62, 'rgba(150,70,30,0.8)');
}

function sparkle(g: CanvasRenderingContext2D, x: number, y: number, s: number, color = '#ffffff'): void {
  g.fillStyle = color;
  g.beginPath();
  g.moveTo(x, y - s);
  g.quadraticCurveTo(x, y, x + s, y);
  g.quadraticCurveTo(x, y, x, y + s);
  g.quadraticCurveTo(x, y, x - s, y);
  g.quadraticCurveTo(x, y, x, y - s);
  g.fill();
}

/** A round, bushy cartoon tree with a lit side. */
function roundTree(g: CanvasRenderingContext2D, x: number, y: number, s: number, leaf: string, leafLight: string, trunk = '#9a6a45'): void {
  g.fillStyle = trunk;
  g.beginPath();
  g.roundRect(x - s * 0.12, y - s * 0.9, s * 0.24, s * 0.9, s * 0.08);
  g.fill();
  const puffs: [number, number, number][] = [[-0.45, -1.15, 0.5], [0.45, -1.2, 0.5], [0, -1.6, 0.6], [0, -1.05, 0.55]];
  g.fillStyle = leaf;
  for (const [px, py, pr] of puffs) {
    g.beginPath();
    g.arc(x + px * s, y + py * s, pr * s, 0, TAU);
    g.fill();
  }
  g.fillStyle = leafLight;
  g.beginPath();
  g.arc(x - s * 0.2, y - s * 1.75, s * 0.28, 0, TAU);
  g.fill();
}

function pine(g: CanvasRenderingContext2D, x: number, y: number, s: number, color: string, snow: string | null): void {
  g.fillStyle = '#7a5a48';
  g.fillRect(x - s * 0.08, y - s * 0.3, s * 0.16, s * 0.3);
  for (let i = 0; i < 3; i++) {
    const ty = y - s * 0.25 - i * s * 0.42;
    const tw = s * (0.62 - i * 0.14);
    g.fillStyle = color;
    g.beginPath();
    g.moveTo(x, ty - s * 0.62);
    g.quadraticCurveTo(x + tw * 0.4, ty - s * 0.2, x + tw, ty);
    g.quadraticCurveTo(x, ty + s * 0.08, x - tw, ty);
    g.quadraticCurveTo(x - tw * 0.4, ty - s * 0.2, x, ty - s * 0.62);
    g.fill();
    if (snow) {
      g.fillStyle = snow;
      g.beginPath();
      g.moveTo(x, ty - s * 0.62);
      g.quadraticCurveTo(x + tw * 0.3, ty - s * 0.38, x + tw * 0.45, ty - s * 0.3);
      g.quadraticCurveTo(x, ty - s * 0.36, x - tw * 0.45, ty - s * 0.3);
      g.quadraticCurveTo(x - tw * 0.3, ty - s * 0.38, x, ty - s * 0.62);
      g.fill();
    }
  }
}

/** Soft, rounded mountain with an optional snow cap. */
function mountain(g: CanvasRenderingContext2D, x: number, baseY: number, wHalf: number, height: number, color: string, shade: string, cap: string | null): void {
  const top = baseY - height;
  g.fillStyle = color;
  g.beginPath();
  g.moveTo(x - wHalf, baseY);
  g.quadraticCurveTo(x - wHalf * 0.35, top + height * 0.1, x, top);
  g.quadraticCurveTo(x + wHalf * 0.35, top + height * 0.1, x + wHalf, baseY);
  g.closePath();
  g.fill();
  // Shadowed right flank gives it volume.
  g.fillStyle = shade;
  g.beginPath();
  g.moveTo(x, top);
  g.quadraticCurveTo(x + wHalf * 0.35, top + height * 0.1, x + wHalf, baseY);
  g.lineTo(x + wHalf * 0.15, baseY);
  g.quadraticCurveTo(x + wHalf * 0.05, top + height * 0.5, x, top);
  g.fill();
  if (cap) {
    const capY = top + height * 0.3;
    g.fillStyle = cap;
    g.beginPath();
    g.moveTo(x, top);
    g.quadraticCurveTo(x + wHalf * 0.12, top + height * 0.12, x + wHalf * 0.25, capY);
    g.quadraticCurveTo(x + wHalf * 0.12, capY - height * 0.05, x + wHalf * 0.02, capY + height * 0.03);
    g.quadraticCurveTo(x - wHalf * 0.1, capY - height * 0.06, x - wHalf * 0.25, capY);
    g.quadraticCurveTo(x - wHalf * 0.12, top + height * 0.12, x, top);
    g.fill();
  }
}

function gear(g: CanvasRenderingContext2D, x: number, y: number, r: number, teeth: number, angle: number, color: string, hub: string): void {
  g.save();
  g.translate(x, y);
  g.rotate(angle);
  g.fillStyle = color;
  g.beginPath();
  for (let i = 0; i < teeth * 2; i++) {
    const a = (i / (teeth * 2)) * TAU;
    const rr = i % 2 === 0 ? r : r * 0.82;
    const a2 = ((i + 1) / (teeth * 2)) * TAU;
    g.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
    g.lineTo(Math.cos(a2) * rr, Math.sin(a2) * rr);
  }
  g.closePath();
  g.fill();
  g.fillStyle = hub;
  g.beginPath();
  g.arc(0, 0, r * 0.45, 0, TAU);
  g.fill();
  g.fillStyle = color;
  g.beginPath();
  g.arc(0, 0, r * 0.18, 0, TAU);
  g.fill();
  g.restore();
}

function crystal(g: CanvasRenderingContext2D, x: number, y: number, s: number, tilt: number, light: string, mid: string, dark: string): void {
  g.save();
  g.translate(x, y);
  g.rotate(tilt);
  g.fillStyle = mid;
  g.beginPath();
  g.moveTo(-s * 0.3, 0);
  g.lineTo(-s * 0.3, -s * 1.2);
  g.lineTo(0, -s * 1.7);
  g.lineTo(s * 0.3, -s * 1.2);
  g.lineTo(s * 0.3, 0);
  g.closePath();
  g.fill();
  g.fillStyle = light;
  g.beginPath();
  g.moveTo(-s * 0.3, 0);
  g.lineTo(-s * 0.3, -s * 1.2);
  g.lineTo(0, -s * 1.7);
  g.lineTo(0, 0);
  g.closePath();
  g.fill();
  g.fillStyle = dark;
  g.globalAlpha = 0.35;
  g.fillRect(s * 0.1, -s * 1.15, s * 0.2, s * 1.15);
  g.restore();
}

/** Drifting position on a loop of length `span` starting at `offset`. */
function drift(t: number, speed: number, offset: number, span: number): number {
  return ((offset + t * speed) % span + span) % span;
}

/* ------------------------------------------------------------------ *
 * The ten scenes
 * ------------------------------------------------------------------ */

const SCENES: Scene[] = [
  // 0 — Sunrise Shore: peach dawn over a sparkling sea and a sandy beach.
  {
    base: '#ffd6b8',
    back(g, w, h) {
      sky(g, w, h, [[0, '#8fd3ff'], [0.35, '#ffe2c2'], [0.55, '#ffe9c9'], [1, '#fff0d6']]);
      sun(g, w * 0.72, h * 0.2, Math.min(w, h) * 0.09, '#fff7d6', '#ffbf5e');
      const seaTop = h * 0.6;
      g.fillStyle = vGradient(g, seaTop, h, [[0, '#7fd8f0'], [0.5, '#4fb8e3'], [1, '#3a9bd0']]);
      g.fillRect(0, seaTop, w, h - seaTop);
      // Far island silhouette, hazy with distance.
      g.fillStyle = 'rgba(120,180,200,0.55)';
      g.beginPath();
      g.ellipse(w * 0.18, seaTop + 2, w * 0.16, h * 0.035, 0, Math.PI, TAU);
      g.fill();
    },
    anim(g, w, h, t) {
      for (let i = 0; i < 4; i++) {
        const x = drift(t, 6 + i * 2, hash(i) * w * 1.4, w * 1.4) - w * 0.2;
        cloud(g, x, h * (0.08 + hash(i, 2) * 0.22), Math.min(w, h) * (0.04 + hash(i, 3) * 0.03), '#ffffff', '#ffe6cc');
      }
      // Wave glints and sun path sparkles on the water.
      const seaTop = h * 0.6;
      for (let i = 0; i < 40; i++) {
        const y = seaTop + 6 + hash(i, 4) * (h * 0.26);
        const x = (hash(i, 5) * w + Math.sin(t * 0.8 + i) * 12) % w;
        const a = 0.35 + 0.35 * Math.sin(t * 2.2 + i * 1.7);
        g.fillStyle = `rgba(255,255,255,${a})`;
        g.beginPath();
        g.ellipse(x, y, 6 + hash(i, 6) * 10, 1.6, 0, 0, TAU);
        g.fill();
      }
      // A pair of gulls bobbing along.
      for (let i = 0; i < 2; i++) {
        const x = drift(t, 18, i * w * 0.6, w * 1.3) - w * 0.15;
        const y = h * (0.14 + i * 0.07) + Math.sin(t * 1.4 + i) * 6;
        const flap = Math.sin(t * 6 + i) * 4;
        g.strokeStyle = 'rgba(90,70,110,0.7)';
        g.lineWidth = 2.2;
        g.lineCap = 'round';
        g.beginPath();
        g.moveTo(x - 10, y - flap * 0.5);
        g.quadraticCurveTo(x - 5, y - 6 - flap, x, y);
        g.quadraticCurveTo(x + 5, y - 6 - flap, x + 10, y - flap * 0.5);
        g.stroke();
      }
    },
    front(g, w, h) {
      // Foam line and beach.
      const beach = h * 0.86;
      g.fillStyle = 'rgba(255,255,255,0.85)';
      ridge(g, w, h, beach - 6, 6, [[3, 0.4], [7, 1.3]], 'rgba(255,255,255,0.85)');
      ridge(g, w, h, beach, 6, [[3, 0.4], [7, 1.3]], vGradient(g, beach - 10, h, [[0, '#ffe6b0'], [1, '#f6c98a']]));
      // Shells and starfish.
      const rand = seeded(11);
      for (let i = 0; i < 7; i++) {
        const x = rand() * w;
        const y = beach + 14 + rand() * (h - beach - 20);
        if (i % 2) {
          sparkle(g, x, y, 7, '#ff9f8a');
        } else {
          g.fillStyle = '#fff1f4';
          g.beginPath();
          g.arc(x, y, 6, Math.PI, TAU);
          g.fill();
        }
      }
      // A friendly palm on the left edge.
      const px = w * 0.06;
      g.strokeStyle = '#b07a4c';
      g.lineWidth = Math.max(8, w * 0.018);
      g.lineCap = 'round';
      g.beginPath();
      g.moveTo(px, h);
      g.quadraticCurveTo(px + w * 0.06, h * 0.82, px + w * 0.03, h * 0.68);
      g.stroke();
      const top = { x: px + w * 0.03, y: h * 0.68 };
      g.fillStyle = '#4cc38a';
      for (let i = 0; i < 6; i++) {
        const a = -Math.PI / 2 + (i - 2.5) * 0.55;
        g.save();
        g.translate(top.x, top.y);
        g.rotate(a);
        g.beginPath();
        g.ellipse(w * 0.06, 0, w * 0.065, w * 0.016, 0.25, 0, TAU);
        g.fill();
        g.restore();
      }
    },
  },

  // 1 — Emerald Grove: mint sky, rolling hills, bushy trees, fireflies.
  {
    base: '#c8f0cf',
    back(g, w, h) {
      sky(g, w, h, [[0, '#a8e6ff'], [0.5, '#d8f7e4'], [1, '#e9fbe6']]);
      sun(g, w * 0.2, h * 0.14, Math.min(w, h) * 0.07, '#fffbe0', '#ffd966');
      ridge(g, w, h, h * 0.58, h * 0.03, [[1.5, 0.3], [3, 1]], '#a9e2b4');
      ridge(g, w, h, h * 0.66, h * 0.035, [[1.2, 2], [2.6, 0.2]], '#86d39a');
      const rand = seeded(21);
      for (let i = 0; i < 9; i++) {
        const x = rand() * w;
        const y = ridgeY(x, w, h * 0.66, h * 0.035, [[1.2, 2], [2.6, 0.2]]);
        roundTree(g, x, y + 4, Math.min(w, h) * (0.035 + rand() * 0.02), '#5fbf7a', '#8fe0a2');
      }
    },
    anim(g, w, h, t) {
      for (let i = 0; i < 3; i++) {
        const x = drift(t, 5 + i * 2, hash(i, 9) * w * 1.4, w * 1.4) - w * 0.2;
        cloud(g, x, h * (0.06 + hash(i, 1) * 0.16), Math.min(w, h) * 0.045);
      }
      // Fireflies and drifting petals.
      for (let i = 0; i < 26; i++) {
        const x = (hash(i, 3) * w + Math.sin(t * 0.5 + i) * 30) % w;
        const y = h * 0.45 + hash(i, 4) * h * 0.5 + Math.cos(t * 0.7 + i * 2) * 18;
        const a = 0.25 + 0.6 * Math.max(0, Math.sin(t * 1.6 + i * 2.3));
        glow(g, x, y, 10, `rgba(255,250,170,${a})`);
        g.fillStyle = `rgba(255,255,220,${a})`;
        g.beginPath();
        g.arc(x, y, 2, 0, TAU);
        g.fill();
      }
    },
    front(g, w, h) {
      const waves: [number, number][] = [[1, 0.8], [2.4, 2]];
      ridge(g, w, h, h * 0.86, h * 0.03, waves, vGradient(g, h * 0.8, h, [[0, '#6cc985'], [1, '#4fae6b']]));
      const rand = seeded(23);
      for (let i = 0; i < 14; i++) {
        const x = rand() * w;
        const y = ridgeY(x, w, h * 0.86, h * 0.03, waves) + 10 + rand() * 30;
        if (i % 3 === 0) {
          // Little red mushroom.
          g.fillStyle = '#fff4e6';
          g.fillRect(x - 3, y - 8, 6, 9);
          g.fillStyle = '#ff6b6b';
          g.beginPath();
          g.ellipse(x, y - 8, 10, 7, 0, Math.PI, TAU);
          g.fill();
          g.fillStyle = '#fff';
          g.beginPath();
          g.arc(x - 3, y - 11, 1.8, 0, TAU);
          g.arc(x + 4, y - 10, 1.4, 0, TAU);
          g.fill();
        } else {
          // Daisy.
          for (let p = 0; p < 6; p++) {
            const a = (p / 6) * TAU;
            g.fillStyle = '#ffffff';
            g.beginPath();
            g.ellipse(x + Math.cos(a) * 4, y + Math.sin(a) * 4, 3.4, 2, a, 0, TAU);
            g.fill();
          }
          g.fillStyle = '#ffd23f';
          g.beginPath();
          g.arc(x, y, 2.6, 0, TAU);
          g.fill();
        }
      }
    },
  },

  // 2 — Frostpeak Pass: snowy peaks, frosted pines, gentle snowfall.
  {
    base: '#dcecff',
    back(g, w, h) {
      sky(g, w, h, [[0, '#9fd0ff'], [0.55, '#e2f1ff'], [1, '#f5f9ff']]);
      const s = Math.min(w, h);
      mountain(g, w * 0.2, h * 0.66, w * 0.38, h * 0.32, '#b9cdf0', '#9fb6e2', '#ffffff');
      mountain(g, w * 0.75, h * 0.66, w * 0.42, h * 0.4, '#c6d6f5', '#a9bde6', '#ffffff');
      mountain(g, w * 0.5, h * 0.7, w * 0.3, h * 0.24, '#d4e1fa', '#b6c8ee', '#ffffff');
      ridge(g, w, h, h * 0.7, h * 0.02, [[1.4, 0.4]], '#f1f6ff');
      const rand = seeded(31);
      for (let i = 0; i < 10; i++) {
        const x = rand() * w;
        pine(g, x, h * 0.72 + rand() * 10, s * (0.05 + rand() * 0.03), '#6aa7a0', '#ffffff');
      }
    },
    anim(g, w, h, t) {
      for (let i = 0; i < 70; i++) {
        const speed = 18 + hash(i, 1) * 26;
        const y = drift(t, speed, hash(i, 2) * h, h + 20) - 10;
        const x = (hash(i, 3) * w + Math.sin(t * 0.8 + i) * 16 + w) % w;
        const r = 1.2 + hash(i, 4) * 2.6;
        g.fillStyle = `rgba(255,255,255,${0.6 + hash(i, 5) * 0.4})`;
        g.beginPath();
        g.arc(x, y, r, 0, TAU);
        g.fill();
      }
    },
    front(g, w, h) {
      const waves: [number, number][] = [[1.2, 0.2], [3, 1.5]];
      ridge(g, w, h, h * 0.88, h * 0.025, waves, vGradient(g, h * 0.84, h, [[0, '#ffffff'], [1, '#dbe8fb']]));
      const s = Math.min(w, h);
      pine(g, w * 0.07, h * 0.97, s * 0.12, '#4f9488', '#ffffff');
      pine(g, w * 0.94, h * 0.98, s * 0.1, '#4f9488', '#ffffff');
      // A tiny snowman, because of course.
      const sx = w * 0.82;
      const sy = h * 0.94;
      g.fillStyle = '#ffffff';
      g.beginPath();
      g.arc(sx, sy, s * 0.03, 0, TAU);
      g.arc(sx, sy - s * 0.042, s * 0.022, 0, TAU);
      g.fill();
      g.fillStyle = '#ff8c42';
      g.beginPath();
      g.moveTo(sx, sy - s * 0.044);
      g.lineTo(sx + s * 0.018, sy - s * 0.04);
      g.lineTo(sx, sy - s * 0.037);
      g.fill();
      g.fillStyle = '#ff6b8a';
      g.fillRect(sx - s * 0.02, sy - s * 0.026, s * 0.04, s * 0.008);
    },
  },

  // 3 — Amber Desert: honey sky, layered dunes, pyramids, cheerful cacti.
  {
    base: '#ffe1a8',
    back(g, w, h) {
      sky(g, w, h, [[0, '#ffc98f'], [0.45, '#ffe5b4'], [1, '#fff0cf']]);
      sun(g, w * 0.5, h * 0.22, Math.min(w, h) * 0.11, '#fffbe6', '#ffb347');
      // Pyramids, hazy in the distance.
      for (const [x, s, c] of [[0.25, 0.14, '#f2c27d'], [0.38, 0.09, '#efc489']] as [number, number, string][]) {
        const base = h * 0.6;
        const half = w * s;
        g.fillStyle = c;
        g.beginPath();
        g.moveTo(w * x - half, base);
        g.lineTo(w * x, base - half * 0.85);
        g.lineTo(w * x + half, base);
        g.fill();
        g.fillStyle = 'rgba(180,110,50,0.25)';
        g.beginPath();
        g.moveTo(w * x, base - half * 0.85);
        g.lineTo(w * x + half, base);
        g.lineTo(w * x + half * 0.2, base);
        g.fill();
      }
      ridge(g, w, h, h * 0.62, h * 0.03, [[1.3, 0.5], [2.2, 2]], '#ffd28e');
      ridge(g, w, h, h * 0.7, h * 0.04, [[1, 2.4], [2.7, 0.6]], '#ffc677');
    },
    anim(g, w, h, t) {
      // Heat shimmer sparkles and wind-blown sand.
      for (let i = 0; i < 30; i++) {
        const x = drift(t, 30 + hash(i, 1) * 50, hash(i, 2) * w, w + 40) - 20;
        const y = h * 0.55 + hash(i, 3) * h * 0.4 + Math.sin(t * 3 + i) * 3;
        g.fillStyle = `rgba(255,240,200,${0.35 + hash(i, 4) * 0.4})`;
        g.beginPath();
        g.ellipse(x, y, 5 + hash(i, 5) * 8, 1.2, 0, 0, TAU);
        g.fill();
      }
      for (let i = 0; i < 6; i++) {
        const a = 0.5 + 0.5 * Math.sin(t * 2 + i * 1.9);
        sparkle(g, hash(i, 7) * w, h * 0.08 + hash(i, 8) * h * 0.3, 3 + a * 5, `rgba(255,255,255,${a * 0.8})`);
      }
    },
    front(g, w, h) {
      const waves: [number, number][] = [[1.1, 1.2], [2.5, 0.1]];
      ridge(g, w, h, h * 0.87, h * 0.03, waves, vGradient(g, h * 0.82, h, [[0, '#ffb95e'], [1, '#f0a04a']]));
      const s = Math.min(w, h);
      for (const [x, k] of [[0.1, 1], [0.9, 0.8]] as [number, number][]) {
        const cx = w * x;
        const base = ridgeY(cx, w, h * 0.87, h * 0.03, waves) + 6;
        const ch = s * 0.16 * k;
        const cw = s * 0.045 * k;
        g.fillStyle = '#62c08a';
        g.beginPath();
        g.roundRect(cx - cw / 2, base - ch, cw, ch, cw / 2);
        g.roundRect(cx - cw * 1.7, base - ch * 0.7, cw * 0.8, ch * 0.32, cw * 0.4);
        g.roundRect(cx - cw * 1.7, base - ch * 0.48, cw * 1.4, cw * 0.7, cw * 0.35);
        g.roundRect(cx + cw * 0.9, base - ch * 0.82, cw * 0.8, ch * 0.34, cw * 0.4);
        g.roundRect(cx + cw * 0.3, base - ch * 0.56, cw * 1.4, cw * 0.7, cw * 0.35);
        g.fill();
        face(g, cx, base - ch * 0.62, cw * 0.55, '#2f6b4a');
        g.fillStyle = '#ff8fb1';
        g.beginPath();
        g.arc(cx, base - ch - cw * 0.1, cw * 0.28, 0, TAU);
        g.fill();
      }
    },
  },

  // 4 — Coral Depths: sunbeams through blue water, coral and swaying kelp.
  {
    base: '#7fd6e6',
    back(g, w, h) {
      sky(g, w, h, [[0, '#9eefff'], [0.4, '#4cc4dc'], [1, '#2a8fbf']]);
      // Light shafts from the surface.
      g.save();
      g.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 5; i++) {
        const x = w * (0.1 + i * 0.22);
        g.fillStyle = vGradient(g, 0, h * 0.8, [[0, 'rgba(255,255,255,0.22)'], [1, 'rgba(255,255,255,0)']]);
        g.beginPath();
        g.moveTo(x - w * 0.04, 0);
        g.lineTo(x + w * 0.04, 0);
        g.lineTo(x + w * 0.16, h * 0.8);
        g.lineTo(x - w * 0.02, h * 0.8);
        g.fill();
      }
      g.restore();
      ridge(g, w, h, h * 0.78, h * 0.03, [[1.5, 0.3], [3, 2]], 'rgba(40,120,170,0.6)');
    },
    anim(g, w, h, t) {
      // Swaying kelp.
      for (let i = 0; i < 7; i++) {
        const x = w * (0.04 + hash(i, 1) * 0.92);
        const height = h * (0.18 + hash(i, 2) * 0.16);
        g.strokeStyle = i % 2 ? '#3fbf8f' : '#58d49c';
        g.lineWidth = 7;
        g.lineCap = 'round';
        g.beginPath();
        g.moveTo(x, h);
        for (let k = 1; k <= 8; k++) {
          const yy = h - (height * k) / 8;
          g.lineTo(x + Math.sin(t * 1.2 + k * 0.6 + i) * k * 2.4, yy);
        }
        g.stroke();
      }
      // Rising bubbles.
      for (let i = 0; i < 34; i++) {
        const y = h - drift(t, 24 + hash(i, 3) * 30, hash(i, 4) * h, h + 30);
        const x = hash(i, 5) * w + Math.sin(t * 2 + i) * 6;
        const r = 2 + hash(i, 6) * 5;
        g.strokeStyle = 'rgba(255,255,255,0.7)';
        g.lineWidth = 1.4;
        g.beginPath();
        g.arc(x, y, r, 0, TAU);
        g.stroke();
        g.fillStyle = 'rgba(255,255,255,0.6)';
        g.beginPath();
        g.arc(x - r * 0.35, y - r * 0.35, r * 0.25, 0, TAU);
        g.fill();
      }
      // A little fish swimming past.
      for (let i = 0; i < 3; i++) {
        const dir = i % 2 ? -1 : 1;
        const x0 = drift(t, 26 + i * 8, hash(i, 7) * w, w + 120) - 60;
        const x = dir > 0 ? x0 : w - x0;
        const y = h * (0.12 + i * 0.12) + Math.sin(t * 2 + i) * 8;
        const s = 10 + i * 3;
        g.save();
        g.translate(x, y);
        g.scale(dir, 1);
        g.fillStyle = ['#ffb347', '#ff7eb6', '#ffe066'][i];
        g.beginPath();
        g.ellipse(0, 0, s, s * 0.62, 0, 0, TAU);
        g.fill();
        g.beginPath();
        g.moveTo(-s * 0.8, 0);
        g.lineTo(-s * 1.5, -s * 0.5 + Math.sin(t * 10) * 2);
        g.lineTo(-s * 1.5, s * 0.5 + Math.sin(t * 10) * 2);
        g.fill();
        g.fillStyle = '#26324a';
        g.beginPath();
        g.arc(s * 0.45, -s * 0.12, s * 0.12, 0, TAU);
        g.fill();
        g.restore();
      }
    },
    front(g, w, h) {
      const waves: [number, number][] = [[1.3, 0.2], [2.8, 1.9]];
      ridge(g, w, h, h * 0.9, h * 0.025, waves, vGradient(g, h * 0.86, h, [[0, '#ffe2b8'], [1, '#e9c48f']]));
      const rand = seeded(41);
      const colors = ['#ff7f9e', '#ffa45c', '#c38bff', '#ff6fb1'];
      for (let i = 0; i < 8; i++) {
        const x = rand() * w;
        const base = ridgeY(x, w, h * 0.9, h * 0.025, waves) + 4;
        const s = Math.min(w, h) * (0.04 + rand() * 0.03);
        g.strokeStyle = colors[i % colors.length];
        g.lineWidth = s * 0.28;
        g.lineCap = 'round';
        for (let b = -2; b <= 2; b++) {
          g.beginPath();
          g.moveTo(x, base);
          g.quadraticCurveTo(x + b * s * 0.3, base - s, x + b * s * 0.55, base - s * (1.3 + Math.abs(b) * -0.15));
          g.stroke();
        }
      }
    },
  },

  // 5 — Thunder Mesa: lilac dusk, flat-topped mesas, storm clouds, rain.
  {
    base: '#d9c6f5',
    back(g, w, h) {
      sky(g, w, h, [[0, '#6f86c9'], [0.5, '#a9b8e6'], [1, '#f2dcc8']]);
      const base = h * 0.66;
      for (const [x, wd, ht, c] of [[0.15, 0.22, 0.16, '#c98b6f'], [0.6, 0.3, 0.22, '#b97a5f'], [0.95, 0.18, 0.12, '#d49c80']] as [number, number, number, string][]) {
        g.fillStyle = c;
        g.beginPath();
        g.moveTo(w * (x - wd / 2), base);
        g.lineTo(w * (x - wd / 2.6), base - h * ht);
        g.lineTo(w * (x + wd / 2.6), base - h * ht);
        g.lineTo(w * (x + wd / 2), base);
        g.fill();
        // Stripes in the rock.
        g.fillStyle = 'rgba(255,255,255,0.15)';
        g.fillRect(w * (x - wd / 2.5), base - h * ht * 0.6, w * wd * 0.8, h * 0.01);
        g.fillRect(w * (x - wd / 2.3), base - h * ht * 0.3, w * wd * 0.87, h * 0.01);
      }
      ridge(g, w, h, base, h * 0.01, [[2, 0.2]], '#ddae92');
    },
    anim(g, w, h, t) {
      // An occasional soft lightning flash.
      const cycle = t % 7;
      if (cycle < 0.25) {
        g.fillStyle = `rgba(255,255,240,${(0.25 - cycle) * 1.6})`;
        g.fillRect(0, 0, w, h);
        const bx = w * (0.3 + hash(Math.floor(t / 7), 1) * 0.4);
        g.strokeStyle = 'rgba(255,245,170,0.95)';
        g.lineWidth = 4;
        g.lineJoin = 'round';
        g.beginPath();
        g.moveTo(bx, h * 0.12);
        g.lineTo(bx - 14, h * 0.22);
        g.lineTo(bx + 6, h * 0.24);
        g.lineTo(bx - 10, h * 0.36);
        g.stroke();
      }
      for (let i = 0; i < 4; i++) {
        const x = drift(t, 8 + i * 2, hash(i, 3) * w * 1.4, w * 1.4) - w * 0.2;
        cloud(g, x, h * (0.06 + hash(i, 4) * 0.14), Math.min(w, h) * (0.05 + hash(i, 5) * 0.03), '#e8eefb', '#aebbdc');
      }
      g.strokeStyle = 'rgba(255,255,255,0.35)';
      g.lineWidth = 1.4;
      for (let i = 0; i < 50; i++) {
        const y = drift(t, 260 + hash(i, 6) * 120, hash(i, 7) * h, h + 40) - 20;
        const x = (hash(i, 8) * w + y * 0.15) % w;
        g.beginPath();
        g.moveTo(x, y);
        g.lineTo(x - 3, y + 12);
        g.stroke();
      }
    },
    front(g, w, h) {
      const waves: [number, number][] = [[1.2, 0.5], [2.6, 2.2]];
      ridge(g, w, h, h * 0.88, h * 0.02, waves, vGradient(g, h * 0.84, h, [[0, '#c98f72'], [1, '#a9705a']]));
      const rand = seeded(51);
      for (let i = 0; i < 6; i++) {
        const x = rand() * w;
        const y = ridgeY(x, w, h * 0.88, h * 0.02, waves) + 14 + rand() * 20;
        crystal(g, x, y, 10 + rand() * 8, (rand() - 0.5) * 0.6, '#fff3a8', '#ffd84d', '#c79a00');
      }
    },
  },

  // 6 — Obsidian Mines: a cosy cave lit by glowing crystals and lanterns.
  {
    base: '#4a3a6b',
    back(g, w, h) {
      sky(g, w, h, [[0, '#2f2550'], [0.5, '#4a3a6b'], [1, '#5c4580']]);
      glow(g, w * 0.5, h * 0.45, Math.max(w, h) * 0.6, 'rgba(255,170,120,0.25)');
      // Stalactites along the top.
      const rand = seeded(61);
      g.fillStyle = '#3a2d5c';
      for (let i = 0; i < 14; i++) {
        const x = (i / 13) * w;
        const len = h * (0.05 + rand() * 0.1);
        g.beginPath();
        g.moveTo(x - w * 0.04, 0);
        g.quadraticCurveTo(x, len * 0.6, x, len);
        g.quadraticCurveTo(x, len * 0.6, x + w * 0.04, 0);
        g.fill();
      }
      ridge(g, w, h, h * 0.74, h * 0.04, [[2, 0.4], [4, 1.1]], '#3f3163');
    },
    anim(g, w, h, t) {
      // Glowing crystal clusters that pulse slowly.
      const spots: [number, number, string][] = [[0.1, 0.8, '#7fe3ff'], [0.9, 0.76, '#ff8fe0'], [0.06, 0.48, '#b7a4ff'], [0.95, 0.4, '#7fe3ff'], [0.22, 0.12, '#7fe3ff'], [0.82, 0.1, '#ff8fe0']];
      spots.forEach(([x, y, c], i) => {
        const pulse = 0.55 + 0.25 * Math.sin(t * 1.5 + i);
        glow(g, w * x, h * y, Math.min(w, h) * 0.16, c, pulse * 0.5);
      });
      // Floating embers.
      for (let i = 0; i < 28; i++) {
        const y = h - drift(t, 12 + hash(i, 1) * 16, hash(i, 2) * h, h + 20);
        const x = hash(i, 3) * w + Math.sin(t + i) * 10;
        const a = 0.3 + 0.5 * Math.max(0, Math.sin(t * 2 + i));
        g.fillStyle = `rgba(255,${180 + Math.floor(hash(i, 4) * 60)},140,${a})`;
        g.beginPath();
        g.arc(x, y, 1.6 + hash(i, 5) * 1.6, 0, TAU);
        g.fill();
      }
    },
    front(g, w, h) {
      const s = Math.min(w, h);
      ridge(g, w, h, h * 0.84, h * 0.025, [[1.6, 0.7]], vGradient(g, h * 0.8, h, [[0, '#5b477f'], [1, '#3a2d5c']]));
      const clusters: [number, number, string, string, string][] = [
        [0.1, 0.84, '#d9f8ff', '#7fe3ff', '#2a8bb3'],
        [0.9, 0.8, '#ffe2f7', '#ff8fe0', '#b0408f'],
        [0.5, 1.0, '#ece6ff', '#b7a4ff', '#6b55c9'],
        [0.04, 0.52, '#ece6ff', '#b7a4ff', '#6b55c9'],
        [0.97, 0.44, '#d9f8ff', '#7fe3ff', '#2a8bb3'],
      ];
      for (const [x, y, l, m, d] of clusters) {
        crystal(g, w * x - s * 0.04, h * y, s * 0.05, -0.35, l, m, d);
        crystal(g, w * x, h * y, s * 0.075, 0, l, m, d);
        crystal(g, w * x + s * 0.045, h * y, s * 0.045, 0.4, l, m, d);
      }
      // Minecart rails.
      g.strokeStyle = '#8a6d5a';
      g.lineWidth = 3;
      g.beginPath();
      g.moveTo(0, h * 0.965);
      g.lineTo(w, h * 0.955);
      g.stroke();
    },
  },

  // 7 — Clockwork City: copper sky, rooftops, turning gears, steam puffs.
  {
    base: '#f3d2b0',
    back(g, w, h) {
      sky(g, w, h, [[0, '#ffb98a'], [0.5, '#ffdcb8'], [1, '#fbe9d4']]);
      sun(g, w * 0.8, h * 0.16, Math.min(w, h) * 0.07, '#fff5dc', '#ffb070', false);
      // Rooftop skyline with a clock tower.
      const base = h * 0.68;
      const rand = seeded(71);
      g.fillStyle = '#d99f7e';
      let x = 0;
      while (x < w) {
        const bw = w * (0.06 + rand() * 0.08);
        const bh = h * (0.08 + rand() * 0.12);
        g.beginPath();
        g.roundRect(x, base - bh, bw - 4, bh, [6, 6, 0, 0]);
        g.fill();
        x += bw;
      }
      const tx = w * 0.32;
      g.fillStyle = '#c98a67';
      g.fillRect(tx - w * 0.04, base - h * 0.32, w * 0.08, h * 0.32);
      g.beginPath();
      g.moveTo(tx - w * 0.055, base - h * 0.32);
      g.lineTo(tx, base - h * 0.4);
      g.lineTo(tx + w * 0.055, base - h * 0.32);
      g.fill();
      g.fillStyle = '#fff6e6';
      g.beginPath();
      g.arc(tx, base - h * 0.26, w * 0.028, 0, TAU);
      g.fill();
      g.strokeStyle = '#8a5a40';
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(tx, base - h * 0.26);
      g.lineTo(tx, base - h * 0.276);
      g.moveTo(tx, base - h * 0.26);
      g.lineTo(tx + w * 0.014, base - h * 0.26);
      g.stroke();
    },
    anim(g, w, h, t) {
      const s = Math.min(w, h);
      gear(g, w * 0.08, h * 0.12, s * 0.09, 10, t * 0.3, 'rgba(200,130,80,0.55)', 'rgba(255,220,180,0.6)');
      gear(g, w * 0.08 + s * 0.15, h * 0.12 + s * 0.06, s * 0.06, 8, -t * 0.45 + 0.2, 'rgba(210,150,90,0.55)', 'rgba(255,230,190,0.6)');
      gear(g, w * 0.95, h * 0.5, s * 0.1, 12, -t * 0.25, 'rgba(200,130,80,0.45)', 'rgba(255,220,180,0.5)');
      // Steam puffs from the chimneys.
      for (let i = 0; i < 12; i++) {
        const p = drift(t, 0.18, hash(i, 1), 1);
        const x = w * (0.15 + (i % 4) * 0.22) + Math.sin(p * 6 + i) * 10;
        const y = h * 0.56 - p * h * 0.3;
        const r = 8 + p * 22;
        g.fillStyle = `rgba(255,255,255,${0.55 * (1 - p)})`;
        g.beginPath();
        g.arc(x, y, r, 0, TAU);
        g.fill();
      }
    },
    front(g, w, h) {
      ridge(g, w, h, h * 0.88, h * 0.004, [[3, 0]], vGradient(g, h * 0.86, h, [[0, '#c98a67'], [1, '#a8704f']]));
      // Cobbles.
      g.fillStyle = 'rgba(255,230,200,0.35)';
      const rand = seeded(73);
      for (let i = 0; i < 40; i++) {
        g.beginPath();
        g.ellipse(rand() * w, h * 0.9 + rand() * h * 0.1, 9, 4, 0, 0, TAU);
        g.fill();
      }
      const s = Math.min(w, h);
      gear(g, w * 0.9, h * 0.97, s * 0.12, 12, 0.3, '#b97a53', '#e8b58a');
    },
  },

  // 8 — Aurora Reach: starry night, rippling aurora ribbons, snowy hills.
  {
    base: '#2b3a6b',
    back(g, w, h) {
      sky(g, w, h, [[0, '#1d2557'], [0.55, '#3a4f8f'], [1, '#6f86c4']]);
      const rand = seeded(81);
      for (let i = 0; i < 90; i++) {
        g.fillStyle = `rgba(255,255,255,${0.3 + rand() * 0.6})`;
        g.beginPath();
        g.arc(rand() * w, rand() * h * 0.6, rand() * 1.4 + 0.3, 0, TAU);
        g.fill();
      }
      // A sleepy crescent moon.
      const mx = w * 0.82;
      const my = h * 0.14;
      const mr = Math.min(w, h) * 0.06;
      glow(g, mx, my, mr * 3, 'rgba(255,250,210,0.5)');
      g.fillStyle = '#fff6c8';
      g.beginPath();
      g.arc(mx, my, mr, 0, TAU);
      g.fill();
      g.fillStyle = '#26306a';
      g.beginPath();
      g.arc(mx + mr * 0.45, my - mr * 0.2, mr * 0.85, 0, TAU);
      g.fill();
      ridge(g, w, h, h * 0.72, h * 0.03, [[1.4, 0.6], [3, 2]], '#9fb2e6');
    },
    anim(g, w, h, t) {
      g.save();
      g.globalCompositeOperation = 'lighter';
      const bands: [string, number][] = [['rgba(120,255,200,0.22)', 0], ['rgba(170,140,255,0.2)', 1.7], ['rgba(110,220,255,0.18)', 3.1]];
      for (const [color, phase] of bands) {
        for (let k = 0; k < 3; k++) {
          g.strokeStyle = color;
          g.lineWidth = h * (0.05 - k * 0.012);
          g.lineCap = 'round';
          g.beginPath();
          for (let x = -20; x <= w + 20; x += 14) {
            const y = h * (0.22 + phase * 0.03) + Math.sin(x / w * 5 + t * 0.4 + phase) * h * 0.05 + Math.sin(x / w * 11 - t * 0.6) * h * 0.012 + k * h * 0.015;
            if (x === -20) g.moveTo(x, y);
            else g.lineTo(x, y);
          }
          g.stroke();
        }
      }
      g.restore();
      for (let i = 0; i < 14; i++) {
        const a = 0.5 + 0.5 * Math.sin(t * 2.4 + i * 2.1);
        sparkle(g, hash(i, 1) * w, hash(i, 2) * h * 0.5, 2 + a * 4, `rgba(255,255,255,${a})`);
      }
    },
    front(g, w, h) {
      const waves: [number, number][] = [[1.1, 1.4], [2.7, 0.3]];
      ridge(g, w, h, h * 0.88, h * 0.03, waves, vGradient(g, h * 0.84, h, [[0, '#e8f0ff'], [1, '#b9c9ee']]));
      const s = Math.min(w, h);
      pine(g, w * 0.06, h * 0.98, s * 0.11, '#3d6a8c', '#ffffff');
      pine(g, w * 0.93, h * 0.97, s * 0.09, '#3d6a8c', '#ffffff');
      // A glowing igloo window.
      const ix = w * 0.8;
      const iy = h * 0.95;
      g.fillStyle = '#f4f8ff';
      g.beginPath();
      g.arc(ix, iy, s * 0.06, Math.PI, TAU);
      g.fill();
      glow(g, ix, iy - s * 0.015, s * 0.05, 'rgba(255,200,120,0.8)');
      g.fillStyle = '#ffcf7a';
      g.beginPath();
      g.arc(ix, iy, s * 0.02, Math.PI, TAU);
      g.fill();
    },
  },

  // 9 — Prism Citadel: pastel rainbow sky and a crystal castle on clouds.
  {
    base: '#f2d6ff',
    back(g, w, h) {
      sky(g, w, h, [[0, '#d6e4ff'], [0.3, '#e3dcff'], [0.6, '#cdefff'], [1, '#fff3d6']]);
      // A soft rainbow arc.
      const cx = w * 0.5;
      const cy = h * 0.62;
      const rainbow = ['#ff9aa2', '#ffc78a', '#fff19a', '#a8f0b8', '#9ed8ff', '#c7a8ff'];
      g.lineWidth = Math.min(w, h) * 0.025;
      rainbow.forEach((c, i) => {
        g.strokeStyle = c;
        g.globalAlpha = 0.55;
        g.beginPath();
        g.arc(cx, cy, Math.max(w, h) * 0.42 - i * g.lineWidth, Math.PI, TAU);
        g.stroke();
      });
      g.globalAlpha = 1;
      // Castle of crystal spires.
      const base = h * 0.66;
      const s = Math.min(w, h);
      for (const [x, k] of [[0.38, 0.8], [0.5, 1.2], [0.62, 0.8], [0.44, 1], [0.56, 1]] as [number, number][]) {
        crystal(g, w * x, base, s * 0.06 * k, 0, '#ffffff', '#e5d6ff', '#a98bff');
      }
      cloud(g, w * 0.5, base + s * 0.02, s * 0.09, '#ffffff', '#f0e4ff');
      cloud(g, w * 0.36, base + s * 0.03, s * 0.06, '#ffffff', '#f0e4ff');
      cloud(g, w * 0.64, base + s * 0.03, s * 0.06, '#ffffff', '#f0e4ff');
    },
    anim(g, w, h, t) {
      // Floating prisms catching the light.
      for (let i = 0; i < 9; i++) {
        const x = hash(i, 1) * w;
        const y = h * (0.1 + hash(i, 2) * 0.75) + Math.sin(t * 0.8 + i) * 10;
        const hue = (t * 30 + i * 40) % 360;
        const s = 6 + hash(i, 3) * 8;
        g.save();
        g.translate(x, y);
        g.rotate(t * 0.5 + i);
        g.fillStyle = `hsla(${hue}, 90%, 80%, 0.8)`;
        g.beginPath();
        g.moveTo(0, -s);
        g.lineTo(s * 0.8, s * 0.6);
        g.lineTo(-s * 0.8, s * 0.6);
        g.fill();
        g.restore();
      }
      for (let i = 0; i < 16; i++) {
        const a = 0.5 + 0.5 * Math.sin(t * 2 + i * 1.3);
        sparkle(g, hash(i, 5) * w, hash(i, 6) * h, 2 + a * 5, `rgba(255,255,255,${a})`);
      }
    },
    front(g, w, h) {
      const s = Math.min(w, h);
      for (let i = 0; i < 6; i++) {
        cloud(g, w * (i / 5), h * 0.97, s * 0.08, '#ffffff', '#efe2ff');
      }
    },
  },
];

/* ------------------------------------------------------------------ *
 * The live backdrop
 * ------------------------------------------------------------------ */

export class Scenery {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private region = 0;
  private back: HTMLCanvasElement | null = null;
  private front: HTMLCanvasElement | null = null;
  /** Snapshot of the previous scene, faded out over a region change. */
  private fadeFrom: HTMLCanvasElement | null = null;
  private fadeStart = 0;
  private w = 0;
  private h = 0;
  private dpr = 1;
  private raf = 0;
  private lastDraw = 0;
  private readonly started = performance.now();
  /** Fewer frames while a level is open: the board is what matters there. */
  private fps = 30;
  /** Static backdrop only, for slow devices and reduced motion. */
  private still = false;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    window.addEventListener('resize', () => this.resize());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.stop();
      else this.start();
    });
    this.resize();
    this.start();
  }

  setRegion(region: number): void {
    const next = Math.max(0, Math.min(SCENES.length - 1, region));
    if (next === this.region && this.back) return;
    if (this.back && this.w) {
      // Keep the outgoing frame so the new scene can fade in over it.
      const snap = document.createElement('canvas');
      snap.width = this.canvas.width;
      snap.height = this.canvas.height;
      snap.getContext('2d')!.drawImage(this.canvas, 0, 0);
      this.fadeFrom = snap;
      this.fadeStart = performance.now();
    }
    this.region = next;
    this.back = null;
    this.front = null;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', SCENES[next].base);
    this.draw(performance.now());
  }

  /** Lower frame rate in play; still frames for low-effects mode. */
  setMode(opts: { inGame?: boolean; lowFx?: boolean }): void {
    if (opts.inGame !== undefined) this.fps = opts.inGame ? 20 : 30;
    if (opts.lowFx !== undefined) {
      this.still = opts.lowFx || (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false);
      this.draw(performance.now());
    }
  }

  private resize(): void {
    this.dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    this.w = window.innerWidth;
    this.h = window.innerHeight;
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    this.back = null;
    this.front = null;
    this.draw(performance.now());
  }

  private layer(paint: Painter): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = this.canvas.width;
    c.height = this.canvas.height;
    const g = c.getContext('2d')!;
    g.scale(this.dpr, this.dpr);
    paint(g, this.w, this.h);
    return c;
  }

  private start(): void {
    if (this.raf) return;
    const loop = (now: number) => {
      this.raf = requestAnimationFrame(loop);
      const fading = this.fadeFrom !== null;
      if (this.still && !fading) return;
      // Hidden behind the 3D world: nothing to draw.
      if (document.body.classList.contains('in-3d')) return;
      if (!fading && now - this.lastDraw < 1000 / this.fps) return;
      this.draw(now);
    };
    this.raf = requestAnimationFrame(loop);
  }

  private stop(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private draw(now: number): void {
    if (!this.w || !this.h) return;
    this.lastDraw = now;
    const scene = SCENES[this.region];
    if (!this.back) this.back = this.layer(scene.back);
    if (!this.front) this.front = this.layer(scene.front);

    const g = this.ctx;
    const t = this.still ? 4 : (now - this.started) / 1000;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.drawImage(this.back, 0, 0);
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.save();
    scene.anim(g, this.w, this.h, t);
    g.restore();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.drawImage(this.front, 0, 0);

    if (this.fadeFrom) {
      const p = (now - this.fadeStart) / 650;
      if (p >= 1) {
        this.fadeFrom = null;
      } else {
        g.globalAlpha = 1 - p;
        g.drawImage(this.fadeFrom, 0, 0);
        g.globalAlpha = 1;
      }
    }
  }
}
