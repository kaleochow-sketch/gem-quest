/**
 * Walking around the café and restoring it. Tap the sand to walk, drag to
 * look around, tap a marker (or pick from the task list) to send the dog to
 * a job. Jobs with colour choices preview live on the real object before you
 * pay, and anything painted can be repainted later for free by tapping it.
 */
import * as THREE from 'three';
import { audio } from '../audio/audio.js';
import { PlaceData, PlaceTask, markSlept, sleptToday } from '../game/places.js';
import type { Profile } from '../game/save.js';
import { World, WorldMode } from './engine.js';
import { ball, burst, makeMarker, mat, popIn } from './models.js';
import type { Site, Spot } from './site.js';
import { Visitors, floatText, type Visitor } from './visitors.js';

/** Something the dog can do right now, shown as a button (E for the first). */
interface Action {
  label: string;
  run?: () => void;
  /** Shown greyed out with this reason instead of running. */
  disabled?: boolean;
}

export interface PlaceDeps {
  profile(): Profile;
  save(): void;
  refreshWallet(): void;
  dog(px: number): string;
  /** Leave the 3D café. */
  exit(): void;
  /** Go and earn coins. */
  play(): void;
  /** The last task was done. */
  finished(): void;
}

const KIND_LABEL: Record<string, string> = { clean: 'Clean up', repair: 'Repair', paint: 'Paint', build: 'Build' };

export class PlaceMode implements WorldMode {
  /** Left half of the screen is a joystick on touch; WASD on keyboards. */
  readonly controls = 'half' as const;
  private world!: World;
  private markers: THREE.Sprite[] = [];
  private bubbleTimer = 0;
  private busy = false;
  private visitors!: Visitors;
  private actionKey = '';
  private actions: Action[] = [];
  private actionTick = 0;
  /** The dog is resting on something (boat, lounger, tower, stool, hammock). */
  private pinned: { at: THREE.Vector3; exit: THREE.Vector3; kind: string } | null = null;
  private fishing: { bob: THREE.Mesh; bite: number; window: number; done: boolean } | null = null;
  private keyHandler = (e: KeyboardEvent) => {
    if (e.key.toLowerCase() === 'e' && !e.repeat) {
      e.preventDefault();
      this.runAction(0);
    }
  };

  constructor(private site: Site, private data: PlaceData, private deps: PlaceDeps) {}

  enter(world: World): void {
    this.world = world;
    world.bounds = (p) => this.site.clamp(p);
    world.topbar.innerHTML = `
      <button class="icon-btn" id="w-back" type="button" aria-label="Back">←</button>
      <div class="world-title"><strong>${this.data.name}</strong><small id="w-stage"></small></div>
      <button class="icon-btn" id="w-time" type="button" aria-label="Change time of day">☀️</button>
      <div class="chip chip-gold"><span class="coin"></span><span id="w-coins">0</span></div>`;
    world.hud.innerHTML = `
      <div class="world-hint" id="w-hint">Tap to walk, or WASD / drag the left side like a joystick · drag the right side to look · tap a marker for a job</div>
      <button class="jump-btn small" id="w-jump" type="button" aria-label="Jump">⤴</button>
      <div class="world-bubble" id="w-bubble" hidden>
        <img src="${this.deps.dog(72)}" alt="" /><div id="w-bubble-text"></div>
      </div>
      <div class="world-sheet" id="w-sheet" hidden></div>
      <div class="world-actions" id="w-actions"></div>
      <div class="world-fade" id="w-fade"></div>
      <div class="world-bar">
        <div class="world-progress"><i id="w-progress"></i><span id="w-progress-text"></span></div>
        <button class="btn btn-primary" id="w-tasks" type="button">📋 Jobs</button>
      </div>`;
    const $ = (id: string) => world.root.querySelector<HTMLElement>(`#${id}`)!;
    $('w-back').addEventListener('click', () => this.deps.exit());
    $('w-time').addEventListener('click', () => {
      const label = world.advanceTime();
      this.say(label === 'Night' ? 'Ooh, night time. Everything glows!' : `${label}! What a lovely beach.`);
    });
    $('w-tasks').addEventListener('click', () => this.showList());
    $('w-jump').addEventListener('pointerdown', (e) => {
      e.preventDefault();
      world.jump();
    });
    window.setTimeout(() => $('w-hint')?.classList.add('fade'), 6000);

    // Start the dog in front of the shack, looking at it.
    world.dog.group.position.set(this.site.start[0], 0, this.site.start[1]);
    world.dog.stop();
    world.dog.pose = null;
    window.addEventListener('keydown', this.keyHandler);
    this.visitors = new Visitors(world, this.site, {
      open: () => this.data.state(this.deps.profile()).done.includes('counter'),
      hasWorker: () => this.data.life(this.deps.profile()).worker,
      icon: () => this.data.product.icon,
      sold: (byWorker, at) => this.sold(byWorker, at),
      leftHungry: () => this.say('Oh no, they got tired of waiting! Serve at the counter, or hire a worker.'),
    });
    world.yaw = 0.25;
    world.pitch = 0.38;
    world.dist = 12;
    this.refresh();
    const state = this.data.state(this.deps.profile());
    if (!state.done.length) {
      this.say('Oh no, look at this place! Let’s fix it up together. Tap a ❗ to start.', 7000);
    }
  }

