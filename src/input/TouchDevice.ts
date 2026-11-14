import { PROFILE_UI, type UiProfile } from '../hud/profiles.ts';
import { applyExpo, type Action, type InputContext, type InputDevice, type RawInput } from './types.ts';

type Child = Node | string;
function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, ...children: Child[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  for (const c of children) e.append(c);
  return e;
}

interface Drag {
  id: number;
  x0: number;
  y0: number;
  x: number;
  y: number;
  /** Throttle when the drag started (lever is relative, so touching it never jumps). */
  t0: number;
}

/**
 * On-screen controls for touch screens, built on Pointer Events (multi-touch, one pointer per
 * thumb). Layout adapts to portrait/landscape via CSS.
 *
 * - Left thumb: throttle lever. Vertical drag moves the throttle and it STAYS there (on
 *   rotorcraft, the middle = hover). Horizontal drag = yaw, springs back.
 * - Right thumb: floating stick (centres where you touch). Drag down = nose up (stick back),
 *   sideways = roll. Springs back.
 * - Buttons: brake (hold), reset, camera, hangar (Studio), debug, help, fullscreen.
 * - Per vehicle (src/hud/profiles.ts): the lever's name, the hints and the buttons follow the
 *   vehicle; on foot the lever goes, the stick walks, FIRE / DROP become YES / NO and BOARD
 *   gets back in. Hints show for the first few times a profile is used, then fade.
 */
export class TouchDevice implements InputDevice {
  readonly root: HTMLElement;
  private readonly lever: HTMLElement;
  private readonly leverKnob: HTMLElement;
  private readonly leverLabel: HTMLElement;
  private readonly leverValue: HTMLElement;
  private readonly stickZone: HTMLElement;
  private readonly stickBase: HTMLElement;
  private readonly stickKnob: HTMLElement;
  private readonly leftHint: HTMLElement;
  private readonly rightHint: HTMLElement;
  private readonly fireBtn: HTMLElement;
  private readonly fireAltBtn: HTMLElement;
  private profile: UiProfile | null = null;
  private hintTimer: ReturnType<typeof setTimeout> | null = null;
  private left: Drag | null = null;
  private right: Drag | null = null;
  private brake = false;
  private fire = false;
  private fireAlt = false;
  private hack = false;
  private pendingThrottle: number | null = null;
  private flapCycle = false;
  private actions: Action[] = [];
  private visible = false;
  private touchSeen = false;
  private readonly coarse = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;

