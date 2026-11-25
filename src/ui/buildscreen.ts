/**
 * The Build screen: a little diorama of the current region's project, built
 * up one piece at a time with coins. Every piece plays a short cutscene —
 * the dog pops up with something to say while the piece drops into place —
 * and finishing a project throws a party and opens the next one.
 */
import { audio } from '../audio/audio.js';
import {
  HAS_3D,
  PROJECTS,
  SLOTS,
  projectSize,
  activeProject,
  buildNext,
  isComplete,
  projectReward,
  projectsUnlocked,
  stepCost,
  stepsBuilt,
} from '../game/build.js';
import { REGIONS } from '../game/levels.js';
import type { Profile } from '../game/save.js';

export interface BuildDeps {
  profile(): Profile;
  save(): void;
  dog(px: number): string;
  toast(message: string): void;
  /** Shows the region's scenery and music behind the screen. */
  setRegion(region: number): void;
  refreshWallet(): void;
  /** Sends the player off to earn coins. */
  play(): void;
  /** Opens a project's 3D place, when it has one and the device can show it. */
  open3d?(index: number): boolean;
}

export class BuildScreen {
  private deps: BuildDeps;
  private index = 0;
  private cutscene: HTMLElement;
  private typing = 0;

  constructor(deps: BuildDeps) {
    this.deps = deps;
    this.cutscene = document.createElement('div');
    this.cutscene.className = 'cutscene';
    document.body.appendChild(this.cutscene);
  }

  /** Opens on the project most worth working on; 3D places open directly. */
  enter(): void {
    this.index = activeProject(this.deps.profile());
    if (HAS_3D.has(this.index) && this.deps.open3d?.(this.index)) return;
    this.render();
  }

  render(justBuilt = -1): void {
    const profile = this.deps.profile();
    const open = projectsUnlocked(profile);
    this.index = Math.min(this.index, open - 1);
    const project = PROJECTS[this.index];
    const region = REGIONS[this.index];
    this.deps.setRegion(this.index);
    document.documentElement.style.setProperty('--ep-hue', String(region.hue));

    // Project tabs: open ones, plus a teaser for the next locked one.
    const tabs = document.getElementById('build-tabs')!;
    tabs.innerHTML = '';
    PROJECTS.forEach((p, i) => {
      if (i > open) return;
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'region-chip';
      chip.style.setProperty('--ep-hue', String(REGIONS[i].hue));
      chip.dataset.on = String(i === this.index);
      chip.dataset.locked = String(i >= open);
      const built = stepsBuilt(profile, i);
      chip.innerHTML = `<strong>${i >= open ? '🔒 ' : isComplete(profile, i) ? '✅ ' : ''}${p.name}</strong><small>${
        i >= open ? 'Finish the last one or reach the next region' : `${built}/${projectSize(i)} ${HAS_3D.has(i) ? 'jobs · 3D' : 'built'}`
      }</small>`;
      chip.addEventListener('click', () => {
        if (i >= open) {
          this.deps.toast(`Finish ${PROJECTS[i - 1].name} or reach ${REGIONS[i].name} to open this`);
          return;
        }
        this.index = i;
        this.render();
      });
      tabs.appendChild(chip);
    });
    requestAnimationFrame(() =>
      tabs.querySelector<HTMLElement>('[data-on="true"]')?.scrollIntoView({ inline: 'center', block: 'nearest' }),
    );

    // A 3D place gets a doorway instead of the diorama.
    if (HAS_3D.has(this.index) && this.deps.open3d) {
      this.render3dCard(profile);
      return;
    }

    // The diorama.
    const built = stepsBuilt(profile, this.index);
    const stage = document.getElementById('diorama')!;
    const pieces = project.steps
      .map((step, i) => {
        const slot = SLOTS[i];
        const style = `left:${slot.x}%;top:${slot.y}%;--s:${slot.size};--delay:${(i % 4) * 0.4}s`;
        if (i < built) {
          return `<div class="piece built${i === justBuilt ? ' pop' : ''}" style="${style}" title="${step.name}"><span>${step.icon}</span></div>`;
        }
        if (i === built) {
          return `<button class="piece next" style="${style}" type="button" aria-label="Build ${step.name}"><span>${step.icon}</span><i>!</i></button>`;
        }
        return `<div class="piece future" style="${style}"></div>`;
      })
      .join('');
    stage.innerHTML = `
      <div class="diorama-stage" style="--g1:${project.ground[0]};--g2:${project.ground[1]}">
        <div class="diorama-ground"></div>
        ${pieces}
        <img class="diorama-dog" src="${this.deps.dog(72)}" alt="" />
      </div>`;
    stage.querySelector('.piece.next')?.addEventListener('click', () => this.build());

    // The task panel.
    const panel = document.getElementById('build-panel')!;
    const pct = Math.round((built / project.steps.length) * 100);
    let task: string;
    if (built < project.steps.length) {
      const step = project.steps[built];
      const cost = stepCost(this.index, built);
      const afford = profile.infiniteCoins || profile.coins >= cost;
      task = `
        <div class="task">
          <span class="task-icon">${step.icon}</span>
          <div class="task-body">
            <strong>${step.name}</strong>
            <small>${afford ? 'Ready to build!' : `Need ${(cost - profile.coins).toLocaleString()} more coins`}</small>
          </div>
          <button class="buy-btn" id="build-go" ${afford ? '' : 'data-short="true"'}><span class="coin"></span> ${cost.toLocaleString()}</button>
        </div>`;
    } else {
      const next = this.index + 1 < PROJECTS.length ? PROJECTS[this.index + 1] : null;
      const nextOpen = this.index + 1 < open;
      task = `
        <div class="task task-done">
          <span class="task-icon">🎉</span>
          <div class="task-body">
            <strong>All built!</strong>
            <small>${
              !next ? 'Every project is finished. You are amazing!' : nextOpen ? `Next up: ${next.name}` : `Reach ${REGIONS[this.index + 1].name} to keep building`
            }</small>
          </div>
          ${next && nextOpen ? '<button class="buy-btn" id="build-next">Go</button>' : ''}
        </div>`;
    }
    const reward = projectReward(this.index);
    panel.innerHTML = `
      <div class="build-head"><strong>${project.name}</strong><small>${built} / ${project.steps.length}</small></div>
      <div class="build-bar"><i style="width:${pct}%"></i></div>
      <p class="panel-blurb">${project.blurb} Finish it for <span class="coin"></span> ${reward.coins.toLocaleString()} and a Prism Gem.</p>
      ${task}`;
    panel.querySelector('#build-go')?.addEventListener('click', () => this.build());
    panel.querySelector('#build-next')?.addEventListener('click', () => {
      this.index++;
      this.render();
    });
  }