  exit(): void {
    for (const m of this.markers) this.world.scene.remove(m);
    this.markers = [];
    clearTimeout(this.bubbleTimer);
    window.removeEventListener('keydown', this.keyHandler);
    this.visitors.dispose();
    this.stopFishing();
    this.unpin(false);
  }

  update(dt: number, t: number): void {
    this.visitors.update(dt, t);
    this.updatePin();
    this.updateFishing(dt, t);
    this.actionTick -= dt;
    if (this.actionTick <= 0) {
      this.actionTick = 0.2;
      this.refreshActions();
    }
    this.markers.forEach((m, i) => {
      m.position.y = m.userData.baseY + Math.sin(t * 2.4 + i) * 0.15;
    });
    const icon = this.world.night > 0.5 ? '🌙' : this.world.time < 0.3 || this.world.time > 0.7 ? '🌅' : '☀️';
    const btn = this.world.root.querySelector('#w-time');
    if (btn && btn.textContent !== icon) btn.textContent = icon;
  }

  tap(hit: THREE.Intersection | null): void {
    if (!hit) return;
    this.closeSheet();
    if (this.fishing) return;
    const p = hit.point.clone();
    this.site.clamp(p);
    this.world.dog.goTo(p);
  }

  /* ---------------------------------------------------------------- *
   * State and HUD
   * ---------------------------------------------------------------- */

  /** Rebuilds the café and the HUD from the save. */
  private refresh(preview?: { task: string; swatch: string }): void {
    const profile = this.deps.profile();
    const state = this.data.state(profile);
    this.site.build(state, preview);
    this.world.tappables = [this.site.content, ...this.markers];

    // Anything painted can be tapped to change its colour.
    for (const [task, obj] of this.site.paintable) {
      obj.userData.onTap = () => this.openTask(this.data.tasks.find((t) => t.id === task)!, true);
    }

    if (preview) return;
    for (const m of this.markers) this.world.scene.remove(m);
    this.markers = this.data.open(state).map((task) => {
      const m = makeMarker(task.icon);
      const y = this.site.groundAt(task.spot[0], task.spot[1]);
      m.position.set(task.spot[0], y + 2.6, task.spot[1]);
      m.userData.baseY = y + 2.6;
      m.userData.onTap = () => this.goDo(task);
      this.world.scene.add(m);
      return m;
    });
    this.world.tappables = [this.site.content, ...this.markers];

    const stage = this.data.stage(state);
    const $ = (id: string) => this.world.root.querySelector<HTMLElement>(`#${id}`);
    const stageText = stage >= this.data.stages.length ? 'All done — open for business!' : `Stage ${stage + 1} of ${this.data.stages.length} · ${this.data.stages[stage]}`;
    $('w-stage')!.textContent = stageText;
    const pct = Math.round((state.done.length / this.data.tasks.length) * 100);
    $('w-progress')!.style.width = `${pct}%`;
    $('w-progress-text')!.textContent = `${state.done.length} / ${this.data.tasks.length} jobs`;
    const open = this.data.open(state).length;
    $('w-tasks')!.textContent = open ? `📋 Jobs (${open})` : '📋 Jobs';
    $('w-coins')!.textContent = profile.infiniteCoins ? '∞' : profile.coins.toLocaleString();
  }

  private say(text: string, ms = 4200): void {
    const bubble = this.world.root.querySelector<HTMLElement>('#w-bubble');
    const body = this.world.root.querySelector<HTMLElement>('#w-bubble-text');
    if (!bubble || !body) return;
    body.textContent = text;
    bubble.hidden = false;
    bubble.classList.remove('pop');
    void bubble.offsetWidth;
    bubble.classList.add('pop');
    clearTimeout(this.bubbleTimer);
    this.bubbleTimer = window.setTimeout(() => (bubble.hidden = true), ms);
  }

  private sheet(): HTMLElement {
    return this.world.root.querySelector<HTMLElement>('#w-sheet')!;
  }

  private closeSheet(): void {
    const s = this.sheet();
    if (!s.hidden && s.dataset.preview) {
      delete s.dataset.preview;
      this.refresh();
    }
    s.hidden = true;
  }

