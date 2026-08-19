import { GameRenderer, GEM_COLORS, GEM_NAMES } from '../render/renderer.js';
import { qrSvg } from './qr.js';
import { Pos } from '../engine/types.js';
import {
  EPISODES,
  LEVELS_PER_EPISODE,
  LEVELS_PER_REGION,
  LevelDef,
  Objective,
  REGIONS,
  TOTAL_LEVELS,
  TOTAL_REGIONS,
  allLevels,
  getLevel,
  isBossLevel,
  isRegionFinale,
  regionOf,
} from '../game/levels.js';
import { LevelSession } from '../game/session.js';
import {
  BOOSTERS,
  BoosterId,
  POWERUPS,
  PowerupId,
  UPGRADES,
  UpgradeDef,
  boosterExtraMoves,
  boosterSpecials,
  coinReward,
  contextFor,
  extraMovesFrom,
  fuseBonus,
  lifeRefundChance,
  maxLives,
  powerupRefundChance,
  starlightSpecials,
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
  hasSeen,
  markSeen,
  resetProfile,
  saveProfile,
  spendLife,
  starsFor,
  totalStars,
} from '../game/save.js';

/**
 * Where the game actually lives, for sharing. The share link must work for
 * the person receiving it, so it cannot simply be the address this tab
 * happens to be open on: a LAN address or localhost is unreachable for
 * everyone else and fails with "Safari cannot open the page".
 */
const PUBLIC_URL = 'https://kaleochow-sketch.github.io/gem-quest/';

/** Loopback, private-range and .local hosts are not shareable. */
function isPrivateHost(host: string): boolean {
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host === '[::1]' ||
    host === '' ||
    host.endsWith('.local') ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  );
}

/**
 * The canonical link to hand out. A real public deployment shares itself, so
 * moving the game keeps sharing correct; anything local falls back to the
 * published copy.
 */
export function shareUrl(): string {
  if (location.protocol === 'file:' || isPrivateHost(location.hostname)) return PUBLIC_URL;
  const path = location.pathname.replace(/index\.html$/, '');
  return location.origin + (path.endsWith('/') ? path : path + '/');
}

