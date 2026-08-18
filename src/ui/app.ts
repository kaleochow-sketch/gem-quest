import { GameRenderer, GEM_COLORS } from '../render/renderer.js';
import { Pos } from '../engine/types.js';
import {
  EPISODES,
  LEVELS_PER_EPISODE,
  LevelDef,
  Objective,
  TOTAL_LEVELS,
  allLevels,
  getLevel,
  isBossLevel,
} from '../game/levels.js';
import { LevelSession } from '../game/session.js';
import {
  BOOSTERS,
  BoosterId,
  POWERUPS,
  PowerupId,
  UPGRADES,
  boosterExtraMoves,
  boosterSpecials,
  coinReward,
  contextFor,
  extraMovesFrom,
  maxLives,
} from '../game/upgrades.js';
import {
  Profile,
  buyItem,
  buyUpgrade,
  consumeItem,
  countItem,
  loadProfile,
  msToNextLife,
  recordResult,
  refillLives,
  resetProfile,
  saveProfile,
  spendLife,
  starsFor,
  totalStars,
} from '../game/save.js';

type ScreenId = 'map' | 'shop' | 'game';
type ShopTab = 'shop' | 'upgrades';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

/** Distance in pixels before a pointer drag counts as a swipe. */
const DRAG_THRESHOLD = 12;
/** Idle time before the board suggests a move. */
const HINT_DELAY = 6;

export class App {
  private profile: Profile;
  private renderer: GameRenderer;
  private session: LevelSession | null = null;

  private screen: ScreenId = 'map';
  private shopTab: ShopTab = 'shop';
  private levelId = 1;
  private chosenBoosters: BoosterId[] = [];
  private armedPowerup: PowerupId | null = null;
  private freeSwapFirst: Pos | null = null;

  private lastFrame = 0;
  private idleTime = 0;
  private resultShown = false;
  private resultRecorded = false;
  private rafHandle = 0;

  private canvas: HTMLCanvasElement;

  /** Current session, exposed for debugging and automated play-throughs. */
  get activeSession(): LevelSession | null {
    return this.session;
  }

  constructor() {
    this.profile = loadProfile();
    this.canvas = $<HTMLCanvasElement>('board');
    this.renderer = new GameRenderer(this.canvas);
    this.levelId = Math.min(this.profile.unlocked, TOTAL_LEVELS);

    this.bindChrome();
    this.bindBoardInput();
    this.renderMap();
    this.refreshWallet();

    window.addEventListener('resize', () => {
      if (this.screen === 'game' && this.session) this.renderer.layout();
    });
    setInterval(() => {
      refillLives(this.profile);
      this.refreshWallet();
    }, 1000);
  }

  /* ---------------------------------------------------------------- *
   * Chrome
   * ---------------------------------------------------------------- */

  private bindChrome(): void {
    document.querySelectorAll<HTMLElement>('[data-goto]').forEach((el) => {
      el.addEventListener('click', () => {
        const target = el.dataset.goto!;
        if (target === 'map') this.show('map');
        else {
          this.shopTab = target as ShopTab;
          this.renderShop();
          this.show('shop');
        }
      });
    });

    $('btn-continue').addEventListener('click', () => {
      this.openPreLevel(Math.min(this.profile.unlocked, TOTAL_LEVELS));
    });
    $('btn-quit').addEventListener('click', () => this.confirmQuit());
    $('chip-coins').addEventListener('click', () => {
      this.shopTab = 'shop';
      this.renderShop();
      this.show('shop');
    });
    $('chip-lives').addEventListener('click', () => this.showLivesInfo());
  }

  private show(screen: ScreenId): void {
    this.screen = screen;
    for (const id of ['map', 'shop', 'game'] as ScreenId[]) {
      $(`screen-${id}`).dataset.active = String(id === screen);
    }
    if (screen === 'game') this.startLoop();
    else this.stopLoop();
    if (screen === 'map') this.renderMap();
    this.refreshWallet();
  }