  /** The list of jobs open right now. */
  private showList(): void {
    const profile = this.deps.profile();
    const state = this.data.state(profile);
    const tasks = this.data.open(state);
    const stage = this.data.stage(state);
    const s = this.sheet();
    s.hidden = false;
    s.innerHTML = `
      <div class="sheet-head"><strong>${stage < this.data.stages.length ? this.data.stages[stage] : 'All jobs done!'}</strong><button class="sheet-x" id="s-x" type="button">✕</button></div>
      ${
        tasks.length
          ? tasks
              .map((t) => {
                const cost = this.data.cost(t.id);
                const afford = profile.infiniteCoins || profile.coins >= cost;
                return `<div class="job" data-job="${t.id}">
                  <span class="job-icon">${t.icon}</span>
                  <div class="job-body"><strong>${t.name}</strong><small>${KIND_LABEL[t.kind]}${t.swatches ? ' · choose a colour' : ''}</small></div>
                  <button class="buy-btn" ${afford ? '' : 'data-short="true"'} type="button"><span class="coin"></span> ${cost.toLocaleString()}</button>
                </div>`;
              })
              .join('')
          : `<p class="panel-blurb">${this.data.name} is finished. Come back any time — and try it at night!</p>`
      }
      ${stage < this.data.stages.length - 1 ? `<p class="sheet-note">Finish these to unlock <strong>${this.data.stages[stage + 1]}</strong>.</p>` : ''}`;
    s.querySelector('#s-x')!.addEventListener('click', () => this.closeSheet());
    s.querySelectorAll<HTMLElement>('[data-job]').forEach((el) =>
      el.addEventListener('click', () => {
        const task = tasks.find((t) => t.id === el.dataset.job)!;
        this.closeSheet();
        this.goDo(task);
      }),
    );
  }

  /** Sends the dog to a job, then opens it. */
  private goDo(task: PlaceTask): void {
    if (this.busy) return;
    this.closeSheet();
    const to = new THREE.Vector3(task.spot[0], 0, task.spot[1]);
    this.site.clamp(to);
    audio.sfx('tap');
    this.world.dog.goTo(to, () => this.openTask(task, false));
  }

