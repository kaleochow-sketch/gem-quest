/**
 * Short minigames that pay out coins and items: Fetch (timing), the daily
 * Treat Wheel, Paw-print Memory and Dig for Treasure. Each one gets a free
 * play per day from the Fun screen, and they also turn up as bonus rounds
 * between levels. They run in their own overlay so they never fight the
 * app's modal.
 */
import { audio } from '../audio/audio.js';
import { FunState, MinigameKind, Profile, today } from '../game/save.js';
import { BoosterId, PowerupId, shopItemById } from '../game/upgrades.js';

export type ItemId = BoosterId | PowerupId;

export interface Reward {
  coins: number;
  items: Partial<Record<ItemId, number>>;
  lives: number;
}

export interface FunDeps {
  profile(): Profile;
  save(): void;
  piece(color: number, px: number): string;
  dog(px: number): string;
  /** Applies a reward to the profile and refreshes the wallet. */
  grant(reward: Reward): void;
}

interface GameInfo {
  kind: MinigameKind;
  name: string;
  icon: string;
  blurb: string;
}

export const GAMES: GameInfo[] = [
  { kind: 'wheel', name: 'Treat Wheel', icon: '🎡', blurb: 'One free spin a day for coins, items or a life.' },
  { kind: 'fetch', name: 'Fetch!', icon: '🎾', blurb: 'Tap when the ball is in the zone. Streaks pay more.' },
  { kind: 'memory', name: 'Paw-print Memory', icon: '🐾', blurb: 'Match the pairs before you run out of turns.' },
  { kind: 'dig', name: 'Dig for Treasure', icon: '🦴', blurb: 'Pick spots to dig. Find a bone and the dog stops to chew.' },
];

export const gameInfo = (kind: MinigameKind): GameInfo => GAMES.find((g) => g.kind === kind)!;

/** Rotation used for bonus rounds between levels. */
export const BONUS_ROTATION: MinigameKind[] = ['fetch', 'memory', 'dig'];

const empty = (): Reward => ({ coins: 0, items: {}, lives: 0 });