  private render3dCard(profile: Profile): void {
    const project = PROJECTS[this.index];
    const done = stepsBuilt(profile, this.index);
    const size = projectSize(this.index);
    document.getElementById('diorama')!.innerHTML = `
      <div class="enter3d">
        <div class="enter3d-art">🏝️<img src="${this.deps.dog(96)}" alt="" /></div>
        <strong>${project.name}</strong>
        <p>Walk around the beach in 3D, fix up the café job by job, and paint it your way.</p>
        <button class="btn btn-primary" id="enter-3d" type="button">Walk in →</button>
      </div>`;
    const pct = Math.round((done / size) * 100);
    document.getElementById('build-panel')!.innerHTML = `
      <div class="build-head"><strong>${project.name}</strong><small>${done} / ${size} jobs</small></div>
      <div class="build-bar"><i style="width:${pct}%"></i></div>
      <p class="panel-blurb">${project.blurb} It starts run-down: clean it up, repair it, paint it and open for business.</p>`;
    document.getElementById('enter-3d')!.addEventListener('click', () => this.deps.open3d?.(this.index));
  }

  private build(): void {
    const profile = this.deps.profile();
    const result = buildNext(profile, this.index);
    if (!result.ok) {
      if (result.reason === 'coins') {
        audio.sfx('invalid');
        this.talk(
          `We need ${result.short!.toLocaleString()} more coins for that. Let's play some levels!`,
          'Let’s play!',
          () => this.deps.play(),
          'Later',
        );
      }
      return;
    }
    this.deps.save();
    this.deps.refreshWallet();
    audio.sfx('special');
    this.render(result.stepIndex);
    this.sparkle(result.stepIndex);

    const after = () => {
      if (result.finished) this.celebrate(result.opened);
      else this.render();
    };
    window.setTimeout(() => this.talk(result.step.line, 'Yay!', after, null, result.step.icon), 500);
  }

  /** Sparkles bursting from a newly built piece. */
  private sparkle(stepIndex: number): void {
    const stage = document.querySelector<HTMLElement>('.diorama-stage');
    if (!stage) return;
    const slot = SLOTS[stepIndex];
    for (let i = 0; i < 14; i++) {
      const s = document.createElement('span');
      s.className = 'spark';
      const angle = (i / 14) * Math.PI * 2;
      const dist = 40 + Math.random() * 40;
      s.style.left = `${slot.x}%`;
      s.style.top = `${slot.y}%`;
      s.style.setProperty('--dx', `${Math.cos(angle) * dist}px`);
      s.style.setProperty('--dy', `${Math.sin(angle) * dist - 20}px`);
      s.textContent = i % 3 ? '✦' : '★';
      stage.appendChild(s);
      window.setTimeout(() => s.remove(), 900);
    }
  }

