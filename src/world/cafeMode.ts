/**
 * Walking around the café and restoring it. Tap the sand to walk, drag to
 * look around, tap a marker (or pick from the task list) to send the dog to
 * a job. Jobs with colour choices preview live on the real object before you
 * pay, and anything painted can be repainted later for free by tapping it.
 */
import * as THREE from 'three';
import { audio } from '../audio/audio.js';
import {
  CAFE_TASKS,
  CafeTask,
  STAGES,
  cafeState,
  choiceOf,
  currentStage,
  doTask,
  openTasks,
  taskCost,
} from '../game/cafe.js';
import type { Profile } from '../game/save.js';
import { Beach } from './beach.js';
import { World, WorldMode } from './engine.js';
import { burst, makeMarker, popIn } from './models.js';

export interface CafeDeps {
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

export class CafeMode implements WorldMode {
  /** Left half of the screen is a joystick on touch; WASD on keyboards. */
  readonly controls = 'half' as const;
  private world!: World;
  private markers: THREE.Sprite[] = [];
  private bubbleTimer = 0;
  private busy = false;

  constructor(private beach: Beach, private deps: CafeDeps) {}

  enter(world: World): void {
    this.world = world;
    world.bounds = (p) => this.beach.clamp(p);
    world.topbar.innerHTML = `
      <button class="icon-btn" id="w-back" type="button" aria-label="Back">←</button>
      <div class="world-title"><strong>Seaside Onigiri Café</strong><small id="w-stage"></small></div>
      <button class="icon-btn" id="w-time" type="button" aria-label="Change time of day">☀️</button>
      <div class="chip chip-gold"><span class="coin"></span><span id="w-coins">0</span></div>`;
    world.hud.innerHTML = `
      <div class="world-hint" id="w-hint">Tap to walk, or WASD / drag the left side like a joystick · drag the right side to look · tap a marker for a job</div>
      <button class="jump-btn small" id="w-jump" type="button" aria-label="Jump">⤴</button>
      <div class="world-bubble" id="w-bubble" hidden>
        <img src="${this.deps.dog(72)}" alt="" /><div id="w-bubble-text"></div>
      </div>
      <div class="world-sheet" id="w-sheet" hidden></div>
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
    world.dog.group.position.set(0, 0, 3);
    world.dog.stop();
    world.yaw = 0.25;
    world.pitch = 0.38;
    world.dist = 12;
    this.refresh();
    const state = cafeState(this.deps.profile());
    if (!state.done.length) {
      this.say('Oh no, look at this place! Let’s fix it up together. Tap a ❗ to start.', 7000);
    }
  }

  exit(): void {
    for (const m of this.markers) this.world.scene.remove(m);
    this.markers = [];
    clearTimeout(this.bubbleTimer);
  }

  update(_dt: number, t: number): void {
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
    const p = hit.point.clone();
    this.beach.clamp(p);
    this.world.dog.goTo(p);
  }

  /* ---------------------------------------------------------------- *
   * State and HUD
   * ---------------------------------------------------------------- */

  /** Rebuilds the café and the HUD from the save. */
  private refresh(preview?: { task: string; swatch: string }): void {
    const profile = this.deps.profile();
    const state = cafeState(profile);
    this.beach.build(state, preview);
    this.world.tappables = [this.beach.cafe, ...this.markers];

    // Anything painted can be tapped to change its colour.
    for (const [task, obj] of this.beach.paintable) {
      obj.userData.onTap = () => this.openTask(CAFE_TASKS.find((t) => t.id === task)!, true);
    }

    if (preview) return;
    for (const m of this.markers) this.world.scene.remove(m);
    this.markers = openTasks(state).map((task) => {
      const m = makeMarker(task.icon);
      const y = this.beach.groundAt(task.spot[0], task.spot[1]);
      m.position.set(task.spot[0], y + 2.6, task.spot[1]);
      m.userData.baseY = y + 2.6;
      m.userData.onTap = () => this.goDo(task);
      this.world.scene.add(m);
      return m;
    });
    this.world.tappables = [this.beach.cafe, ...this.markers];

    const stage = currentStage(state);
    const $ = (id: string) => this.world.root.querySelector<HTMLElement>(`#${id}`);
    const stageText = stage >= STAGES.length ? 'All done — open for business!' : `Stage ${stage + 1} of ${STAGES.length} · ${STAGES[stage]}`;
    $('w-stage')!.textContent = stageText;
    const pct = Math.round((state.done.length / CAFE_TASKS.length) * 100);
    $('w-progress')!.style.width = `${pct}%`;
    $('w-progress-text')!.textContent = `${state.done.length} / ${CAFE_TASKS.length} jobs`;
    const open = openTasks(state).length;
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
    const state = cafeState(profile);
    const tasks = openTasks(state);
    const stage = currentStage(state);
    const s = this.sheet();
    s.hidden = false;
    s.innerHTML = `
      <div class="sheet-head"><strong>${stage < STAGES.length ? STAGES[stage] : 'All jobs done!'}</strong><button class="sheet-x" id="s-x" type="button">✕</button></div>
      ${
        tasks.length
          ? tasks
              .map((t) => {
                const cost = taskCost(t.id);
                const afford = profile.infiniteCoins || profile.coins >= cost;
                return `<div class="job" data-job="${t.id}">
                  <span class="job-icon">${t.icon}</span>
                  <div class="job-body"><strong>${t.name}</strong><small>${KIND_LABEL[t.kind]}${t.swatches ? ' · choose a colour' : ''}</small></div>
                  <button class="buy-btn" ${afford ? '' : 'data-short="true"'} type="button"><span class="coin"></span> ${cost.toLocaleString()}</button>
                </div>`;
              })
              .join('')
          : '<p class="panel-blurb">The café is finished. Come back any time — and try it at night!</p>'
      }
      ${stage < STAGES.length - 1 ? `<p class="sheet-note">Finish these to unlock <strong>${STAGES[stage + 1]}</strong>.</p>` : ''}`;
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
  private goDo(task: CafeTask): void {
    if (this.busy) return;
    this.closeSheet();
    const to = new THREE.Vector3(task.spot[0], 0, task.spot[1]);
    this.beach.clamp(to);
    audio.sfx('tap');
    this.world.dog.goTo(to, () => this.openTask(task, false));
  }

  /** The job card: cost, colour choices with live preview, and the button. */
  private openTask(task: CafeTask, repaint: boolean): void {
    if (this.busy) return;
    const profile = this.deps.profile();
    const state = cafeState(profile);
    if (repaint && !task.swatches) return;
    const done = state.done.includes(task.id);
    if (!repaint && done) return;
    const cost = taskCost(task.id);
    let chosen = (choiceOf(state, task.id) ?? task.swatches?.[0])?.id ?? '';
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
        const obj = this.beach.paintable.get(task.id);
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
  private previewUnbuilt(task: CafeTask, chosen: string): void {
    const state = cafeState(this.deps.profile());
    const ghost = { done: [...state.done, task.id], choice: { ...state.choice, [task.id]: chosen }, decor: state.decor };
    this.beach.build(ghost);
    this.world.tappables = [this.beach.cafe, ...this.markers];
  }

  /** Pays, plays the work animation, then reveals the result. */
  private perform(task: CafeTask, choice?: string): void {
    const profile = this.deps.profile();
    const result = doTask(profile, task.id, choice);
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
    const state = cafeState(profile);
    const before = { ...state, done: state.done.filter((d) => d !== task.id) };
    this.beach.build(before);
    const at = new THREE.Vector3(task.spot[0], this.beach.groundAt(task.spot[0], task.spot[1]) + 0.4, task.spot[1]);
    const dog = this.world.dog;
    dog.dig(1.3);
    audio.sfx(task.kind === 'clean' ? 'crate' : 'scoot');
    const dust = task.kind === 'clean' ? '#e8cf98' : task.kind === 'paint' ? choiceOf(state, task.id)?.color ?? '#ffd15c' : '#ffd15c';
    burst(this.world.scene, this.world.animators, at, dust, 24, 2.5);
    window.setTimeout(() => burst(this.world.scene, this.world.animators, at, dust, 18, 3), 500);

    window.setTimeout(() => {
      this.refresh();
      const obj = this.beach.paintable.get(task.id);
      if (obj && task.kind !== 'clean') popIn(obj, this.world.animators);
      burst(this.world.scene, this.world.animators, at.clone().add(new THREE.Vector3(0, 0.8, 0)), '#ffe27a', 30, 4);
      audio.sfx(task.kind === 'clean' ? 'match' : 'special');
      this.say(task.line, 5000);
      this.busy = false;
      if (result.finished) window.setTimeout(() => this.deps.finished(), 1800);
    }, 1300);
  }
}