  private refreshWallet(): void {
    refillLives(this.profile);
    $('coins-count').textContent = this.profile.coins.toLocaleString();
    $('stars-count').textContent = String(totalStars(this.profile));
    $('lives-count').textContent = String(this.profile.lives);
    $('shop-coins').textContent = this.profile.coins.toLocaleString();

    const timer = $('lives-timer');
    const ms = msToNextLife(this.profile);
    if (ms > 0) {
      const total = Math.ceil(ms / 1000);
      timer.textContent = `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
    } else {
      timer.textContent = '';
    }
  }

  private toast(message: string): void {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = message;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2300);
  }

  /* ---------------------------------------------------------------- *
   * Level map
   * ---------------------------------------------------------------- */

  private renderMap(): void {
    const host = $('map-scroll');
    host.innerHTML = '';
    const levels = allLevels();
    // A gentle zig-zag so the list reads as a path rather than a table.
    const offsets = [0, 26, 44, 26, 0, -26, -44, -26];

    for (let e = 0; e < EPISODES.length; e++) {
      const head = document.createElement('div');
      head.className = 'episode-head';
      head.innerHTML = `<span>${e + 1}. ${EPISODES[e].name}</span>`;
      host.appendChild(head);

      for (let i = 0; i < LEVELS_PER_EPISODE; i++) {
        const def = levels[e * LEVELS_PER_EPISODE + i];
        host.appendChild(this.makeNode(def, offsets[(def.id - 1) % offsets.length]));
      }
    }

    requestAnimationFrame(() => {
      const current = host.querySelector<HTMLElement>('[data-state="current"]');
      current?.scrollIntoView({ block: 'center' });
    });
  }

  private makeNode(def: LevelDef, offset: number): HTMLElement {
    const row = document.createElement('div');
    row.className = 'node-row';

    const stars = starsFor(this.profile, def.id);
    const unlocked = def.id <= this.profile.unlocked;
    const done = !!this.profile.levels[def.id];

    const node = document.createElement('button');
    node.className = 'node';
    node.type = 'button';
    node.style.transform = `translateX(${offset}px)`;
    node.dataset.state = !unlocked ? 'locked' : done ? 'done' : 'current';
    node.dataset.boss = String(isBossLevel(def.id));

    const pips = [0, 1, 2, 3, 4]
      .map((i) => `<i data-on="${def.difficulty * 5 > i ? 'true' : 'false'}"></i>`)
      .join('');

    node.innerHTML = `
      ${isBossLevel(def.id) ? '<div class="node-boss-tag">BOSS</div>' : ''}
      <div class="node-num">${def.id}</div>
      <div class="node-stars">${'★'.repeat(stars)}${'☆'.repeat(3 - stars)}</div>
      <div class="node-pips">${pips}</div>
    `;
    node.addEventListener('click', () => {
      if (!unlocked) {
        this.toast(`Clear level ${this.profile.unlocked} to unlock this`);
        return;
      }
      this.openPreLevel(def.id);
    });

    row.appendChild(node);
    return row;
  }

  /* ---------------------------------------------------------------- *
   * Shop and upgrades
   * ---------------------------------------------------------------- */

  private renderShop(): void {
    $('shop-title').textContent = this.shopTab === 'shop' ? 'Shop' : 'Upgrades';
    const body = $('shop-body');
    body.innerHTML = '';

    if (this.shopTab === 'upgrades') {
      body.appendChild(this.sectionTitle('Permanent upgrades'));
      for (const upgrade of UPGRADES) {
        const rank = this.profile.upgrades[upgrade.id];
        const maxed = rank >= upgrade.maxRank;
        const cost = upgrade.cost(rank);
        const card = document.createElement('div');
        card.className = 'card';
        card.innerHTML = `
          <div class="card-icon">${upgrade.icon}</div>
          <div class="card-body">
            <div class="card-title">${upgrade.name} <span class="owned">${rank}/${upgrade.maxRank}</span></div>
            <div class="card-sub">${upgrade.describe(Math.max(1, rank + (maxed ? 0 : 1)))}</div>
            <div class="rank-track">${Array.from({ length: upgrade.maxRank }, (_, i) => `<i data-on="${i < rank}"></i>`).join('')}</div>
          </div>
        `;
        const btn = document.createElement('button');
        btn.className = 'buy-btn';
        btn.type = 'button';
        btn.innerHTML = maxed ? 'MAX' : `<span class="coin"></span> ${cost}`;
        btn.disabled = maxed || this.profile.coins < cost;
        btn.addEventListener('click', () => {
          if (buyUpgrade(this.profile, upgrade.id)) {
            saveProfile(this.profile);
            this.toast(`${upgrade.name} upgraded!`);
            this.renderShop();
            this.refreshWallet();
          }
        });
        card.appendChild(btn);
        body.appendChild(card);
      }

      const reset = document.createElement('button');
      reset.className = 'btn';
      reset.type = 'button';
      reset.style.marginTop = '18px';
      reset.textContent = 'Reset all progress';
      reset.addEventListener('click', () => this.confirmReset());
      body.appendChild(reset);
      return;
    }

    body.appendChild(this.sectionTitle('Pre-level boosters'));
    for (const item of BOOSTERS) body.appendChild(this.shopCard(item.id, item.name, item.icon, item.blurb, item.cost));
    body.appendChild(this.sectionTitle('In-level power-ups'));
    for (const item of POWERUPS) body.appendChild(this.shopCard(item.id, item.name, item.icon, item.blurb, item.cost));
  }

  private sectionTitle(text: string): HTMLElement {
    const el = document.createElement('div');
    el.className = 'section-title';
    el.textContent = text;
    return el;
  }

  private shopCard(
    id: BoosterId | PowerupId,
    name: string,
    icon: string,
    blurb: string,
    cost: number,
  ): HTMLElement {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <div class="card-icon">${icon}</div>
      <div class="card-body">
        <div class="card-title">${name} <span class="owned">owned ${countItem(this.profile, id)}</span></div>
        <div class="card-sub">${blurb}</div>
      </div>
    `;
    const btn = document.createElement('button');
    btn.className = 'buy-btn';
    btn.type = 'button';
    btn.innerHTML = `<span class="coin"></span> ${cost}`;
    btn.disabled = this.profile.coins < cost;
    btn.addEventListener('click', () => {
      if (buyItem(this.profile, id, cost)) {
        saveProfile(this.profile);
        this.toast(`${name} purchased`);
        this.renderShop();
        this.refreshWallet();
      }
    });
    card.appendChild(btn);
    return card;
  }

  /* ---------------------------------------------------------------- *
   * Modals
   * ---------------------------------------------------------------- */

  private openModal(html: string): HTMLElement {
    const modal = $('modal');
    modal.innerHTML = html;
    $('overlay').dataset.open = 'true';
    return modal;
  }

  private closeModal(): void {
    $('overlay').dataset.open = 'false';
  }

  private showLivesInfo(): void {
    const cap = maxLives(this.profile.upgrades);
    const ms = msToNextLife(this.profile);
    const mins = Math.ceil(ms / 60000);
    this.openModal(`
      <h2>Lives</h2>
      <p class="lead">${this.profile.lives} of ${cap} lives.${
        ms > 0 ? ` Next life in about ${mins} minute${mins === 1 ? '' : 's'}.` : ' Fully charged.'
      }</p>
      <div class="btn-row"><button class="btn btn-primary" data-close>Got it</button></div>
    `);
    this.wireClose();
  }

  private wireClose(): void {
    $('modal')
      .querySelectorAll<HTMLElement>('[data-close]')
      .forEach((el) => el.addEventListener('click', () => this.closeModal()));
  }

  private confirmReset(): void {
    this.openModal(`
      <h2>Reset progress?</h2>
      <p class="lead">This clears every star, coin and upgrade. It cannot be undone.</p>
      <div class="btn-row">
        <button class="btn" data-close>Cancel</button>
        <button class="btn btn-primary" id="do-reset">Reset</button>
      </div>
    `);
    this.wireClose();
    $('do-reset').addEventListener('click', () => {
      this.profile = resetProfile();
      this.closeModal();
      this.renderShop();
      this.show('map');
      this.toast('Progress reset');
    });
  }

  private confirmQuit(): void {
    this.openModal(`
      <h2>Leave level?</h2>
      <p class="lead">Your progress on this level will be lost, but the life you spent is not refunded.</p>
      <div class="btn-row">
        <button class="btn" data-close>Keep playing</button>
        <button class="btn btn-primary" id="do-quit">Quit</button>
      </div>
    `);
    this.wireClose();
    $('do-quit').addEventListener('click', () => {
      this.closeModal();
      this.session = null;
      this.show('map');
    });
  }

  /* ---------------------------------------------------------------- *
   * Pre-level
   * ---------------------------------------------------------------- */

  private openPreLevel(levelId: number): void {
    this.levelId = levelId;
    this.chosenBoosters = [];
    const def = getLevel(levelId);
    const stars = starsFor(this.profile, levelId);

    const boosters = BOOSTERS.map((b) => {
      const owned = countItem(this.profile, b.id);
      return `<button class="booster" type="button" data-booster="${b.id}" data-on="false" ${
        owned ? '' : 'disabled'
      }>
        ${owned ? `<b>${owned}</b>` : ''}
        <span>${b.icon}</span>${b.name}
        <small>${owned ? 'tap to use' : 'none owned'}</small>
      </button>`;
    }).join('');

    this.openModal(`
      <h2>Level ${def.id}</h2>
      <p class="lead">${def.episodeName}${isBossLevel(def.id) ? ' · Boss' : ''} · ${def.moves} moves</p>
      <div class="star-row">${[0, 1, 2].map((i) => `<i data-on="${i < stars}">★</i>`).join('')}</div>
      <div class="goal-list">${def.objectives.map((o) => this.goalCard(o, def)).join('')}</div>
      <div class="section-title" style="margin:6px 0 4px">Boosters</div>
      <div class="booster-grid">${boosters}</div>
      <div class="btn-row">
        <button class="btn" data-close>Back</button>
        <button class="btn btn-primary" id="do-play">Play</button>
      </div>
    `);
    this.wireClose();

    $('modal')
      .querySelectorAll<HTMLElement>('[data-booster]')
      .forEach((el) =>
        el.addEventListener('click', () => {
          const id = el.dataset.booster as BoosterId;
          const on = el.dataset.on === 'true';
          if (on) {
            this.chosenBoosters = this.chosenBoosters.filter((b) => b !== id);
            el.dataset.on = 'false';
          } else {
            this.chosenBoosters.push(id);
            el.dataset.on = 'true';
          }
        }),
      );

    $('do-play').addEventListener('click', () => this.startLevel());
  }

  private goalCard(objective: Objective, def: LevelDef): string {
    const { icon, label } = this.goalMeta(objective, def);
    return `<div class="card"><div class="card-icon">${icon}</div>
      <div class="card-body"><div class="card-title">${label}</div>
      <div class="card-sub">${this.goalBlurb(objective)}</div></div></div>`;
  }

  private goalMeta(objective: Objective, def: LevelDef): { icon: string; label: string } {
    switch (objective.type) {
      case 'score':
        return { icon: '🏆', label: `Score ${objective.target.toLocaleString()}` };
      case 'collect':
        return {
          icon: `<span class="goal-swatch" style="background:${GEM_COLORS[(objective.color ?? 0) % GEM_COLORS.length]}"></span>`,
          label: `Collect ${objective.target}`,
        };
      case 'jelly':
        return { icon: '🟦', label: `Clear ${objective.target} jelly` };
      case 'blockers':
        return { icon: '📦', label: `Break ${objective.target} blockers` };
      case 'ingredients':
        return { icon: '🌟', label: `Drop ${objective.target} star fruit` };
      default:
        void def;
        return { icon: '❓', label: 'Objective' };
    }
  }

  private goalBlurb(objective: Objective): string {
    switch (objective.type) {
      case 'score':
        return 'Reach the target score before the moves run out.';
      case 'collect':
        return 'Match gems of this colour to collect them.';
      case 'jelly':
        return 'Clear a gem on a jelly tile to peel a layer away.';
      case 'blockers':
        return 'Match beside crates to smash them; stones need a blast.';
      case 'ingredients':
        return 'Clear beneath the star fruit to walk it off the bottom.';
      default:
        return '';
    }
  }

  /* ---------------------------------------------------------------- *
   * Gameplay
   * ---------------------------------------------------------------- */

  private startLevel(): void {
    if (!spendLife(this.profile)) {
      this.toast('Out of lives — they refill over time');
      return;
    }
    for (const id of this.chosenBoosters) consumeItem(this.profile, id);
    saveProfile(this.profile);

    const def = getLevel(this.levelId);
    this.session = new LevelSession(def, {
      extraMoves: extraMovesFrom(this.profile.upgrades) + boosterExtraMoves(this.chosenBoosters),
      startingSpecials: boosterSpecials(this.chosenBoosters),
      context: contextFor(this.profile.upgrades),
      seedOffset: Math.floor(Math.random() * 100000),
    });

    this.armedPowerup = null;
    this.freeSwapFirst = null;
    this.resultShown = false;
    this.resultRecorded = false;
    this.idleTime = 0;

    this.closeModal();
    this.show('game');
    // Fill the HUD first so the board measures against its final box.
    this.renderHud();
    this.renderPowerbar();
    this.renderer.setBoard(this.session.board);
    this.renderer.layout();
  }

  private renderHud(): void {
    const session = this.session;
    if (!session) return;
    $('game-level').textContent = String(session.def.id);
    $('game-moves').textContent = String(Math.max(0, session.movesLeft));
    $('game-score').textContent = session.score.toLocaleString();
    $('game-moves').parentElement!.classList.toggle('low', session.movesLeft <= 5);

    $('game-goals').innerHTML = session.objectives
      .map((o) => {
        const { icon } = this.goalMeta(o, session.def);
        const shown = o.type === 'score' ? o.current.toLocaleString() : o.current;
        const target = o.type === 'score' ? o.target.toLocaleString() : o.target;
        return `<div class="goal" data-done="${o.done}">${icon}
          <span class="goal-count">${o.done ? '✓' : `${shown}/${target}`}</span></div>`;
      })
      .join('');
  }

  private renderPowerbar(): void {
    const bar = $('powerbar');
    bar.innerHTML = '';
    for (const item of POWERUPS) {
      const owned = countItem(this.profile, item.id);
      const btn = document.createElement('button');
      btn.className = 'power';
      btn.type = 'button';
      btn.disabled = owned <= 0;
      btn.dataset.armed = String(this.armedPowerup === item.id);
      btn.innerHTML = `${owned ? `<b>${owned}</b>` : ''}<span>${item.icon}</span>${item.name}`;
      btn.addEventListener('click', () => this.armPowerup(item.id as PowerupId));
      bar.appendChild(btn);
    }
  }

  private armPowerup(id: PowerupId): void {
    if (!this.session || this.renderer.busy) return;
    if (countItem(this.profile, id) <= 0) return;

    if (id === 'shuffle') {
      consumeItem(this.profile, id);
      saveProfile(this.profile);
      this.renderer.enqueue(this.session.usePowerup('shuffle'));
      this.armedPowerup = null;
      this.renderPowerbar();
      return;
    }

    this.armedPowerup = this.armedPowerup === id ? null : id;
    this.freeSwapFirst = null;
    this.renderer.selection = null;
    this.renderer.targeting = this.armedPowerup === 'hammer';
    this.renderPowerbar();
    if (this.armedPowerup) {
      this.toast(id === 'hammer' ? 'Tap a gem to smash it' : 'Tap two neighbouring gems');
    }
  }

  private bindBoardInput(): void {
    let startPos: Pos | null = null;
    let startX = 0;
    let startY = 0;
    let dragged = false;

    const down = (x: number, y: number) => {
      if (!this.session || this.renderer.busy || this.session.state !== 'playing') return;
      this.idleTime = 0;
      this.renderer.hint = null;
      startPos = this.renderer.cellAt(x, y);
      startX = x;
      startY = y;
      dragged = false;
    };

    const move = (x: number, y: number) => {
      if (!startPos || dragged || this.armedPowerup) return;
      const dx = x - startX;
      const dy = y - startY;
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      dragged = true;
      const target: Pos =
        Math.abs(dx) > Math.abs(dy)
          ? { r: startPos.r, c: startPos.c + (dx > 0 ? 1 : -1) }
          : { r: startPos.r + (dy > 0 ? 1 : -1), c: startPos.c };
      this.renderer.selection = null;
      this.attemptSwap(startPos, target);
      startPos = null;
    };

    const up = (x: number, y: number) => {
      if (dragged) {
        startPos = null;
        return;
      }
      const cell = this.renderer.cellAt(x, y);
      startPos = null;
      if (!cell || !this.session) return;

      if (this.armedPowerup === 'hammer') {
        this.fireHammer(cell);
        return;
      }
      if (this.armedPowerup === 'freeswap') {
        this.pickFreeSwap(cell);
        return;
      }

      // Tap-to-select, then tap a neighbour to swap. Selection is only ever
      // changed on release, so a single tap cannot select and deselect itself.
      const selected = this.renderer.selection;
      if (selected) {
        const sameCell = selected.r === cell.r && selected.c === cell.c;
        if (sameCell) {
          this.renderer.selection = null;
          return;
        }
        if (Math.abs(selected.r - cell.r) + Math.abs(selected.c - cell.c) === 1) {
          this.attemptSwap(selected, cell);
          this.renderer.selection = null;
          return;
        }
      }
      this.renderer.selection = cell;
    };

    this.canvas.addEventListener('pointerdown', (e) => {
      this.canvas.setPointerCapture(e.pointerId);
      down(e.clientX, e.clientY);
    });
    this.canvas.addEventListener('pointermove', (e) => move(e.clientX, e.clientY));
    this.canvas.addEventListener('pointerup', (e) => up(e.clientX, e.clientY));
    this.canvas.addEventListener('pointercancel', () => {
      startPos = null;
      this.renderer.selection = null;
    });
  }

  private attemptSwap(a: Pos, b: Pos): void {
    if (!this.session || this.renderer.busy) return;
    const result = this.session.swap(a, b);
    if (result.steps.length) this.renderer.enqueue(result.steps);
    if (!result.valid && !result.steps.length) return;
    this.renderHud();
  }

  private fireHammer(pos: Pos): void {
    if (!this.session || !consumeItem(this.profile, 'hammer')) return;
    saveProfile(this.profile);
    this.renderer.enqueue(this.session.usePowerup('hammer', pos));
    this.armedPowerup = null;
    this.renderer.targeting = false;
    this.renderPowerbar();
    this.renderHud();
  }

  private pickFreeSwap(pos: Pos): void {
    if (!this.session) return;
    if (!this.freeSwapFirst) {
      this.freeSwapFirst = pos;
      this.renderer.selection = pos;
      return;
    }
    const first = this.freeSwapFirst;
    const adjacent = Math.abs(first.r - pos.r) + Math.abs(first.c - pos.c) === 1;
    if (!adjacent) {
      this.freeSwapFirst = pos;
      this.renderer.selection = pos;
      return;
    }
    if (!consumeItem(this.profile, 'freeswap')) return;
    saveProfile(this.profile);
    this.renderer.enqueue(this.session.usePowerup('freeswap', first, pos));
    this.freeSwapFirst = null;
    this.armedPowerup = null;
    this.renderer.selection = null;
    this.renderPowerbar();
    this.renderHud();
  }

  /* ---------------------------------------------------------------- *
   * Loop
   * ---------------------------------------------------------------- */

  private startLoop(): void {
    if (this.rafHandle) return;
    this.lastFrame = performance.now();
    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - this.lastFrame) / 1000);
      this.lastFrame = now;
      this.renderer.tick(dt);