  constructor() {
    // The lever's name and setting ride on its knob, so they never spill over the HUD.
    this.leverLabel = el('span', 'lever-label', 'POWER');
    this.leverValue = el('b', 'lever-value', '0');
    this.leverKnob = el('div', 'lever-knob', this.leverLabel, this.leverValue);
    this.lever = el('div', 'lever', el('div', 'lever-track'), this.leverKnob);
    this.stickKnob = el('div', 'stick-knob');
    this.stickBase = el('div', 'stick-base', this.stickKnob);
    this.rightHint = el('span', 'tz-hint', '');
    this.leftHint = el('span', 'tz-hint', '');
    this.stickZone = el('div', 'tz tz-right', this.stickBase, this.rightHint);
    const leftZone = el('div', 'tz tz-left', this.lever, this.leftHint);

    const brake = el('button', 'tbtn tbtn-brake', 'BRAKE');
    brake.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.brake = true;
      brake.classList.add('down');
    });
    for (const ev of ['pointerup', 'pointercancel', 'pointerleave'] as const) {
      brake.addEventListener(ev, () => {
        this.brake = false;
        brake.classList.remove('down');
      });
    }

    // Weapons triggers (shown only while the craft is armed: body.armed).
    const hold = (label: string, cls: string, set: (v: boolean) => void) => {
      const b = el('button', `tbtn tfire ${cls}`, label);
      b.addEventListener('pointerdown', (e) => { e.preventDefault(); set(true); b.classList.add('down'); });
      for (const ev of ['pointerup', 'pointercancel', 'pointerleave'] as const) b.addEventListener(ev, () => { set(false); b.classList.remove('down'); });
      return b;
    };
    const fire = hold('FIRE', 'tfire-1', (v) => (this.fire = v));
    const fireAlt = hold('DROP', 'tfire-2', (v) => (this.fireAlt = v));
    this.fireBtn = fire;
    this.fireAltBtn = fireAlt;
    const hackBtn = hold('HACK', 'tfire-3', (v) => (this.hack = v));

    let closeMenu = () => {};
    const button = (label: string, title: string, action: Action | (() => void), cls = 'tbtn') => {
      const b = el('button', cls, label);
      b.title = title;
      b.setAttribute('aria-label', title);
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        if (typeof action === 'function') action();
        else this.actions.push(action);
        closeMenu();
      });
      return b;
    };
    const more = el('button', 'tbtn', 'More ▾');
    more.type = 'button'; more.setAttribute('aria-expanded', 'false');
    more.setAttribute('aria-controls', 'touch-more');
    const menu = el('div', 'tmore hidden',
      button('New plane', 'New plane on the runway (world unchanged)', 'reset'),
      button('Reset world', 'Reset the whole world', 'resetWorld'),
      button('Previous craft', 'Previous craft', 'prevVehicle'),
      button('Next craft', 'Next craft', 'nextVehicle'),
      button('Navigator', 'Navigator: set a course (go to, land, orbit, chase; on foot, walk there)', 'apPanel'),
      button('Nav hold', 'Navigator: hold what you are doing now, on / off (on foot: walk back to the vehicle)', 'autopilot'),
      button('Debug & credits', 'Debug, weather and credits (give yourself credits here)', 'debug'),
      button('Flaps', 'Flaps: next detent', () => (this.flapCycle = true)),
      button('Weapons', 'Weapons loadout: next', 'loadout'),
      button('Map', 'Planet map: every vehicle', 'map'),
      button('Globe', 'Strike globe: send aircraft, call in strikes', 'globe'),
      button('On foot', 'Step out of the vehicle as a Bit, or get back in', 'foot'),
      button('Mercenaries', 'Hire mercenaries, buy a nuke or an EMP', 'mercs'),
      button('Strategic', 'Launch the nuke or EMP carried', 'strategic'),
      button('Sound', 'Sound on/off', 'mute'),
      button('Photo', 'Screenshot', 'screenshot'),
    );
    menu.id = 'touch-more';
    if (document.fullscreenEnabled) menu.append(button('Fullscreen', 'Fullscreen', () => this.toggleFullscreen()));
    menu.append(button('Close menu', 'Close more controls', () => {}));
    closeMenu = () => { menu.classList.add('hidden'); more.setAttribute('aria-expanded', 'false'); };
    more.addEventListener('pointerdown', e => {
      e.preventDefault();
      const open = menu.classList.contains('hidden');
      menu.classList.toggle('hidden', !open); more.setAttribute('aria-expanded', String(open));
    });
    more.textContent = '☰';
    more.title = 'More';
    more.setAttribute('aria-label', 'More controls');
    const bar = el('div', 'tbar',
      button('✦', 'Hangar & Studio', 'studio'),
      button('◉', 'Camera: chase / orbit', 'camera'),
      button('?', 'Controls and help', () => { this.actions.push('help'); this.showHints(); }), more,
    );
    const board = button('BOARD', 'Get back in your vehicle', 'foot', 'tbtn tbtn-board');

    this.root = el('div', 'touch hidden', leftZone, this.stickZone, brake, fire, fireAlt, hackBtn, board, bar, menu);
    document.body.append(this.root);

    this.bindLever(leftZone);
    this.bindStick(this.stickZone);
    window.addEventListener('touchstart', () => (this.touchSeen = true), { once: true, passive: true });
  }

  private toggleFullscreen(): void {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
  }

  private bindLever(zone: HTMLElement): void {
    zone.addEventListener('pointerdown', (e) => {
      if (this.left) return;
      e.preventDefault();
      zone.setPointerCapture(e.pointerId);
      this.left = { id: e.pointerId, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, t0: this.lastThrottle };
    });
    zone.addEventListener('pointermove', (e) => {
      if (this.left?.id !== e.pointerId) return;
      this.left.x = e.clientX;
      this.left.y = e.clientY;
      const h = this.lever.getBoundingClientRect().height || 1;
      this.pendingThrottle = Math.min(1, Math.max(0, this.left.t0 - (e.clientY - this.left.y0) / h));
    });
    const end = (e: PointerEvent) => {
      if (this.left?.id === e.pointerId) this.left = null;
    };
    zone.addEventListener('pointerup', end);
    zone.addEventListener('pointercancel', end);
  }

  private bindStick(zone: HTMLElement): void {
    zone.addEventListener('pointerdown', (e) => {
      if (this.right) return;
      e.preventDefault();
      zone.setPointerCapture(e.pointerId);
      this.right = { id: e.pointerId, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, t0: 0 };
      // Floating stick: the base jumps to where the thumb landed.
      const r = zone.getBoundingClientRect();
      this.stickBase.style.left = `${e.clientX - r.left}px`;
      this.stickBase.style.top = `${e.clientY - r.top}px`;
      this.stickBase.classList.add('active');
    });
    zone.addEventListener('pointermove', (e) => {
      if (this.right?.id !== e.pointerId) return;
      this.right.x = e.clientX;
      this.right.y = e.clientY;
    });
    const end = (e: PointerEvent) => {
      if (this.right?.id !== e.pointerId) return;
      this.right = null;
      this.stickBase.classList.remove('active');
      this.stickBase.style.left = '';
      this.stickBase.style.top = '';
      this.stickKnob.style.transform = '';
    };
    zone.addEventListener('pointerup', end);
    zone.addEventListener('pointercancel', end);
  }

  private lastThrottle = 0;

  private stickRadius(): number {
    return (this.stickBase.getBoundingClientRect().width || 120) * 0.5;
  }

  read(raw: RawInput, ctx: InputContext): void {
    this.updateVisibility(ctx);
    this.lastThrottle = ctx.throttle;
    this.setProfile(ctx.onFoot ? 'foot' : ctx.profile);
    this.leverValue.textContent = `${Math.round(ctx.throttle * 100)}`;
    if (!this.visible) return;
    const expo = ctx.settings.expo;

    if (this.pendingThrottle !== null) {
      raw.throttleSet = this.pendingThrottle;
      this.lastThrottle = this.pendingThrottle;
      this.pendingThrottle = null;
    }
    // Lever knob shows the actual throttle (keyboard/gamepad changes included).
    const shownYaw = this.left ? Math.max(-1, Math.min(1, (this.left.x - this.left.x0) / 60)) : 0;
    this.leverKnob.style.bottom = `calc(${(this.lastThrottle * 100).toFixed(1)}% - 22px)`;
    this.leverKnob.style.transform = `translateX(calc(-50% + ${(shownYaw * 30).toFixed(0)}px))`;
    if (this.left && !ctx.onFoot) raw.yaw += applyExpo(shownYaw, expo);

    if (this.right) {
      const R = this.stickRadius();
      let dx = this.right.x - this.right.x0;
      let dy = this.right.y - this.right.y0;
      const mag = Math.hypot(dx, dy);
      if (mag > R) {
        dx *= R / mag;
        dy *= R / mag;
      }
      this.stickKnob.style.transform = `translate(${dx.toFixed(0)}px, ${dy.toFixed(0)}px)`;
      const inv = ctx.settings.invertPitch ? -1 : 1;
      raw.roll += applyExpo(dx / R, expo);
      raw.pitch += applyExpo(dy / R, expo) * inv; // drag down = stick back = nose up
    }
    if (this.brake) raw.brake = 1;
    if (this.fire) raw.fire = true;
    if (this.fireAlt) raw.fireAlt = true;
    if (this.hack) raw.hack = true;
    if (this.flapCycle) {
      raw.flapCycle = true;
      this.flapCycle = false;
    }
  }

  /** Relabel the controls for this vehicle (or for walking), and show its hints for a while. */
  private setProfile(p: UiProfile): void {
    if (p === this.profile) return;
    this.profile = p;
    const ui = PROFILE_UI[p];
    this.leverLabel.textContent = ui.lever ?? '';
    this.leftHint.textContent = ui.leftHint;
    this.rightHint.textContent = ui.rightHint;
    const foot = p === 'foot';
    this.fireBtn.textContent = foot ? 'YES' : 'FIRE';
    this.fireAltBtn.textContent = foot ? 'NO' : 'DROP';
    if (foot) this.left = null;
    // Hints: the first three times this profile comes up, for eight seconds.
    const key = `aerospace.hints.${p}`;
    let seen = 0;
    try { seen = Number(localStorage.getItem(key) ?? 0) || 0; } catch { /* storage blocked */ }
    if (this.hintTimer) clearTimeout(this.hintTimer);
    this.root.classList.toggle('hints-on', seen < 3);
    if (seen < 3) {
      try { localStorage.setItem(key, String(seen + 1)); } catch { /* storage blocked */ }
      this.hintTimer = setTimeout(() => this.root.classList.remove('hints-on'), 8000);
    }
  }

  /** Show the hints again (the help button). */
  showHints(): void {
    if (this.hintTimer) clearTimeout(this.hintTimer);
    this.root.classList.add('hints-on');
    this.hintTimer = setTimeout(() => this.root.classList.remove('hints-on'), 8000);
  }

  private updateVisibility(ctx: InputContext): void {
    const mode = ctx.settings.touchControls;
    const want = mode === 'on' || (mode === 'auto' && (this.coarse || this.touchSeen));
    if (want === this.visible) return;
    this.visible = want;
    this.root.classList.toggle('hidden', !want);
    document.body.classList.toggle('touch-ui', want);
    if (!want) {
      this.left = this.right = null;
      this.brake = false;
    }
  }

  drainActions(out: Action[]): void {
    out.push(...this.actions);
    this.actions = [];
  }

  rumble(strength: number, durationMs: number): void {
    if (this.visible && typeof navigator !== 'undefined' && navigator.vibrate) {
      try {
        navigator.vibrate(strength > 0.6 ? [durationMs, 60, durationMs * 0.5] : durationMs);
      } catch {
        /* not allowed */
      }
    }
  }
}