function shuffled<T>(items: T[]): T[] {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export class Minigames {
  private deps: FunDeps;
  private overlay: HTMLElement;
  private card: HTMLElement;
  private raf = 0;
  private timers: number[] = [];

  constructor(deps: FunDeps) {
    this.deps = deps;
    this.overlay = document.createElement('div');
    this.overlay.className = 'overlay fun-overlay';
    this.card = document.createElement('div');
    this.card.className = 'modal fun-card';
    this.overlay.appendChild(this.card);
    document.body.appendChild(this.overlay);
  }

  /** Coins scale with progress so a bonus round stays worth playing. */
  private get scale(): number {
    const unlocked = this.deps.profile().unlocked;
    return 1 + Math.floor((Math.max(1, unlocked) - 1) / 100) * 0.25;
  }

  private coins(n: number): number {
    return Math.max(5, Math.round((n * this.scale) / 5) * 5);
  }

  private fun(): FunState {
    const p = this.deps.profile();
    p.fun = p.fun ?? { played: {}, pending: [] };
    p.fun.played = p.fun.played ?? {};
    p.fun.pending = p.fun.pending ?? [];
    return p.fun;
  }

  /* ---------------------------------------------------------------- *
   * Availability
   * ---------------------------------------------------------------- */

  freePlayReady(kind: MinigameKind): boolean {
    return this.fun().played![kind] !== today();
  }

  pending(): MinigameKind[] {
    return this.fun().pending!.slice();
  }

  /** Queues a bonus round earned between levels. At most three wait. */
  earnBonus(kind: MinigameKind): void {
    const fun = this.fun();
    if (fun.pending!.length >= 3) return;
    fun.pending!.push(kind);
    this.deps.save();
  }

  /* ---------------------------------------------------------------- *
   * The Fun screen
   * ---------------------------------------------------------------- */

  renderHub(host: HTMLElement): void {
    const pending = this.pending();
    const bonusCards = pending
      .map((kind, i) => {
        const g = gameInfo(kind);
        return `<div class="card fun-row fun-bonus">
          <div class="card-icon">🎁</div>
          <div class="card-body">
            <div class="card-title">Bonus round: ${g.name}</div>
            <div class="card-sub">Earned between levels. Play it any time.</div>
          </div>
          <button class="buy-btn" data-bonus="${i}">Play</button>
        </div>`;
      })
      .join('');

    const games = GAMES.map((g) => {
      const ready = this.freePlayReady(g.kind);
      return `<div class="card fun-row">
        <div class="card-icon">${g.icon}</div>
        <div class="card-body">
          <div class="card-title">${g.name}</div>
          <div class="card-sub">${g.blurb}</div>
        </div>
        <button class="buy-btn" data-play="${g.kind}" ${ready ? '' : 'disabled'}>${
          ready ? (g.kind === 'wheel' ? 'Spin' : 'Play') : 'Tomorrow'
        }</button>
      </div>`;
    }).join('');

    host.innerHTML = `
      ${pending.length ? `<div class="section-title">Waiting for you</div>${bonusCards}` : ''}
      <div class="section-title">Daily games</div>
      <p class="panel-blurb">Each game has one free play a day. Every fourth new level you clear also earns a bonus round.</p>
      ${games}
    `;

    host.querySelectorAll<HTMLElement>('[data-play]').forEach((el) =>
      el.addEventListener('click', () => {
        const kind = el.dataset.play as MinigameKind;
        if (!this.freePlayReady(kind)) return;
        this.fun().played![kind] = today();
        this.deps.save();
        this.open(kind, () => this.renderHub(host));
      }),
    );
    host.querySelectorAll<HTMLElement>('[data-bonus]').forEach((el) =>
      el.addEventListener('click', () => {
        const fun = this.fun();
        const index = Number(el.dataset.bonus);
        const kind = fun.pending![index];
        if (!kind) return;
        fun.pending!.splice(index, 1);
        this.deps.save();
        this.open(kind, () => this.renderHub(host), true);
      }),
    );
  }

  /** Plays the first waiting bonus round, then calls `then`. */
  playBonus(then: () => void): boolean {
    const fun = this.fun();
    const kind = fun.pending!.shift();
    if (!kind) return false;
    this.deps.save();
    this.open(kind, then, true);
    return true;
  }

  /* ---------------------------------------------------------------- *
   * Running a game
   * ---------------------------------------------------------------- */

  open(kind: MinigameKind, onClose?: () => void, bonus = false): void {
    this.stop();
    this.overlay.dataset.open = 'true';
    this.card.dataset.kind = kind;
    const finish = (reward: Reward, title: string) => this.showReward(kind, reward, title, onClose);
    const tag = `<div class="modal-tag">${bonus ? '🎁 Bonus round' : 'Minigame'}</div>`;
    switch (kind) {
      case 'fetch':
        this.playFetch(tag, finish);
        break;
      case 'wheel':
        this.playWheel(tag, finish);
        break;
      case 'memory':
        this.playMemory(tag, finish);
        break;
      case 'dig':
        this.playDig(tag, finish);
        break;
    }
  }

  private stop(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  private later(ms: number, fn: () => void): void {
    this.timers.push(window.setTimeout(fn, ms));
  }

  private close(onClose?: () => void): void {
    this.stop();
    this.overlay.dataset.open = 'false';
    onClose?.();
  }

  private showReward(kind: MinigameKind, reward: Reward, title: string, onClose?: () => void): void {
    this.stop();
    // Never walk away empty-pawed.
    if (!reward.coins && !reward.lives && !Object.keys(reward.items).length) reward.coins = this.coins(10);
    const rows: string[] = [];
    if (reward.coins) rows.push(`<div class="reward"><span class="coin"></span><b>+${reward.coins}</b></div>`);
    if (reward.lives) rows.push(`<div class="reward"><span>❤️</span><b>+${reward.lives} life</b></div>`);
    for (const [id, n] of Object.entries(reward.items)) {
      const item = shopItemById(id as ItemId);
      rows.push(`<div class="reward"><span>${item.icon}</span><b>${item.name}${(n ?? 1) > 1 ? ` ×${n}` : ''}</b></div>`);
    }
    audio.sfx('win');
    this.card.innerHTML = `
      <div class="modal-tag">${gameInfo(kind).name}</div>
      <img class="fun-dog-big" src="${this.deps.dog(96)}" alt="" />
      <h2>${title}</h2>
      <div class="reward-row">${rows.join('')}</div>
      <div class="btn-row"><button class="btn btn-primary" id="fun-collect">Collect</button></div>
    `;
    this.card.querySelector('#fun-collect')!.addEventListener('click', () => {
      this.deps.grant(reward);
      audio.sfx('coin');
      this.close(onClose);
    });
  }

  /* ---------------------------------------------------------------- *
   * Fetch!
   * ---------------------------------------------------------------- */

  private playFetch(tag: string, finish: (r: Reward, title: string) => void): void {
    const THROWS = 5;
    let thrown = 0;
    let streak = 0;
    let catches = 0;
    const reward = empty();

    this.card.innerHTML = `
      ${tag}
      <h2>Fetch!</h2>
      <p class="lead">Tap when the ball is over the green zone.</p>
      <div class="fun-hud">
        <span id="f-round">Throw 1 / ${THROWS}</span>
        <span id="f-streak">Streak ×0</span>
        <span><span class="coin"></span> <b id="f-coins">0</b></span>
      </div>
      <div class="fetch-yard" id="f-yard">
        <div class="fetch-zone" id="f-zone"></div>
        <img class="fetch-ball" id="f-ball" src="${this.deps.piece(2, 64)}" alt="" />
        <img class="fetch-dog" id="f-dog" src="${this.deps.dog(84)}" alt="" />
        <div class="fetch-msg" id="f-msg"></div>
      </div>
      <div class="btn-row"><button class="btn btn-primary" id="f-tap">Catch!</button></div>
    `;
    const $ = (id: string) => this.card.querySelector<HTMLElement>(`#${id}`)!;
    const ball = $('f-ball');
    const zone = $('f-zone');
    const dog = $('f-dog');
    const msg = $('f-msg');

    let live = false;
    let phase = 0;
    let x = 50;
    let omega = 2;
    let zoneW = 26;
    let last = 0;

    const startThrow = () => {
      thrown++;
      $('f-round').textContent = `Throw ${thrown} / ${THROWS}`;
      omega = 2.1 + thrown * 0.45;
      zoneW = Math.max(12, 28 - thrown * 3);
      zone.style.width = `${zoneW}%`;
      zone.style.left = `${50 - zoneW / 2}%`;
      phase = Math.random() * Math.PI * 2;
      msg.textContent = '';
      ball.className = 'fetch-ball';
      dog.className = 'fetch-dog';
      live = true;
      last = performance.now();
      const step = (now: number) => {
        if (!live) return;
        phase += ((now - last) / 1000) * omega;
        last = now;
        x = 50 + 44 * Math.sin(phase);
        const hop = Math.abs(Math.cos(phase));
        ball.style.left = `${x}%`;
        ball.style.top = `${18 + hop * 26}%`;
        this.raf = requestAnimationFrame(step);
      };
      this.raf = requestAnimationFrame(step);
    };

    const tap = () => {
      if (!live) return;
      live = false;
      cancelAnimationFrame(this.raf);
      const hit = Math.abs(x - 50) <= zoneW / 2 + 2;
      if (hit) {
        catches++;
        streak++;
        const gain = this.coins(15 * streak);
        reward.coins += gain;
        msg.textContent = streak >= 3 ? `Amazing! +${gain}` : `Caught! +${gain}`;
        ball.classList.add('caught');
        dog.classList.add('jump');
        audio.sfx('match', streak);
      } else {
        streak = 0;
        msg.textContent = 'Whoops, missed!';
        ball.classList.add('missed');
        audio.sfx('invalid');
      }
      $('f-streak').textContent = `Streak ×${streak}`;
      $('f-coins').textContent = String(reward.coins);
      this.later(950, () => {
        if (thrown < THROWS) startThrow();
        else {
          if (catches === THROWS) reward.coins += this.coins(50);
          finish(reward, catches === THROWS ? 'Perfect fetch!' : catches >= 3 ? 'Good dog!' : 'Nice try!');
        }
      });
    };

    $('f-tap').addEventListener('click', tap);
    $('f-yard').addEventListener('pointerdown', tap);
    startThrow();
  }

  /* ---------------------------------------------------------------- *
   * Treat Wheel
   * ---------------------------------------------------------------- */

  private playWheel(tag: string, finish: (r: Reward, title: string) => void): void {
    const segments: { label: string; weight: number; reward: () => Reward }[] = [
      { label: String(this.coins(50)), weight: 22, reward: () => ({ ...empty(), coins: this.coins(50) }) },
      { label: '🔨', weight: 12, reward: () => ({ ...empty(), items: { hammer: 1 } }) },
      { label: String(this.coins(100)), weight: 20, reward: () => ({ ...empty(), coins: this.coins(100) }) },
      { label: '❤️', weight: 10, reward: () => ({ ...empty(), lives: 1 }) },
      { label: String(this.coins(200)), weight: 12, reward: () => ({ ...empty(), coins: this.coins(200) }) },
      { label: '➕', weight: 10, reward: () => ({ ...empty(), items: { extraMoves: 1 } }) },
      { label: String(this.coins(500)), weight: 8, reward: () => ({ ...empty(), coins: this.coins(500) }) },
      { label: '🌈', weight: 6, reward: () => ({ ...empty(), items: { rainbowStart: 1 } }) },
    ];
    const colors = ['#ffd15c', '#74c8ff', '#5fdbab', '#ff9aae', '#b18cff', '#ffb36b', '#6fe0e8', '#ffe48a'];
    const seg = 360 / segments.length;
    const gradient = segments
      .map((_, i) => `${colors[i % colors.length]} ${i * seg}deg ${(i + 1) * seg}deg`)
      .join(', ');
    const labels = segments
      .map(
        (s, i) =>
          `<span class="wheel-label" style="transform: rotate(${i * seg + seg / 2}deg)"><b>${s.label}</b></span>`,
      )
      .join('');

    this.card.innerHTML = `
      ${tag}
      <h2>Treat Wheel</h2>
      <p class="lead">Spin for a treat!</p>
      <div class="wheel-wrap">
        <div class="wheel-pointer"></div>
        <div class="wheel" id="w-wheel" style="background: conic-gradient(${gradient})">${labels}</div>
        <img class="wheel-hub" src="${this.deps.dog(64)}" alt="" />
      </div>
      <div class="btn-row"><button class="btn btn-primary" id="w-spin">Spin!</button></div>
    `;
    const wheel = this.card.querySelector<HTMLElement>('#w-wheel')!;
    const button = this.card.querySelector<HTMLButtonElement>('#w-spin')!;
    button.addEventListener('click', () => {
      button.disabled = true;
      const total = segments.reduce((sum, s) => sum + s.weight, 0);
      let roll = Math.random() * total;
      let index = 0;
      while (roll > segments[index].weight) {
        roll -= segments[index].weight;
        index++;
      }
      const jitter = (Math.random() - 0.5) * seg * 0.6;
      const target = 360 * 6 - (index * seg + seg / 2) + jitter;
      audio.sfx('scoot');
      wheel.style.transform = `rotate(${target}deg)`;
      this.later(4300, () => {
        audio.sfx('special');
        finish(segments[index].reward(), 'A treat for you!');
      });
    });
  }

  /* ---------------------------------------------------------------- *
   * Paw-print Memory
   * ---------------------------------------------------------------- */

  private playMemory(tag: string, finish: (r: Reward, title: string) => void): void {
    const colors = shuffled([0, 1, 2, 3, 4, 5, 6]).slice(0, 6);
    const deck = shuffled([...colors, ...colors]);
    let turns = 10;
    let pairs = 0;
    let open: number[] = [];
    let locked = false;

    const cards = deck
      .map(
        (c, i) => `<button class="mem-card" data-i="${i}" type="button">
          <span class="mem-inner">
            <span class="mem-back">🐾</span>
            <span class="mem-front"><img src="${this.deps.piece(c, 72)}" alt="" /></span>
          </span>
        </button>`,
      )
      .join('');

    this.card.innerHTML = `
      ${tag}
      <h2>Paw-print Memory</h2>
      <div class="fun-hud">
        <span>Turns left <b id="m-turns">${turns}</b></span>
        <span>Pairs <b id="m-pairs">0</b> / 6</span>
      </div>
      <div class="mem-grid">${cards}</div>
    `;
    const turnsEl = this.card.querySelector<HTMLElement>('#m-turns')!;
    const pairsEl = this.card.querySelector<HTMLElement>('#m-pairs')!;
    const buttons = [...this.card.querySelectorAll<HTMLButtonElement>('.mem-card')];

    const end = () => {
      const reward = empty();
      reward.coins = this.coins(pairs * 25);
      if (pairs === 6) {
        reward.coins += this.coins(100);
        reward.items.shuffle = 1;
      }
      this.later(700, () => finish(reward, pairs === 6 ? 'Paw-fect memory!' : `${pairs} pairs found!`));
    };

    buttons.forEach((btn) =>
      btn.addEventListener('click', () => {
        const i = Number(btn.dataset.i);
        if (locked || btn.classList.contains('flipped')) return;
        btn.classList.add('flipped');
        audio.sfx('tap');
        open.push(i);
        if (open.length < 2) return;

        const [a, b] = open;
        open = [];
        turns--;
        turnsEl.textContent = String(turns);
        if (deck[a] === deck[b]) {
          pairs++;
          pairsEl.textContent = String(pairs);
          buttons[a].classList.add('matched');
          buttons[b].classList.add('matched');
          audio.sfx('match', pairs);
          if (pairs === 6 || turns === 0) end();
        } else {
          locked = true;
          this.later(750, () => {
            buttons[a].classList.remove('flipped');
            buttons[b].classList.remove('flipped');
            locked = false;
            if (turns === 0) {
              locked = true;
              end();
            }
          });
        }
      }),
    );
  }

  /* ---------------------------------------------------------------- *
   * Dig for Treasure
   * ---------------------------------------------------------------- */

  private playDig(tag: string, finish: (r: Reward, title: string) => void): void {
    type Spot = { kind: 'coins'; amount: number } | { kind: 'item'; id: ItemId } | { kind: 'bone' } | { kind: 'sand' };
    const items: ItemId[] = ['hammer', 'shuffle', 'extraMoves', 'freeswap'];
    const spots: Spot[] = [];
    for (let i = 0; i < 7; i++) spots.push({ kind: 'coins', amount: this.coins(10 + Math.floor(Math.random() * 7) * 5) });
    spots.push({ kind: 'item', id: items[Math.floor(Math.random() * items.length)] });
    spots.push({ kind: 'bone' }, { kind: 'bone' });
    while (spots.length < 25) spots.push({ kind: 'sand' });
    const field = shuffled(spots);
    let digs = 6;
    let over = false;
    const reward = empty();

    this.card.innerHTML = `
      ${tag}
      <h2>Dig for Treasure</h2>
      <p class="lead" id="d-msg">Pick a spot. Watch out for bones!</p>
      <div class="fun-hud">
        <span>Digs left <b id="d-digs">${digs}</b></span>
        <span><span class="coin"></span> <b id="d-coins">0</b></span>
      </div>
      <div class="dig-grid">${field.map((_, i) => `<button class="dig-tile" data-i="${i}" type="button"></button>`).join('')}</div>
    `;
    const msg = this.card.querySelector<HTMLElement>('#d-msg')!;
    const digsEl = this.card.querySelector<HTMLElement>('#d-digs')!;
    const coinsEl = this.card.querySelector<HTMLElement>('#d-coins')!;

    const end = (title: string) => {
      over = true;
      // Show what was left in the sand.
      this.card.querySelectorAll<HTMLElement>('.dig-tile:not(.dug)').forEach((t) => {
        const s = field[Number(t.dataset.i)];
        if (s.kind !== 'sand') t.classList.add('peek');
        t.innerHTML = s.kind === 'coins' ? '<span class="coin"></span>' : s.kind === 'item' ? shopItemById(s.id).icon : s.kind === 'bone' ? '🦴' : '';
      });
      this.later(1300, () => finish(reward, title));
    };

    this.card.querySelectorAll<HTMLButtonElement>('.dig-tile').forEach((tile) =>
      tile.addEventListener('click', () => {
        if (over || tile.classList.contains('dug')) return;
        const spot = field[Number(tile.dataset.i)];
        tile.classList.add('dug');
        digs--;
        digsEl.textContent = String(digs);
        if (spot.kind === 'coins') {
          reward.coins += spot.amount;
          tile.innerHTML = `<span class="coin"></span><small>+${spot.amount}</small>`;
          msg.textContent = 'Coins! Good nose!';
          audio.sfx('coin');
        } else if (spot.kind === 'item') {
          reward.items[spot.id] = (reward.items[spot.id] ?? 0) + 1;
          tile.innerHTML = shopItemById(spot.id).icon;
          msg.textContent = `A ${shopItemById(spot.id).name}!`;
          audio.sfx('special');
        } else if (spot.kind === 'bone') {
          tile.innerHTML = '🦴';
          msg.textContent = 'A bone! The dog stops to chew it…';
          audio.sfx('crate');
          coinsEl.textContent = String(reward.coins);
          end('Chomp chomp!');
          return;
        } else {
          tile.innerHTML = '';
          msg.textContent = 'Just sand.';
          audio.sfx('tap');
        }
        coinsEl.textContent = String(reward.coins);
        if (digs <= 0) end('Digging done!');
      }),
    );
  }
}