      if (this.session) {
        this.renderHud();
        if (!this.renderer.busy && this.session.state === 'playing') {
          this.idleTime += dt;
          if (this.idleTime > HINT_DELAY && !this.renderer.hint) {
            this.renderer.hint = this.session.hint();
          }
        } else {
          this.idleTime = 0;
        }
        if (!this.renderer.busy && this.session.state !== 'playing' && !this.resultShown) {
          this.resultShown = true;
          this.finishLevel();
        }
      }
      this.rafHandle = requestAnimationFrame(frame);
    };
    this.rafHandle = requestAnimationFrame(frame);
  }

  private stopLoop(): void {
    if (this.rafHandle) cancelAnimationFrame(this.rafHandle);
    this.rafHandle = 0;
  }

  /* ---------------------------------------------------------------- *
   * Results
   * ---------------------------------------------------------------- */

  private finishLevel(): void {
    const session = this.session;
    if (!session) return;
    // Guard here too, so no caller can award the same clear twice.
    if (this.resultRecorded) return;
    this.resultRecorded = true;

    if (session.state === 'won') {
      const stars = session.stars();
      const { firstClear } = recordResult(this.profile, session.def.id, stars, session.score);
      const coins = coinReward(stars, session.leftoverMoves, firstClear, this.profile.upgrades);
      this.profile.coins += coins;
      saveProfile(this.profile);

      const nextId = Math.min(session.def.id + 1, TOTAL_LEVELS);
      this.openModal(`
        <h2>Level cleared!</h2>
        <p class="lead">${session.def.episodeName}</p>
        <div class="star-row">${[0, 1, 2].map((i) => `<i data-on="${i < stars}">★</i>`).join('')}</div>
        <p class="lead">Score <strong>${session.score.toLocaleString()}</strong><br />
          Earned <strong><span class="coin"></span> ${coins}</strong>${
            session.leftoverMoves ? ` · ${session.leftoverMoves} moves left over` : ''
          }</p>
        <div class="btn-row">
          <button class="btn" id="to-map">Map</button>
          <button class="btn btn-primary" id="to-next">${
            session.def.id >= TOTAL_LEVELS ? 'Finish' : `Level ${nextId}`
          }</button>
        </div>
      `);
      $('to-map').addEventListener('click', () => {
        this.closeModal();
        this.show('map');
      });
      $('to-next').addEventListener('click', () => {
        this.closeModal();
        if (session.def.id >= TOTAL_LEVELS) this.show('map');
        else this.openPreLevel(nextId);
      });
      return;
    }

    saveProfile(this.profile);
    const remaining = session
      .remaining()
      .map((o) => {
        const { icon, label } = this.goalMeta(o, session.def);
        return `<div class="card"><div class="card-icon">${icon}</div>
          <div class="card-body"><div class="card-title">${label}</div>
          <div class="card-sub">${o.current} of ${o.target} done</div></div></div>`;
      })
      .join('');

    this.openModal(`
      <h2>Out of moves</h2>
      <p class="lead">${Math.round(session.completion() * 100)}% of the way there.</p>
      <div class="goal-list">${remaining}</div>
      <div class="btn-row">
        <button class="btn" id="to-map">Map</button>
        <button class="btn btn-primary" id="to-retry">Retry</button>
      </div>
    `);
    $('to-map').addEventListener('click', () => {
      this.closeModal();
      this.show('map');
    });
    $('to-retry').addEventListener('click', () => {
      this.closeModal();
      this.openPreLevel(session.def.id);
    });
  }
}