  /** The job card: cost, colour choices with live preview, and the button. */
  private openTask(task: PlaceTask, repaint: boolean): void {
    if (this.busy) return;
    const profile = this.deps.profile();
    const state = this.data.state(profile);
    if (repaint && !task.swatches) return;
    const done = state.done.includes(task.id);
    if (!repaint && done) return;
    const cost = this.data.cost(task.id);
    let chosen = (this.data.choice(state, task.id) ?? task.swatches?.[0])?.id ?? '';
    const s = this.sheet();
    s.hidden = false;
    s.innerHTML = `
      <div class="sheet-head"><strong>${task.icon} ${repaint ? `Repaint: ${task.name.replace(/^(Build|Paint|Hang|Put up|Add|Open|Plant|Set out|String|Restore|Fix|Mend)\s+(the\s+|a\s+|an\s+)?/i, '')}` : task.name}</strong><button class="sheet-x" id="s-x" type="button">✕</button></div>
      ${
        task.swatches
          ? `<div class="swatches">${task.swatches
              .map(
                (sw) =>
                  `<button class="swatch" type="button" data-sw="${sw.id}" data-on="${sw.id === chosen}" style="--c:${sw.color}" title="${sw.label}"><i></i><small>${sw.label}</small></button>`,
              )
              .join('')}</div>`
          : `<p class="panel-blurb">${KIND_LABEL[task.kind]} · the dog is ready to help!</p>`
      }
      <div class="btn-row">
        <button class="btn" id="s-cancel" type="button">Not now</button>
        <button class="btn btn-primary" id="s-go" type="button">${
          repaint ? 'Repaint (free)' : `${KIND_LABEL[task.kind]} · <span class="coin"></span> ${cost.toLocaleString()}`
        }</button>
      </div>`;
    // Live preview: recolour the real thing, or show what will be built.
    const preview = () => {
      if (!task.swatches) return;
      s.dataset.preview = '1';
      if (done) this.refresh({ task: task.id, swatch: task.swatches.find((x) => x.id === chosen)!.color });
      else this.previewUnbuilt(task, chosen);
    };
    preview();
    s.querySelectorAll<HTMLElement>('[data-sw]').forEach((el) =>
      el.addEventListener('click', () => {
        chosen = el.dataset.sw!;
        s.querySelectorAll<HTMLElement>('[data-sw]').forEach((b) => (b.dataset.on = String(b === el)));
        audio.sfx('tap');
        preview();
      }),
    );
    s.querySelector('#s-x')!.addEventListener('click', () => this.closeSheet());
    s.querySelector('#s-cancel')!.addEventListener('click', () => this.closeSheet());
    s.querySelector('#s-go')!.addEventListener('click', () => {
      delete s.dataset.preview;
      s.hidden = true;
      if (repaint) {
        state.choice[task.id] = chosen;
        this.deps.save();
        this.refresh();
        const obj = this.site.paintable.get(task.id);
        if (obj) burst(this.world.scene, this.world.animators, obj.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, 1, 0)), '#ffffff', 20, 3);
        audio.sfx('special');
        this.say('Fresh paint! Looking good.');
        return;
      }
      this.perform(task, chosen || undefined);
    });
  }

  /**
   * Shows a not-yet-built thing in its colour by rebuilding as if the job
   * were done, so the player sees exactly what they are buying.
   */
  private previewUnbuilt(task: PlaceTask, chosen: string): void {
    const state = this.data.state(this.deps.profile());
    const ghost = { done: [...state.done, task.id], choice: { ...state.choice, [task.id]: chosen }, decor: state.decor };
    this.site.build(ghost);
    this.world.tappables = [this.site.content, ...this.markers];
  }

  /** Pays, plays the work animation, then reveals the result. */
  private perform(task: PlaceTask, choice?: string): void {
    const profile = this.deps.profile();
    const result = this.data.doTask(profile, task.id, choice);
    if (!result.ok) {
      audio.sfx('invalid');
      this.refresh();
      this.say(`We need ${result.short.toLocaleString()} more coins for that. Let’s play some levels!`, 5000);
      const s = this.sheet();
      s.hidden = false;
      s.innerHTML = `<div class="sheet-head"><strong>Not enough coins</strong><button class="sheet-x" id="s-x" type="button">✕</button></div>
        <p class="panel-blurb">Clear levels, play the bonus rounds and spin the Treat Wheel to earn more.</p>
        <div class="btn-row"><button class="btn" id="s-cancel" type="button">Later</button><button class="btn btn-primary" id="s-play" type="button">Play a level</button></div>`;
      s.querySelector('#s-x')!.addEventListener('click', () => this.closeSheet());
      s.querySelector('#s-cancel')!.addEventListener('click', () => this.closeSheet());
      s.querySelector('#s-play')!.addEventListener('click', () => this.deps.play());
      return;
    }
    this.deps.save();
    this.deps.refreshWallet();
    this.busy = true;
    // Rebuild the current (pre-task) look, then animate the change.
    const state = this.data.state(profile);
    const before = { ...state, done: state.done.filter((d) => d !== task.id) };
    this.site.build(before);
    const at = new THREE.Vector3(task.spot[0], this.site.groundAt(task.spot[0], task.spot[1]) + 0.4, task.spot[1]);
    const dog = this.world.dog;
    dog.dig(1.3);
    audio.sfx(task.kind === 'clean' ? 'crate' : 'scoot');
    const dust = task.kind === 'clean' ? '#e8cf98' : task.kind === 'paint' ? this.data.choice(state, task.id)?.color ?? '#ffd15c' : '#ffd15c';
    burst(this.world.scene, this.world.animators, at, dust, 24, 2.5);
    window.setTimeout(() => burst(this.world.scene, this.world.animators, at, dust, 18, 3), 500);

    window.setTimeout(() => {
      this.refresh();
      const obj = this.site.paintable.get(task.id);
      if (obj && task.kind !== 'clean') popIn(obj, this.world.animators);
      burst(this.world.scene, this.world.animators, at.clone().add(new THREE.Vector3(0, 0.8, 0)), '#ffe27a', 30, 4);
      audio.sfx(task.kind === 'clean' ? 'match' : 'special');
      this.say(task.line, 5000);
      this.busy = false;
      if (result.finished) window.setTimeout(() => this.deps.finished(), 1800);
    }, 1300);
  }

  /* ---------------------------------------------------------------- *
   * Interacting with the place
   * ---------------------------------------------------------------- */

  private coinsChanged(): void {
    this.deps.save();
    this.deps.refreshWallet();
    const p = this.deps.profile();
    const el = this.world.root.querySelector('#w-coins');
    if (el) el.textContent = p.infiniteCoins ? '∞' : p.coins.toLocaleString();
  }

  private gain(coins: number, at: THREE.Vector3, label?: string): void {
    this.deps.profile().coins += coins;
    floatText(this.world, at, label ?? `+${coins}`);
    audio.sfx('coin');
    this.coinsChanged();
  }

  private greet(v: Visitor): void {
    this.world.dog.face(v.rig.group.position);
    this.world.jump();
    const { coins, at } = this.visitors.greet(v);
    const lines = [
      `They love what you're doing with ${this.data.name}!`,
      'They say they’ll be back when it opens!',
      'A friendly hello — and a little tip for the work.',
      'They can’t wait to try it!',
    ];
    this.say(lines[Math.floor(Math.random() * lines.length)], 3000);
    this.gain(coins, at, `+${coins} 💛`);
  }

  /** A sale at the counter: the dog's go to you, the worker's to the tip jar. */
  private sold(byWorker: boolean, at: THREE.Vector3): void {
    const life = this.data.life(this.deps.profile());
    life.sold++;
    if (byWorker) {
      life.bank += this.data.product.price;
      floatText(this.world, at, `+${this.data.product.price} 🫙`, '#ffffff');
      this.deps.save();
      return;
    }
    life.stock = Math.max(0, life.stock - 1);
    const tip = Math.floor(Math.random() * 7);
    this.gain(this.data.product.price + tip, at, tip ? `+${this.data.product.price + tip} (tip!)` : undefined);
  }

  /** The spot the dog is standing at, if any. */
  private nearSpot(): Spot | null {
    const p = this.world.dog.group.position;
    let best: Spot | null = null;
    let bestD = Infinity;
    for (const s of this.site.spots) {
      const d = Math.hypot(p.x - s.x, p.z - s.z);
      if (d < s.r && d < bestD) {
        best = s;
        bestD = d;
      }
    }
    return best;
  }

  private actionsFor(spot: Spot | null): Action[] {
    const profile = this.deps.profile();
    const life = this.data.life(profile);
    const prod = this.data.product;
    if (this.fishing) {
      return [{ label: this.fishing.bite > 0 && !this.fishing.done ? '❗ Pull!' : '🎣 Waiting for a bite…', run: () => this.pull() }];
    }
    if (this.pinned) {
      const label: Record<string, string> = { boat: '🛶 Hop out', tower: '🪜 Climb down', lounger: '🏖️ Get up', table: '🪑 Get up', hammock: '🌅 Get up' };
      return [{ label: label[this.pinned.kind] ?? 'Get up', run: () => this.unpin(true) }];
    }
    if (!spot) return [];
    switch (spot.kind) {
      case 'hammock':
        return sleptToday(profile)
          ? [{ label: '💤 Already slept today', disabled: true }, { label: '🛏️ Lie down', run: () => this.lieDown(spot, false) }]
          : [{ label: '💤 Sleep until morning', run: () => this.lieDown(spot, true) }];
      case 'counter': {
        const out: Action[] = [];
        if (this.visitors.front()) {
          out.push(
            life.stock > 0
              ? { label: `${prod.icon} Serve (+${prod.price})`, run: () => this.serve(spot) }
              : { label: `${prod.icon} Out of ${prod.name} — ${prod.make.toLowerCase()}!`, disabled: true },
          );
        } else if (!life.worker) {
          out.push({ label: 'Waiting for customers…', disabled: true });
        }
        if (!life.worker) out.push({ label: `🧑‍🍳 Hire a worker · ${this.data.workerCost.toLocaleString()}`, run: () => this.hire() });
        else if (life.bank > 0) out.push({ label: `🫙 Collect tips (+${life.bank})`, run: () => this.collect(spot) });
        else out.push({ label: '🧑‍🍳 Your worker is on duty', disabled: true });
        return out;
      }
      case 'kitchen':
        return life.stock >= prod.max
          ? [{ label: `${prod.icon} Fully stocked (${life.stock})`, disabled: true }]
          : [{ label: `🍳 ${prod.make} (${life.stock}/${prod.max})`, run: () => this.cook(spot) }];
      case 'bonfire':
        return this.data.dailyLeft(profile, 'bonfire', 1)
          ? [{ label: '🔥 Roast a marshmallow', run: () => this.roast(spot) }]
          : [{ label: '🔥 Sit by the fire', run: () => this.sitBy(spot) }];
      case 'palm':
      case 'gather':
        return this.data.dailyLeft(profile, spot.key, 1)
          ? [{ label: `${spot.icon ?? '🌿'} ${spot.label ?? 'Gather'}`, run: () => this.gather(spot) }]
          : [{ label: `${spot.icon ?? '🌿'} Come back tomorrow`, disabled: true }];
      case 'pier': {
        const left = this.data.dailyLeft(profile, 'fish', 3);
        return left
          ? [{ label: `🎣 Fish (${left} left today)`, run: () => this.fish(spot) }]
          : [{ label: '🎣 No more bites today', disabled: true }];
      }
      case 'boat':
        return [{ label: '🛶 Hop in', run: () => this.rest(spot, 'boat', 'sit') }];
      case 'lounger':
        return [{ label: '☀️ Sunbathe', run: () => this.sunbathe(spot) }];
      case 'tower':
        return [{ label: '🔭 Climb up', run: () => this.climb(spot) }];
      case 'table':
        return [{ label: '🪑 Sit down', run: () => this.sitAtTable(spot) }];
      case 'flowers':
        return [{ label: '🌺 Smell the flowers', run: () => this.smell(spot) }];
      case 'landmark':
        return [{ label: `${spot.icon ?? '✨'} ${spot.label ?? 'Admire it'}`, run: () => this.admire(spot) }];
    }
    return [];
  }

  private refreshActions(): void {
    const sheetOpen = !this.sheet().hidden;
    const list = sheetOpen || this.busy ? [] : this.actionsFor(this.nearSpot());
    // Someone dropped by to look around: say hi.
    if (!sheetOpen && !this.busy && !this.fishing && !this.pinned) {
      const v = this.visitors.nearSightseer(this.world.dog.group.position);
      if (v) list.unshift({ label: '👋 Say hi', run: () => this.greet(v) });
    }
    const keyNow = list.map((a) => `${a.label}|${a.disabled ? 1 : 0}`).join('/');
    this.actions = list;
    if (keyNow === this.actionKey) return;
    this.actionKey = keyNow;
    const host = this.world.root.querySelector<HTMLElement>('#w-actions');
    if (!host) return;
    host.innerHTML = list
      .map(
        (a, i) =>
          `<button class="act-btn${i === 0 ? ' primary' : ''}" type="button" data-act="${i}" ${a.disabled ? 'disabled' : ''}>${a.label}${
            i === 0 && !a.disabled ? '<kbd>E</kbd>' : ''
          }</button>`,
      )
      .join('');
    host.querySelectorAll<HTMLElement>('[data-act]').forEach((el) =>
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.runAction(Number(el.dataset.act));
      }),
    );
  }

  private runAction(i: number): void {
    const a = this.actions[i];
    if (!a || a.disabled || !a.run) return;
    a.run();
    this.actionKey = '';
    this.actionTick = 0;
  }

  private at(spot: Spot, lift = 0): THREE.Vector3 {
    return new THREE.Vector3(spot.x, this.site.groundAt(spot.x, spot.z) + lift, spot.z);
  }

  /* --- the counter ---------------------------------------------------- */

  private serve(spot: Spot): void {
    const life = this.data.life(this.deps.profile());
    if (life.stock <= 0) return;
    this.world.dog.face(this.at(spot));
    this.world.jump();
    this.visitors.serve();
    if (life.stock === 3) this.say(`Running low on ${this.data.product.name} — ${this.data.product.make.toLowerCase()} at the station!`);
  }

  private hire(): void {
    const profile = this.deps.profile();
    const cost = this.data.workerCost;
    if (!profile.infiniteCoins && profile.coins < cost) {
      this.say(`A worker costs ${cost.toLocaleString()} coins. Play some levels and come back!`);
      audio.sfx('invalid');
      return;
    }
    if (!profile.infiniteCoins) profile.coins -= cost;
    const life = this.data.life(profile);
    life.worker = true;
    life.tick = Date.now();
    this.coinsChanged();
    audio.sfx('win');
    this.say('Welcome aboard! They will run the counter — and keep earning while we are away. Check the tip jar!', 6000);
  }

  private collect(spot: Spot): void {
    const life = this.data.life(this.deps.profile());
    if (life.bank <= 0) return;
    const coins = life.bank;
    life.bank = 0;
    this.gain(coins, this.at(spot, 2.6), `+${coins} 🫙`);
    burst(this.world.scene, this.world.animators, this.at(spot, 1.8), '#ffd23f', 24, 3);
  }

  private cook(spot: Spot): void {
    const life = this.data.life(this.deps.profile());
    const dog = this.world.dog;
    dog.face(this.at(spot));
    dog.dig(1.2);
    this.busy = true;
    audio.sfx('scoot');
    const at = this.at(spot, 1.9);
    burst(this.world.scene, this.world.animators, at, '#ffffff', 18, 1.6);
    window.setTimeout(() => {
      life.stock = Math.min(this.data.product.max, life.stock + this.data.product.batch);
      this.deps.save();
      floatText(this.world, at, `+${this.data.product.batch} ${this.data.product.icon}`, '#ffffff');
      audio.sfx('special');
      this.busy = false;
      this.say(`Fresh ${this.data.product.name}, ready to sell!`);
    }, 1200);
  }

  /* --- little pleasures -------------------------------------------------- */

  private roast(spot: Spot): void {
    if (!this.data.useDaily(this.deps.profile(), 'bonfire', 1)) return;
    this.sitBy(spot);
    window.setTimeout(() => {
      this.gain(25, this.at(spot, 2.2));
      this.say('Golden and gooey. Best marshmallow ever!');
    }, 900);
  }

  private sitBy(spot: Spot): void {
    const dog = this.world.dog;
    dog.face(this.at(spot));
    dog.pose = 'sit';
  }

  /** Shake a tree, pick berries, chip a crystal… once per spot per day. */
  private gather(spot: Spot): void {
    if (!this.data.useDaily(this.deps.profile(), spot.key, 1)) return;
    const dog = this.world.dog;
    dog.face(this.at(spot));
    this.world.jump();
    audio.sfx('crate');
    const reward = Math.round((spot.reward ?? 10) * (1 + this.data.region * 0.25));
    // Something drops and bounces.
    const nut = ball(0.16, mat(spot.kind === 'palm' ? '#6b4a2b' : '#ffd23f', 0.6), 12);
    nut.castShadow = true;
    nut.position.set(spot.x + 0.3, this.site.groundAt(spot.x, spot.z) + 3.5, spot.z + 0.2);
    this.world.scene.add(nut);
    let v = 0;
    let bounces = 0;
    const ground = this.site.groundAt(spot.x + 0.6, spot.z + 0.6) + 0.16;
    const fn = (dt: number) => {
      v -= 14 * dt;
      nut.position.y += v * dt;
      nut.position.x += dt * 0.6;
      if (nut.position.y < ground) {
        nut.position.y = ground;
        v = -v * 0.35;
        bounces++;
        if (bounces === 1) {
          audio.sfx('tap');
          this.gain(reward, nut.position.clone().add(new THREE.Vector3(0, 1, 0)), `+${reward} ${spot.icon ?? ''}`);
        }
        if (bounces > 2) {
          this.world.animators.delete(fn);
          window.setTimeout(() => this.world.scene.remove(nut), 2500);
        }
      }
    };
    this.world.animators.add(fn);
  }

  private smell(spot: Spot): void {
    const dog = this.world.dog;
    dog.face(this.at(spot));
    dog.dig(0.6);
    const color = this.data.choice(this.data.state(this.deps.profile()), 'flowers')?.color ?? '#ff5a6e';
    burst(this.world.scene, this.world.animators, this.at(spot, 1), color, 16, 1.8);
    const lines = ['Mmm, lovely!', 'Achoo! …Worth it.', 'Smells like sunshine.', 'These are my favourite.'];
    this.say(lines[Math.floor(Math.random() * lines.length)]);
  }

  private admire(spot: Spot): void {
    this.sitBy(spot);
    burst(this.world.scene, this.world.animators, this.at(spot, 2), '#ffe27a', 20, 2.5);
    audio.sfx('star');
    const lines = ['Wow. Just… wow.', 'We built that. Together!', 'I could look at this all day.'];
    this.say(lines[Math.floor(Math.random() * lines.length)]);
  }

  /* --- resting on things ------------------------------------------------- */

  /** Holds the dog on a piece of furniture until it moves again. */
  private pin(kind: string, at: THREE.Vector3, exit: THREE.Vector3, pose: 'sit' | 'lie', facing: number): void {
    const dog = this.world.dog;
    dog.stop();
    dog.steer(null);
    this.pinned = { at, exit, kind };
    this.world.bounds = (p) => p.copy(at);
    dog.group.position.copy(at);
    dog.face(new THREE.Vector3(at.x + Math.sin(facing), 0, at.z + Math.cos(facing)));
    dog.pose = pose;
    audio.sfx('swap');
  }

  /** Rests on a spot that carries its own seat and exit. */
  private rest(spot: Spot, kind: string, pose: 'sit' | 'lie'): void {
    const at = spot.at ? new THREE.Vector3(...spot.at) : this.at(spot, 0.4);
    const exit = spot.exit ? new THREE.Vector3(spot.exit[0], 0, spot.exit[1]) : this.at(spot).add(new THREE.Vector3(1.4, 0, 1.4));
    this.pin(kind, at, exit, pose, spot.facing ?? 0);
  }

  private updatePin(): void {
    if (!this.pinned) return;
    // Any movement (keys, joystick, a tap) gets the dog up.
    if (this.world.dog.moving || this.world.dog.pose === null) this.unpin(true);
  }

  private unpin(place: boolean): void {
    if (!this.pinned) return;
    const { exit, kind } = this.pinned;
    this.pinned = null;
    this.world.bounds = (p) => this.site.clamp(p);
    const dog = this.world.dog;
    dog.pose = null;
    // Getting up on purpose steps off at the exit spot; walking away just
    // carries on from where the dog was.
    if (place && !dog.moving) {
      dog.group.position.copy(exit);
      this.site.clamp(dog.group.position);
    }
    if (kind === 'tower') this.world.dist = 12;
  }

  private sunbathe(spot: Spot): void {
    this.rest(spot, 'lounger', 'lie');
    this.say('Ahh, warm sun. Just five more minutes…');
    // A sunny nap moves the day along a couple of hours.
    window.setTimeout(() => {
      if (this.pinned?.kind === 'lounger') this.world.time = (this.world.time + 0.06) % 1;
    }, 2500);
  }

  private climb(spot: Spot): void {
    this.rest(spot, 'tower', 'sit');
    this.world.dist = 18;
    this.say('What a view! I can see for miles from up here.');
  }

  private sitAtTable(spot: Spot): void {
    const seat = this.site.seats.findIndex(
      (s, i) => Math.hypot(s.x - spot.x, s.z - spot.z) < 1.4 && !this.visitors.seatTaken(i),
    );
    if (seat < 0) {
      this.say('All the stools are taken!');
      return;
    }
    const s = this.site.seats[seat];
    this.pin('table', new THREE.Vector3(s.x, s.y - 0.35, s.z), new THREE.Vector3(s.x + (s.x - spot.x), 0, s.z + (s.z - spot.z)), 'sit', s.facing);
  }

  /* --- sleeping ------------------------------------------------------------ */

  private lieDown(spot: Spot, sleep: boolean): void {
    this.rest(spot, 'hammock', 'lie');
    if (!sleep) {
      this.say('So comfy…');
      return;
    }
    const profile = this.deps.profile();
    if (sleptToday(profile)) return;
    markSlept(profile);
    const fade = this.world.root.querySelector<HTMLElement>('#w-fade')!;
    fade.classList.add('on');
    fade.textContent = 'Zzz…';
    this.busy = true;
    audio.sfx('star');
    window.setTimeout(() => {
      // A new day: morning light, and the daily things are fresh again.
      this.world.time = 0.27;
      this.data.life(profile).used = {};
      if (profile.fun) profile.fun.played = {};
      this.deps.save();
      this.deps.refreshWallet();
      fade.textContent = '☀️ Good morning!';
    }, 1600);
    window.setTimeout(() => {
      fade.classList.remove('on');
      this.busy = false;
      this.unpin(true);
      this.say('Good morning! A fresh day: the daily games, the Treat Wheel and today’s little jobs are all back. (One sleep a day.)', 7000);
    }, 3200);
  }

  /* --- fishing ------------------------------------------------------------- */

  private fish(spot: Spot): void {
    if (!this.data.useDaily(this.deps.profile(), 'fish', 3)) return;
    const dog = this.world.dog;
    this.rest(spot, 'pier', 'sit');
    const bobAt = spot.bob ? new THREE.Vector3(...spot.bob) : this.at(spot).add(new THREE.Vector3(0, -0.25, 3));
    dog.face(bobAt);
    const bob = new THREE.Mesh(new THREE.SphereGeometry(0.12, 12, 8), mat('#ff5a4e', 0.5));
    const top = new THREE.Mesh(new THREE.SphereGeometry(0.08, 10, 6), mat('#ffffff', 0.5));
    top.position.y = 0.09;
    bob.add(top);
    bob.position.copy(bobAt);
    bob.userData.y = bobAt.y;
    this.world.scene.add(bob);
    this.fishing = { bob, bite: -(1.6 + Math.random() * 2.6), window: 0, done: false };
    this.say('Shh… waiting for a nibble.');
    audio.sfx('swap');
  }

  private updateFishing(dt: number, t: number): void {
    const f = this.fishing;
    if (!f || f.done) return;
    const y = f.bob.userData.y as number;
    if (f.bite < 0) {
      f.bite += dt;
      f.bob.position.y = y + Math.sin(t * 2.5) * 0.03;
      if (f.bite >= 0) {
        f.bite = 0.001;
        audio.sfx('fuse');
        this.actionKey = '';
        this.actionTick = 0;
      }
    } else {
      // A bite! Dip and splash; pull within the window.
      f.window += dt;
      f.bob.position.y = y - 0.2 + Math.sin(t * 30) * 0.08;
      if (f.window > 1.2) {
        f.done = true;
        this.say('Aww, it got away!');
        window.setTimeout(() => this.stopFishing(), 600);
      }
    }
  }

  private pull(): void {
    const f = this.fishing;
    if (!f || f.done) return;
    if (f.bite <= 0) {
      f.done = true;
      this.say('Too soon! The fish swam off.');
      window.setTimeout(() => this.stopFishing(), 500);
      return;
    }
    f.done = true;
    const at = f.bob.position.clone().add(new THREE.Vector3(0, 1, 0));
    burst(this.world.scene, this.world.animators, f.bob.position.clone(), '#bfeaff', 20, 2.4);
    const profile = this.deps.profile();
    const roll = Math.random();
    if (roll < 0.06 && this.data.rollDecor && this.data.grantDecor) {
      const rare = this.data.rollDecor(profile);
      if (rare) {
        this.data.grantDecor(profile, rare.id);
        this.deps.save();
        this.refresh();
        this.say(`Whoa! You fished up a ${rare.name}! It’s on display now.`, 6000);
        audio.sfx('rainbow');
        window.setTimeout(() => this.stopFishing(), 700);
        return;
      }
    }
    if (roll < 0.22) {
      profile.inventory.shuffle = (profile.inventory.shuffle ?? 0) + 1;
      floatText(this.world, at, '+1 🔀', '#ffffff');
      this.deps.save();
      this.say('A bottle with a Shuffle inside. Handy!');
      audio.sfx('special');
    } else {
      const coins = Math.round((15 + Math.floor(Math.random() * 26)) * (1 + this.data.region * 0.25));
      const fishes = ['a sardine', 'a mackerel', 'a little snapper', 'a sea bream', 'a silly-looking puffer', 'a sparkly trout'];
      this.gain(coins, at, `+${coins} 🐟`);
      this.say(`Caught ${fishes[Math.floor(Math.random() * fishes.length)]}! Into the kitchen it goes.`);
    }
    window.setTimeout(() => this.stopFishing(), 700);
  }

  private stopFishing(): void {
    if (!this.fishing) return;
    this.world.scene.remove(this.fishing.bob);
    this.fishing = null;
    this.actionKey = '';
    if (this.pinned?.kind === 'pier') this.unpin(true);
  }
}