type ScreenId = 'map' | 'shop' | 'game';
type ShopTab = 'boosters' | 'powerups' | 'upgrades' | 'dev';

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
  private shopTab: ShopTab = 'boosters';
  private levelId = 1;
  private mapRegion = 0;
  private chosenBoosters: BoosterId[] = [];
  private armedPowerup: PowerupId | null = null;
  private freeSwapFirst: Pos | null = null;

  /** Taps on the brand mark; seven in a row reveals the dev tools. */
  private devTaps = 0;
  private devTapAt = 0;

  private lastFrame = 0;
  private idleTime = 0;
  private resultShown = false;
  private resultRecorded = false;
  private rafHandle = 0;

  private canvas: HTMLCanvasElement;
  /** Stashed beforeinstallprompt event, where the browser fires one. */
  private installEvent: { prompt: () => void; userChoice: Promise<unknown> } | null = null;


  /** Current session, exposed for debugging and automated play-throughs. */
  get activeSession(): LevelSession | null {
    return this.session;
  }

  constructor() {
    this.profile = loadProfile();
    this.canvas = $<HTMLCanvasElement>('board');
    this.renderer = new GameRenderer(this.canvas);
    this.levelId = Math.min(this.profile.unlocked, TOTAL_LEVELS);
    this.mapRegion = regionOf(this.levelId);

    this.bindChrome();
    this.bindBoardInput();
    this.bindInstall();
    this.renderMap();
    this.refreshWallet();
    this.maybeShowIntro();

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
          this.shopTab = target === 'upgrades' ? 'upgrades' : 'boosters';
          this.renderShop();
          this.show('shop');
        }
      });
    });

    $('btn-continue').addEventListener('click', () => {
      this.openPreLevel(Math.min(this.profile.unlocked, TOTAL_LEVELS));
    });
    $('btn-quit').addEventListener('click', () => this.confirmQuit());
    // Dev-only, and sits in the level itself where a restart is actually wanted.
    $('btn-restart').addEventListener('click', () => this.dev.restart());
    $('chip-coins').addEventListener('click', () => {
      this.shopTab = 'boosters';
      this.renderShop();
      this.show('shop');
    });
    $('chip-lives').addEventListener('click', () => this.showLivesInfo());
    $('btn-share').addEventListener('click', () => this.showShare());
    $('btn-help').addEventListener('click', () => this.showTeach(['intro', 'specials'], null, true));

    // Seven quick taps on the ◆ reveals the dev tools. It has no other
    // action, so this cannot fire by accident during normal play.
    document.querySelector('.brand-mark')?.addEventListener('click', () => {
      const now = Date.now();
      this.devTaps = now - this.devTapAt < 900 ? this.devTaps + 1 : 1;
      this.devTapAt = now;
      if (this.devTaps < 7) return;
      this.devTaps = 0;
      this.profile.dev = !this.profile.dev;
      saveProfile(this.profile);
      this.toast(this.profile.dev ? '🛠 Dev tools unlocked' : 'Dev tools hidden');
      if (this.profile.dev) {
        this.shopTab = 'dev';
        this.renderShop();
        this.show('shop');
      }
    });
    $('chip-stars').addEventListener('click', () => {
      this.shopTab = 'upgrades';
      this.renderShop();
      this.show('shop');
    });
  }

  /** True when already running as an installed app. */
  private get isStandalone(): boolean {
    return (
      window.matchMedia?.('(display-mode: standalone)').matches ||
      (navigator as unknown as { standalone?: boolean }).standalone === true
    );
  }

  private get isIos(): boolean {
    return /iphone|ipad|ipod/i.test(navigator.userAgent);
  }

  /**
   * Android and desktop Chrome fire beforeinstallprompt, so the banner can
   * install directly. iOS has no such API, so it gets instructions instead.
   */
  private bindInstall(): void {
    const bar = $('install-bar');

    window.addEventListener('beforeinstallprompt', (event) => {
      event.preventDefault();
      this.installEvent = event as unknown as { prompt: () => void; userChoice: Promise<unknown> };
      this.showInstallBar();
    });

    window.addEventListener('appinstalled', () => {
      bar.dataset.open = 'false';
      this.toast('Installed — look for Gem Quest on your home screen');
    });

    $('install-close').addEventListener('click', () => {
      bar.dataset.open = 'false';
      this.profile.installDismissed = true;
      saveProfile(this.profile);
    });

    $('install-go').addEventListener('click', () => {
      if (this.installEvent) {
        this.installEvent.prompt();
        this.installEvent = null;
        bar.dataset.open = 'false';
        return;
      }
      this.showIosInstall();
    });

    // iOS never fires the event, so offer the banner there directly.
    if (this.isIos && !this.isStandalone && !this.profile.installDismissed) {
      $('install-hint').textContent = 'Add to your home screen';
      $('install-go').textContent = 'How';
      setTimeout(() => this.showInstallBar(), 1200);
    }
  }

  private showInstallBar(): void {
    if (this.isStandalone || this.profile.installDismissed) return;
    $('install-bar').dataset.open = 'true';
  }

  private showIosInstall(): void {
    this.openModal(`
      <h2>Add to Home Screen</h2>
      <p class="lead">Gem Quest runs as a full-screen app, and works with no connection.</p>
      <ol class="steps">
        <li>Tap the <strong>Share</strong> button in Safari&nbsp;<span class="ios-share">􀈂</span> (the square with an arrow).</li>
        <li>Scroll and choose <strong>Add to Home Screen</strong>.</li>
        <li>Tap <strong>Add</strong>. The dog appears on your home screen.</li>
      </ol>
      <div class="btn-row"><button class="btn btn-primary" data-close>Got it</button></div>
    `);
    this.wireClose();
  }

  /** The share sheet: a link, a QR code, and the native share sheet. */
  private showShare(): void {
    const url = shareUrl();
    this.openModal(`
      <h2>Share Gem Quest</h2>
      <p class="lead">Anyone can play straight from the link — no account, no install needed.</p>
      <button class="qr-frame" id="qr-tap" type="button" title="Copy link">${qrSvg(url, {
        light: '#ffffff',
        dark: '#141a33',
      })}</button>
      <div class="share-url" id="share-url">${url}</div>
      <div class="btn-row">
        <button class="btn" id="share-copy">Copy link</button>
        <button class="btn btn-primary" id="share-native">Share</button>
      </div>
      <div class="btn-row"><button class="btn" data-close>Close</button></div>
    `);
    this.wireClose();

    const copyLink = async () => {
      try {
        await navigator.clipboard.writeText(url);
        this.toast('Link copied');
      } catch {
        // Clipboard access can be refused; the link is on screen to read.
        this.toast('Copy blocked — the link is shown above');
      }
    };
    $('qr-tap').addEventListener('click', copyLink);

    $('share-copy').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(url);
        this.toast('Link copied');
      } catch {
        // Clipboard access can be refused; the link is on screen to read.
        this.toast('Copy blocked — the link is shown above');
      }
    });
    $('share-native').addEventListener('click', async () => {
      if (navigator.share) {
        try {
          await navigator.share({ title: 'Gem Quest', text: 'Play Gem Quest', url });
        } catch {
          /* the user dismissed the sheet */
        }
      } else {
        this.toast('Sharing is not supported here — copy the link instead');
      }
    });
  }

  private show(screen: ScreenId): void {
    this.screen = screen;
    // The prompt lives on the map only: the shop has no tab bar for it to sit
    // above so it covered the last card, and it has no business over a board.
    $('install-bar').dataset.hidden = String(screen !== 'map');
    ($('btn-restart') as HTMLButtonElement).hidden = !(screen === 'game' && this.profile.dev);
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
    const coinText = this.profile.infiniteCoins ? '∞' : this.profile.coins.toLocaleString();
    $('coins-count').textContent = coinText;
    $('stars-count').textContent = String(totalStars(this.profile));
    $('lives-count').textContent = this.profile.infiniteLives ? '∞' : String(this.profile.lives);
    $('shop-coins').textContent = coinText;

    const timer = $('lives-timer');
    const ms = this.profile.infiniteLives ? 0 : msToNextLife(this.profile);
    if (ms > 0) {
      const total = Math.ceil(ms / 1000);
      timer.textContent = `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
    } else {
      timer.textContent = '';
    }
  }

  /** Drives the ambient background colour. */
  private setHue(hue: number): void {
    document.documentElement.style.setProperty('--ep-hue', String(hue));
  }

  private toast(message: string): void {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = message;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2300);
  }

  /* ---------------------------------------------------------------- *
   * Level map — one region at a time, since there are a thousand levels
   * ---------------------------------------------------------------- */

  private renderMap(): void {
    this.mapRegion = Math.min(TOTAL_REGIONS - 1, Math.max(0, this.mapRegion));
    this.setHue(REGIONS[this.mapRegion].hue);
    this.renderRegionStrip();

    const host = $('map-scroll');
    host.innerHTML = '';
    const levels = allLevels();
    const firstId = this.mapRegion * LEVELS_PER_REGION + 1;
    const offsets = [0, 26, 44, 26, 0, -26, -44, -26];

    for (let e = 0; e < LEVELS_PER_REGION / LEVELS_PER_EPISODE; e++) {
      const episodeIndex = this.mapRegion * 10 + e;
      const info = EPISODES[episodeIndex];

      const head = document.createElement('div');
      head.className = 'episode-head';
      head.style.setProperty('--ep-hue', String(info.hue));
      head.innerHTML = `<span>${episodeIndex + 1}. ${info.name}</span>`;
      host.appendChild(head);

      const track = document.createElement('div');
      track.className = 'map-track';
      for (let i = 0; i < LEVELS_PER_EPISODE; i++) {
        const def = levels[firstId - 1 + e * LEVELS_PER_EPISODE + i];
        track.appendChild(this.makeNode(def, offsets[(def.id - 1) % offsets.length]));
      }
      host.appendChild(track);
    }

    requestAnimationFrame(() => {
      const current = host.querySelector<HTMLElement>('[data-state="current"]');
      current?.scrollIntoView({ block: 'center' });
    });
  }

  private renderRegionStrip(): void {
    const strip = $('region-strip');
    strip.innerHTML = '';
    const playerRegion = regionOf(Math.min(this.profile.unlocked, TOTAL_LEVELS));

    REGIONS.forEach((region, i) => {
      const firstId = i * LEVELS_PER_REGION + 1;
      const locked = firstId > this.profile.unlocked;
      const chip = document.createElement('button');
      chip.className = 'region-chip';
      chip.type = 'button';
      chip.dataset.on = String(i === this.mapRegion);
      chip.dataset.locked = String(locked);
      chip.style.setProperty('--ep-hue', String(region.hue));

      let stars = 0;
      for (let id = firstId; id < firstId + LEVELS_PER_REGION; id++) {
        stars += starsFor(this.profile, id);
      }
      chip.innerHTML = `<strong>${region.name}</strong><small>${
        locked ? 'locked' : `${stars}/${LEVELS_PER_REGION * 3} ★`
      }</small>`;
      chip.addEventListener('click', () => {
        if (locked) {
          this.toast(`Reach level ${firstId} to open ${region.name}`);
          return;
        }
        this.mapRegion = i;
        this.renderMap();
      });
      strip.appendChild(chip);
    });

    requestAnimationFrame(() => {
      strip.children[playerRegion]?.scrollIntoView({ inline: 'center', block: 'nearest' });
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
    node.dataset.finale = String(isRegionFinale(def.id));

    const pips = [0, 1, 2, 3, 4]
      .map((i) => `<i data-on="${def.difficulty * 5 > i ? 'true' : 'false'}"></i>`)
      .join('');

    node.innerHTML = `
      ${isRegionFinale(def.id) ? '<div class="node-tag node-tag-finale">FINALE</div>' : isBossLevel(def.id) ? '<div class="node-tag">BOSS</div>' : ''}
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
    $('shop-title').textContent = this.shopTab === 'upgrades' ? 'Upgrades' : 'Shop';

    const tabs = $('shop-tabs');
    tabs.innerHTML = '';
    const tabDefs: { id: ShopTab; label: string }[] = [
      { id: 'boosters', label: 'Boosters' },
      { id: 'powerups', label: 'Power-ups' },
      { id: 'upgrades', label: 'Upgrades' },
    ];
    if (this.profile.dev) tabDefs.push({ id: 'dev', label: '🛠 Dev' });
    for (const tab of tabDefs) {
      const btn = document.createElement('button');
      btn.className = 'shop-tab';
      btn.type = 'button';
      btn.dataset.on = String(this.shopTab === tab.id);
      btn.textContent = tab.label;
      btn.addEventListener('click', () => {
        this.shopTab = tab.id;
        this.renderShop();
      });
      tabs.appendChild(btn);
    }

    const body = $('shop-body');
    body.innerHTML = '';

    if (this.shopTab === 'dev') {
      this.renderDevPanel(body);
      return;
    }
    if (this.shopTab === 'upgrades') {
      this.renderUpgrades(body);
      return;
    }

    const items = this.shopTab === 'boosters' ? BOOSTERS : POWERUPS;
    body.appendChild(
      this.blurbLine(
        this.shopTab === 'boosters'
          ? 'Chosen before a level starts. One use each.'
          : 'Used during a level. None of them cost a move.',
      ),
    );
    for (const item of items) {
      body.appendChild(this.shopCard(item.id, item.name, item.icon, item.blurb, item.cost));
    }
  }

  private renderUpgrades(body: HTMLElement): void {
    const stars = totalStars(this.profile);
    body.appendChild(this.blurbLine(`Permanent, and applied to every level. You have ${stars} ★.`));

    const branches: { id: UpgradeDef['branch']; label: string }[] = [
      { id: 'power', label: 'Power' },
      { id: 'fortune', label: 'Fortune' },
      { id: 'endurance', label: 'Endurance' },
    ];

    for (const branch of branches) {
      body.appendChild(this.sectionTitle(branch.label));
      for (const upgrade of UPGRADES.filter((u) => u.branch === branch.id)) {
        body.appendChild(this.upgradeCard(upgrade, stars));
      }
    }

    const reset = document.createElement('button');
    reset.className = 'btn';
    reset.type = 'button';
    reset.style.marginTop = '18px';
    reset.textContent = 'Reset all progress';
    reset.addEventListener('click', () => this.confirmReset());
    body.appendChild(reset);
  }

  private upgradeCard(upgrade: UpgradeDef, stars: number): HTMLElement {
    const rank = this.profile.upgrades[upgrade.id] ?? 0;
    const maxed = rank >= upgrade.maxRank;
    const cost = upgrade.cost(rank);
    const gated = stars < upgrade.starsRequired;

    const card = document.createElement('div');
    card.className = 'card';
    card.dataset.locked = String(gated);
    card.innerHTML = `
      <div class="card-icon">${upgrade.icon}</div>
      <div class="card-body">
        <div class="card-title">${upgrade.name} <span class="owned">${rank}/${upgrade.maxRank}</span></div>
        <div class="card-sub">${
          gated
            ? `Needs ${upgrade.starsRequired} ★ to unlock`
            : upgrade.describe(maxed ? rank : rank + 1)
        }</div>
        <div class="rank-track">${Array.from(
          { length: upgrade.maxRank },
          (_, i) => `<i data-on="${i < rank}"></i>`,
        ).join('')}</div>
      </div>
    `;

    const btn = document.createElement('button');
    btn.className = 'buy-btn';
    btn.type = 'button';
    btn.innerHTML = maxed ? 'MAX' : gated ? `🔒 ${upgrade.starsRequired}★` : `<span class="coin"></span> ${cost}`;
    btn.disabled = maxed || gated || this.profile.coins < cost;
    btn.addEventListener('click', () => {
      if (buyUpgrade(this.profile, upgrade.id)) {
        saveProfile(this.profile);
        this.toast(`${upgrade.name} → rank ${this.profile.upgrades[upgrade.id]}`);
        this.renderShop();
        this.refreshWallet();
      }
    });
    card.appendChild(btn);
    return card;
  }

  /** Developer tools. Everything here is local to this browser profile. */
  private renderDevPanel(body: HTMLElement): void {
    body.appendChild(
      this.blurbLine(
        'Local to this browser only — nothing here is shared or synced. ' +
          'Tap the ◆ seven times again to hide these.',
      ),
    );

    const toggles: { label: string; sub: string; key: 'infiniteCoins' | 'infiniteLives' }[] = [
      {
        label: 'Infinite coins',
        sub: 'Purchases never deduct, and power-ups are never used up.',
        key: 'infiniteCoins',
      },
      { label: 'Infinite lives', sub: 'Levels never cost a life.', key: 'infiniteLives' },
    ];

    body.appendChild(this.sectionTitle('Toggles'));
    for (const t of toggles) {
      const card = document.createElement('div');
      card.className = 'card';
      card.innerHTML = `<div class="card-icon">${t.key === 'infiniteCoins' ? '💰' : '❤️'}</div>
        <div class="card-body"><div class="card-title">${t.label}</div>
        <div class="card-sub">${t.sub}</div></div>`;
      const btn = document.createElement('button');
      btn.className = 'buy-btn';
      btn.type = 'button';
      const on = !!this.profile[t.key];
      btn.textContent = on ? 'ON' : 'OFF';
      btn.style.opacity = on ? '1' : '0.6';
      btn.addEventListener('click', () => {
        this.profile[t.key] = !this.profile[t.key];
        saveProfile(this.profile);
        this.renderShop();
        this.refreshWallet();
      });
      card.appendChild(btn);
      body.appendChild(card);
    }

    body.appendChild(this.sectionTitle('Actions'));
    const actions: { label: string; sub: string; run: () => string }[] = [
      {
        label: 'Add 1,000,000 coins',
        sub: 'One-off top-up, without switching on infinite mode.',
        run: () => {
          this.dev.coins(1_000_000);
          return 'Coins added';
        },
      },
      {
        label: 'Stock every item',
        sub: 'Sets all boosters and power-ups to 99.',
        run: () => {
          this.dev.items(99);
          return 'Items stocked';
        },
      },
      {
        label: 'Unlock all 1000 levels',
        sub: 'Opens every region on the map. Does not award stars.',
        run: () => {
          this.dev.unlockAll();
          return 'All levels unlocked';
        },
      },
      {
        label: 'Max every upgrade',
        sub: 'Sets all twelve upgrades to their top rank, ignoring star gates.',
        run: () => {
          this.dev.maxUpgrades();
          return 'Upgrades maxed';
        },
      },
      {
        label: 'Refill lives',
        sub: 'Tops lives back up to your current cap.',
        run: () => {
          this.dev.lives();
          return 'Lives refilled';
        },
      },
      {
        label: 'Win current level',
        sub: 'Only works while a level is open.',
        run: () => (this.dev.win() ? 'Level completed' : 'No level in progress'),
      },
      {
        label: `Restart level ${this.levelId}`,
        sub: 'Replays it on a fresh board. Costs no life and no boosters.',
        run: () => {
          this.dev.restart();
          return `Restarted level ${this.levelId}`;
        },
      },
    ];

    for (const action of actions) {
      const card = document.createElement('div');
      card.className = 'card';
      card.innerHTML = `<div class="card-icon">🛠</div>
        <div class="card-body"><div class="card-title">${action.label}</div>
        <div class="card-sub">${action.sub}</div></div>`;
      const btn = document.createElement('button');
      btn.className = 'buy-btn';
      btn.type = 'button';
      btn.textContent = 'Run';
      btn.addEventListener('click', () => {
        const message = action.run();
        saveProfile(this.profile);
        this.renderShop();
        this.refreshWallet();
        this.toast(message);
      });
      card.appendChild(btn);
      body.appendChild(card);
    }

    // Destructive, so it is separated out and asks first.
    body.appendChild(this.sectionTitle('Danger zone'));
    const wipe = document.createElement('div');
    wipe.className = 'card';
    wipe.innerHTML = `<div class="card-icon">🧨</div>
      <div class="card-body"><div class="card-title">Reset everything</div>
      <div class="card-sub">Wipes stars, coins, upgrades, items and the dev toggles.
      Puts the profile back to a brand-new install.</div></div>`;
    const wipeBtn = document.createElement('button');
    wipeBtn.className = 'buy-btn buy-btn-danger';
    wipeBtn.type = 'button';
    wipeBtn.textContent = 'Reset';
    wipeBtn.addEventListener('click', () => this.confirmReset());
    wipe.appendChild(wipeBtn);
    body.appendChild(wipe);
  }

  /**
   * Console API, mirrored by the Dev tab. Everything is local to this
   * browser profile: `gemQuest.dev.help()` lists the commands.
   */
  get dev() {
    const self = this;
    return {
      help(): string[] {
        return [
          'gemQuest.dev.coins(n?)      add coins (default 1,000,000)',
          'gemQuest.dev.infinite(on?)  never spend coins, items or lives',
          'gemQuest.dev.items(n?)      stock every booster and power-up',
          'gemQuest.dev.lives(n?)      refill lives',
          'gemQuest.dev.unlockAll()    unlock all 1000 levels',
          'gemQuest.dev.maxUpgrades()  max every upgrade',
          'gemQuest.dev.goto(id)       open a level',
          'gemQuest.dev.win()          complete the level in progress',
          'gemQuest.dev.restart()      replay the current level, free',
          'gemQuest.dev.resetAll()     wipe the profile back to new',
          'gemQuest.dev.panel()        show the in-game Dev tab',
          'gemQuest.dev.reset()        wipe the profile',
        ];
      },
      coins(n = 1_000_000): number {
        self.profile.coins += n;
        self.commitDev();
        return self.profile.coins;
      },
      infinite(on = true): boolean {
        self.profile.infiniteCoins = on;
        self.profile.infiniteLives = on;
        self.commitDev();
        return on;
      },
      items(n = 99): void {
        for (const item of [...BOOSTERS, ...POWERUPS]) self.profile.inventory[item.id] = n;
        self.commitDev();
      },
      lives(n = maxLives(self.profile.upgrades)): number {
        self.profile.lives = n;
        self.commitDev();
        return n;
      },
      unlockAll(): void {
        self.profile.unlocked = TOTAL_LEVELS;
        self.commitDev();
      },
      maxUpgrades(): void {
        for (const upgrade of UPGRADES) self.profile.upgrades[upgrade.id] = upgrade.maxRank;
        self.commitDev();
      },
      goto(id: number): void {
        self.profile.unlocked = Math.max(self.profile.unlocked, id);
        self.commitDev();
        self.openPreLevel(Math.max(1, Math.min(TOTAL_LEVELS, id)));
      },
      /** Replays the current level on a fresh board, free of charge. */
      restart(): boolean {
        const id = self.session ? self.session.def.id : self.levelId;
        self.levelId = id;
        self.session = null;
        self.resultShown = true;
        self.closeModal();
        self.chosenBoosters = [];
        self.startLevel(true);
        return true;
      },
      win(): boolean {
        const session = self.session;
        if (!session || session.state !== 'playing') return false;
        for (const objective of session.objectives) {
          (objective as { current: number; done: boolean }).current = objective.target;
          (objective as { current: number; done: boolean }).done = true;
        }
        session.state = 'won';
        session.leftoverMoves = Math.max(0, session.movesLeft);
        self.resultShown = true;
        self.finishLevel();
        return true;
      },
      panel(): void {
        self.profile.dev = true;
        self.shopTab = 'dev';
        self.commitDev();
        self.renderShop();
        self.show('shop');
      },
      reset(): void {
        self.profile = resetProfile();
        self.mapRegion = 0;
        self.levelId = 1;
        self.session = null;
        self.show('map');
      },
      /** Same as reset(); named for symmetry with the panel button. */
      resetAll(): void {
        this.reset();
      },
    };
  }

  /** Saves and refreshes after a dev change. */
  private commitDev(): void {
    saveProfile(this.profile);
    this.refreshWallet();
    if (this.screen === 'map') this.renderMap();
    if (this.screen === 'shop') this.renderShop();
  }

  private blurbLine(text: string): HTMLElement {
    const el = document.createElement('p');
    el.className = 'panel-blurb';
    el.textContent = text;
    return el;
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

  private wireClose(): void {
    $('modal')
      .querySelectorAll<HTMLElement>('[data-close]')
      .forEach((el) => el.addEventListener('click', () => this.closeModal()));
  }

  private showLivesInfo(): void {
    const cap = maxLives(this.profile.upgrades);
    const ms = msToNextLife(this.profile);
    const mins = Math.ceil(ms / 60000);
    this.openModal(`
      <h2>Lives</h2>
      <p class="lead">${
        this.profile.infiniteLives ? 'Infinite lives are on (dev).' : `${this.profile.lives} of ${cap} lives.`
      }${
        ms > 0 ? ` Next life in about ${mins} minute${mins === 1 ? '' : 's'}.` : ' Fully charged.'
      }</p>
      <div class="btn-row"><button class="btn btn-primary" data-close>Got it</button></div>
    `);
    this.wireClose();
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
      // A reset from the dev panel keeps the panel open; you are plainly still
      // developing, and otherwise it takes seven taps to get back in.
      const wasDev = !!this.profile.dev;
      this.profile = resetProfile();
      if (wasDev) {
        this.profile.dev = true;
        saveProfile(this.profile);
      }
      this.mapRegion = 0;
      this.levelId = 1;
      this.session = null;
      this.closeModal();
      this.renderShop();
      this.show('map');
      this.toast('Progress reset');
    });
  }

  private confirmQuit(): void {
    this.openModal(`
      <h2>Leave level?</h2>
      <p class="lead">Your progress on this level will be lost, and the life you spent is not refunded.</p>
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
   * Teaching cards
   * ---------------------------------------------------------------- */

  /** One card per mechanic, shown the first time it can appear. */
  private static readonly CARDS: Record<string, { icon: string; title: string; body: string }> = {
    intro: {
      icon: '🎯',
      title: 'Match three',
      body:
        'Swipe a piece onto a neighbour, or tap one then tap next to it. ' +
        'Line up three or more of the same thing and they clear.',
    },
    specials: {
      icon: '🐕',
      title: 'Match four for the dog',
      body:
        'Four in a row and the dog turns up. Set him off and he scoots the ' +
        'whole row or column, clearing everything he drags past. Five in a ' +
        'row makes a colour bomb.',
    },
    jelly: {
      icon: '🟦',
      title: 'Blue jelly',
      body:
        'Clear a piece sitting on jelly to peel one layer away. The dots show ' +
        'how many layers are left. Clear every layer to win.',
    },
    blockers: {
      icon: '📦',
      title: 'Crates and stones',
      body:
        'Crates break when you match right beside them. Stones ignore that — ' +
        'only a dog sweep or a bomb will shift those.',
    },
    locks: {
      icon: '⛓',
      title: 'Chains',
      body: 'A chained piece cannot be moved. Match it to snap the chain, then it frees up.',
    },
    ingredients: {
      icon: '🌟',
      title: 'Star fruit',
      body:
        'Star fruit have to drop off the bottom of the board. Clear the pieces ' +
        'underneath them so they can fall.',
    },
    fuse: {
      icon: '🧨',
      title: 'Fuse pieces',
      body:
        'A fuse counts down one every move you make. Clear it before it reaches ' +
        'zero — if any fuse runs out, you lose the level straight away.',
    },
  };

  /** Cards this level would introduce that the player has not seen. */
  private teachFor(def: LevelDef): string[] {
    const keys: string[] = [];
    const want = (key: string, when: boolean) => {
      if (when && !hasSeen(this.profile, key)) keys.push(key);
    };
    want('intro', true);
    want('specials', def.id >= 3);
    want('jelly', def.jellySingle + def.jellyDouble + def.jellyTriple > 0);
    want('blockers', def.crates + def.stones > 0);
    want('locks', def.locks > 0);
    want('ingredients', def.ingredients > 0);
    want('fuse', def.fuses > 0);
    return keys;
  }

  /**
   * Steps through a set of cards. `onDone` runs after the last one; when
   * `review` is true the cards are shown again without re-marking them.
   */
  private showTeach(keys: string[], onDone: (() => void) | null, review = false): void {
    const cards = keys.filter((k) => App.CARDS[k]);
    if (!cards.length) {
      onDone?.();
      return;
    }

    let index = 0;
    const render = () => {
      const key = cards[index];
      const card = App.CARDS[key];
      const last = index === cards.length - 1;
      this.openModal(`
        <div class="teach-icon">${card.icon}</div>
        <h2>${card.title}</h2>
        <p class="lead">${card.body}</p>
        ${
          cards.length > 1
            ? `<div class="teach-dots">${cards
                .map((_, i) => `<i data-on="${i === index}"></i>`)
                .join('')}</div>`
            : ''
        }
        <div class="btn-row">
          <button class="btn btn-primary" id="teach-next">${last ? 'Got it' : 'Next'}</button>
        </div>
      `);
      $('teach-next').addEventListener('click', () => {
        if (!review) markSeen(this.profile, key);
        index++;
        if (index < cards.length) {
          render();
          return;
        }
        if (!review) saveProfile(this.profile);
        this.closeModal();
        onDone?.();
      });
    };
    render();
  }

  /** First launch: explain the basics before anything else. */
  private maybeShowIntro(): void {
    if (hasSeen(this.profile, 'intro') || Object.keys(this.profile.levels).length) return;
    this.showTeach(['intro'], null);
  }

  /* ---------------------------------------------------------------- *
   * Pre-level
   * ---------------------------------------------------------------- */

  private openPreLevel(levelId: number): void {
    const def = getLevel(levelId);
    const teach = this.teachFor(def);
    if (teach.length) {
      this.showTeach(teach, () => this.openPreLevel(levelId));
      return;
    }

    this.levelId = levelId;
    this.chosenBoosters = [];
    const stars = starsFor(this.profile, levelId);

    const boosters = BOOSTERS.map((b) => {
      const owned = countItem(this.profile, b.id);
      return `<button class="booster" type="button" data-booster="${b.id}" data-on="false" ${
        owned ? '' : 'disabled'
      }>
        ${owned ? `<b>${owned}</b>` : ''}
        <span>${b.icon}</span>${b.name}
      </button>`;
    }).join('');

    const hazards: string[] = [];
    if (def.fuses) hazards.push(`${def.fuses} fuse gem${def.fuses === 1 ? '' : 's'}`);
    if (def.locks) hazards.push(`${def.locks} chained gems`);
    if (def.stones) hazards.push(`${def.stones} stones`);
    if (def.colorCount >= 7) hazards.push('7 colours');

    this.openModal(`
      <div class="modal-tag" style="--ep-hue:${EPISODES[def.episode].hue}">${def.regionName} · ${def.episodeName}</div>
      <h2>Level ${def.id}</h2>
      <p class="lead">${isRegionFinale(def.id) ? 'Region finale · ' : isBossLevel(def.id) ? 'Boss · ' : ''}${def.moves} moves</p>
      <div class="star-row">${[0, 1, 2].map((i) => `<i data-on="${i < stars}">★</i>`).join('')}</div>
      <div class="goal-list">${def.objectives.map((o) => this.goalCard(o, def)).join('')}</div>
      ${hazards.length ? `<p class="hazards">⚠ ${hazards.join(' · ')}</p>` : ''}
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
          icon: `<span class="goal-swatch" style="background:${
            GEM_COLORS[(objective.color ?? 0) % GEM_COLORS.length]
          }"></span>`,
          label: `Collect ${objective.target} ${GEM_NAMES[(objective.color ?? 0) % GEM_NAMES.length]}`,
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
        return 'Match three or more of them to collect them.';
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

  /**
   * @param free Skip the life and booster cost. Used by the dev restart, so
   *   replaying a level while testing does not drain the profile.
   */
  private startLevel(free = false): void {
    if (!free) {
      if (!spendLife(this.profile)) {
        this.toast('Out of lives — they refill over time');
        return;
      }
      for (const id of this.chosenBoosters) consumeItem(this.profile, id);
    }
    saveProfile(this.profile);

    const def = getLevel(this.levelId);
    this.session = new LevelSession(def, {
      extraMoves: extraMovesFrom(this.profile.upgrades) + boosterExtraMoves(this.chosenBoosters),
      startingSpecials: [
        ...boosterSpecials(this.chosenBoosters),
        ...starlightSpecials(this.profile.upgrades),
      ],
      context: contextFor(this.profile.upgrades),
      seedOffset: Math.floor(Math.random() * 100000),
      fuseBonus: fuseBonus(this.profile.upgrades),
      purge: this.chosenBoosters.includes('colorPurge'),
    });

    this.armedPowerup = null;
    this.freeSwapFirst = null;
    this.resultShown = false;
    this.resultRecorded = false;
    this.idleTime = 0;

    // Tint the whole app with the episode's hue.
    this.setHue(EPISODES[def.episode].hue);

    this.closeModal();
    this.show('game');
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

    const goals = session.objectives
      .map((o) => {
        const { icon } = this.goalMeta(o, session.def);
        const shown = o.type === 'score' ? o.current.toLocaleString() : o.current;
        const target = o.type === 'score' ? o.target.toLocaleString() : o.target;
        return `<div class="goal" data-done="${o.done}">${icon}
          <span class="goal-count">${o.done ? '✓' : `${shown}/${target}`}</span></div>`;
      })
      .join('');

    const fuse = session.board.lowestFuse();
    const fuseChip =
      fuse !== null
        ? `<div class="goal goal-fuse" data-urgent="${fuse <= 3}">🧨<span class="goal-count">${fuse}</span></div>`
        : '';

    $('game-goals').innerHTML = goals + fuseChip;
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

  /** Spends a power-up, honouring the Quartermaster refund chance. */
  private spendPowerup(id: PowerupId): boolean {
    if (countItem(this.profile, id) <= 0) return false;
    if (Math.random() < powerupRefundChance(this.profile.upgrades)) {
      this.toast('Quartermaster saved it!');
    } else {
      consumeItem(this.profile, id);
    }
    saveProfile(this.profile);
    return true;
  }

  private armPowerup(id: PowerupId): void {
    if (!this.session || this.renderer.busy) return;
    if (countItem(this.profile, id) <= 0) return;

    if (id === 'shuffle') {
      if (!this.spendPowerup(id)) return;
      this.renderer.enqueue(this.session.usePowerup('shuffle'));
      this.armedPowerup = null;
      this.renderPowerbar();
      return;
    }

    this.armedPowerup = this.armedPowerup === id ? null : id;
    this.freeSwapFirst = null;
    this.renderer.selection = null;
    this.renderer.targeting = this.armedPowerup === 'hammer' || this.armedPowerup === 'lightning';
    this.renderPowerbar();
    if (this.armedPowerup) {
      this.toast(
        id === 'hammer'
          ? 'Tap a gem to smash it'
          : id === 'lightning'
            ? 'Tap a gem to strike its row and column'
            : 'Tap two neighbouring gems',
      );
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

      if (this.armedPowerup === 'hammer' || this.armedPowerup === 'lightning') {
        this.fireTargeted(this.armedPowerup, cell);
        return;
      }
      if (this.armedPowerup === 'freeswap') {
        this.pickFreeSwap(cell);
        return;
      }

      // Selection only ever changes on release, so a single tap cannot select
      // and deselect itself.
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
    this.renderHud();
  }

  private fireTargeted(kind: 'hammer' | 'lightning', pos: Pos): void {
    if (!this.session || !this.spendPowerup(kind)) return;
    this.renderer.enqueue(this.session.usePowerup(kind, pos));
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
    if (!this.spendPowerup('freeswap')) return;
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
      const coins = coinReward(stars, session.leftoverMoves, firstClear, this.profile.upgrades, session.def.id);
      this.profile.coins += coins;
      saveProfile(this.profile);

      const nextId = Math.min(session.def.id + 1, TOTAL_LEVELS);
      this.openModal(`
        <div class="modal-tag" style="--ep-hue:${EPISODES[session.def.episode].hue}">${session.def.episodeName}</div>
        <h2>Level cleared!</h2>
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
        this.mapRegion = regionOf(session.def.id);
        this.show('map');
      });
      $('to-next').addEventListener('click', () => {
        this.closeModal();
        if (session.def.id >= TOTAL_LEVELS) this.show('map');
        else this.openPreLevel(nextId);
      });
      return;
    }

    // Second Wind can hand the life back on a loss.
    let refunded = false;
    if (Math.random() < lifeRefundChance(this.profile.upgrades)) {
      this.profile.lives = Math.min(maxLives(this.profile.upgrades), this.profile.lives + 1);
      refunded = true;
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

    const fuseLoss = session.failReason === 'fuse';
    this.openModal(`
      <h2>${fuseLoss ? 'A fuse ran out!' : 'Out of moves'}</h2>
      <p class="lead">${
        fuseLoss
          ? 'Clear fuse gems before their counter hits zero.'
          : `${Math.round(session.completion() * 100)}% of the way there.`
      }</p>
      <div class="goal-list">${remaining}</div>
      ${refunded ? '<p class="lead refund">🌬️ Second Wind refunded your life</p>' : ''}
      <div class="btn-row">
        <button class="btn" id="to-map">Map</button>
        <button class="btn btn-primary" id="to-retry">Retry</button>
      </div>
    `);
    $('to-map').addEventListener('click', () => {
      this.closeModal();
      this.mapRegion = regionOf(session.def.id);
      this.show('map');
    });
    $('to-retry').addEventListener('click', () => {
      this.closeModal();
      this.openPreLevel(session.def.id);
    });
  }
}