  /**
   * The cutscene: the dog slides up with a speech bubble that types itself
   * out. Tapping while it types finishes the line; the button moves on.
   */
  private talk(
    line: string,
    ok: string,
    onOk: () => void,
    cancel: string | null = null,
    icon = '',
  ): void {
    clearInterval(this.typing);
    this.cutscene.innerHTML = `
      <div class="cut-card">
        ${icon ? `<div class="cut-item">${icon}</div>` : ''}
        <div class="cut-talk">
          <img class="cut-dog" src="${this.deps.dog(96)}" alt="" />
          <div class="cut-bubble"><span id="cut-text"></span></div>
        </div>
        <div class="btn-row">
          ${cancel ? `<button class="btn" id="cut-cancel">${cancel}</button>` : ''}
          <button class="btn btn-primary" id="cut-ok">${ok}</button>
        </div>
      </div>`;
    this.cutscene.dataset.open = 'true';
    const text = this.cutscene.querySelector<HTMLElement>('#cut-text')!;
    let shown = 0;
    this.typing = window.setInterval(() => {
      shown++;
      text.textContent = line.slice(0, shown);
      if (shown % 3 === 0) audio.sfx('tap');
      if (shown >= line.length) clearInterval(this.typing);
    }, 28);
    this.cutscene.querySelector('.cut-bubble')!.addEventListener('click', () => {
      clearInterval(this.typing);
      text.textContent = line;
    });
    const close = () => {
      clearInterval(this.typing);
      this.cutscene.dataset.open = 'false';
    };
    this.cutscene.querySelector('#cut-ok')!.addEventListener('click', () => {
      close();
      onOk();
    });
    this.cutscene.querySelector('#cut-cancel')?.addEventListener('click', close);
  }

  /** The party for a project finished somewhere else (a 3D place). */
  celebrateProject(index: number): void {
    this.index = index;
    this.celebrate(null);
  }

  /** Grand opening: confetti, the reward, and the next project. */
  private celebrate(opened: number | null): void {
    const project = PROJECTS[this.index];
    const reward = projectReward(this.index);
    audio.sfx('win');
    const confetti = Array.from({ length: 46 }, (_, i) => {
      const colors = ['#ffd15c', '#74c8ff', '#5fdbab', '#ff9aae', '#b18cff', '#ffb36b'];
      return `<i style="left:${Math.random() * 100}%;background:${colors[i % colors.length]};--d:${(Math.random() * 0.8).toFixed(2)}s;--r:${Math.round(Math.random() * 360)}deg"></i>`;
    }).join('');
    const next = this.index + 1 < PROJECTS.length ? PROJECTS[this.index + 1] : null;
    const nextOpen = next && this.index + 1 < projectsUnlocked(this.deps.profile());
    this.cutscene.innerHTML = `
      <div class="confetti">${confetti}</div>
      <div class="cut-card cut-party">
        <div class="modal-tag">Grand opening</div>
        <h2>${project.name} is finished!</h2>
        <img class="cut-dog cut-dog-big" src="${this.deps.dog(120)}" alt="" />
        <div class="reward-row">
          <div class="reward"><span class="coin"></span><b>+${reward.coins.toLocaleString()}</b></div>
          <div class="reward"><span>🌈</span><b>+1 Prism Gem</b></div>
        </div>
        <p class="lead">${
          opened !== null && next ? `A new project opened: <strong>${next.name}</strong>!` : next && !nextOpen ? `Reach ${REGIONS[this.index + 1].name} to open the next project.` : next ? `Next up: <strong>${next.name}</strong>` : 'Every project is done. What a team!'
        }</p>
        <div class="btn-row">
          <button class="btn" id="cut-stay">Admire it</button>
          ${nextOpen ? '<button class="btn btn-primary" id="cut-next">Next project</button>' : ''}
        </div>
      </div>`;
    this.cutscene.dataset.open = 'true';
    this.deps.refreshWallet();
    for (let i = 0; i < 3; i++) window.setTimeout(() => audio.sfx('star', i), 300 + i * 260);
    this.cutscene.querySelector('#cut-stay')!.addEventListener('click', () => {
      this.cutscene.dataset.open = 'false';
      this.render();
    });
    this.cutscene.querySelector('#cut-next')?.addEventListener('click', () => {
      this.cutscene.dataset.open = 'false';
      this.index++;
      this.render();
    });
  }
}
