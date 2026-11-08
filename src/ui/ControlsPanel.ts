import { GAMEPAD_COMMON, GAMEPAD_HELP } from '../input/GamepadDevice.ts';
import type { PlayerInput } from '../input/PlayerInput.ts';

const KEYBOARD: Array<[string, string]> = [
  ['W / S', 'pitch down / up'],
  ['A / D', 'roll'],
  ['Q / E', 'yaw'],
  ['Shift / Ctrl', 'throttle up / down'],
  ['Z / X', 'full / cut throttle'],
  ['B or Space', 'brakes'],
  ['T / G, Y', 'trim down / up, reset'],
  [', / . (F6 / F7)', 'flaps up / down a notch'],
  ['R', 'reset'],
  ['U', 'autopilot on / off (then W/S altitude, A/D heading, Shift/Ctrl speed)'],
  ['C', 'chase / orbit camera'],
  ['[ / ]', 'previous / next craft'],
  ['N', 'Hangar / flight'],
  ['F3', 'debug & weather'],
  ['H', 'this panel'],
];

const TOUCH: Array<[string, string]> = [
  ['Left thumb ↕', 'throttle lever (stays put; middle = hover for rotorcraft)'],
  ['Left thumb ↔', 'yaw'],
  ['Right thumb', 'stick: drag down = nose up, sideways = roll'],
  ['BRAKE', 'hold to brake'],
  ['Hangar', 'choose a craft or open Create / Studio'],
  ['Camera', 'switch chase / orbit view'],
  ['More', 'reset, craft selection, weather, flaps, sound and photos'],
];

const PROFILE_TIPS: Record<string, string> = {
  airplane: 'Full throttle, roll down the runway, pull back gently around 60 kt.',
  rotorcraft: 'Raise collective to the middle (≈ hover), then a little more to climb. The flight controller holds the tilt you ask for.',
  'lighter-than-air': 'Slightly heavy: add power and pitch up to climb on hull lift. Steer with yaw.',
};

function table(rows: Array<[string, string]>): HTMLTableElement {
  const t = document.createElement('table');
  for (const [k, v] of rows) {
    const tr = t.insertRow();
    tr.insertCell().textContent = k;
    tr.insertCell().textContent = v;
  }
  return t;
}

/** Help panel: controls for keyboard, gamepad (per profile) and touch, plus input settings. */
export class ControlsPanel {
  constructor(
    private readonly root: HTMLElement,
    private readonly player: PlayerInput,
  ) {
    this.render();
  }

  render(): void {
    const p = this.player;
    const pads = typeof navigator !== 'undefined' && navigator.getGamepads ? Array.from(navigator.getGamepads()).filter(Boolean) : [];
    const touchUi = document.body.classList.contains('touch-ui');
    const h = (tag: string, text: string) => {
      const e = document.createElement(tag);
      e.textContent = text;
      return e;
    };
    const profileLabel = p.profile === 'rotorcraft' ? 'Rotorcraft' : p.profile === 'lighter-than-air' ? 'Blimp' : 'Airplane';

    const settings = document.createElement('div');
    settings.className = 'controls-settings';
    const check = (label: string, value: boolean, onChange: (v: boolean) => void) => {
      const l = document.createElement('label');
      const i = document.createElement('input');
      i.type = 'checkbox';
      i.checked = value;
      i.addEventListener('change', () => onChange(i.checked));
      l.append(i, ` ${label}`);
      return l;
    };
    settings.append(
      check('Invert pitch', p.settings.invertPitch, (v) => p.updateSettings({ invertPitch: v })),
      check('Haptics', p.settings.haptics, (v) => p.updateSettings({ haptics: v })),
    );
    const touchSel = document.createElement('select');
    for (const [v, t] of [['auto', 'Touch controls: auto'], ['on', 'Touch controls: on'], ['off', 'Touch controls: off']]) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = t;
      touchSel.append(o);
    }
    touchSel.value = p.settings.touchControls;
    touchSel.addEventListener('change', () => {
      p.updateSettings({ touchControls: touchSel.value as 'auto' | 'on' | 'off' });
      setTimeout(() => this.render(), 50);
    });
    const expo = document.createElement('input');
    expo.type = 'range';
    expo.min = '0';
    expo.max = '0.8';
    expo.step = '0.05';
    expo.value = String(p.settings.expo);
    expo.addEventListener('input', () => p.updateSettings({ expo: Number(expo.value) }));
    const expoLabel = document.createElement('label');
    expoLabel.append('Stick expo (softer centre) ', expo);
    settings.append(touchSel, expoLabel);

    const gp = p.profile === 'rotorcraft' ? GAMEPAD_HELP.rotorcraft : GAMEPAD_HELP.airplane;
    const close = document.createElement('button');
    close.type = 'button'; close.className = 'panel-close'; close.textContent = 'Close controls ✕';
    close.addEventListener('click', () => this.root.classList.add('hidden'));
    const extraControls = document.createElement('details');
    extraControls.append(h('summary', 'Gamepad controls'), table([...gp, ...GAMEPAD_COMMON]));
    this.root.replaceChildren(
      close,
      h('h3', `Controls · ${profileLabel}`),
      h('p', PROFILE_TIPS[p.profile] ?? ''),
      ...(touchUi ? [h('h4', 'Touch'), table(TOUCH)] : []),
      ...(touchUi ? [extraControls] : [h('h4', pads.length ? `Gamepad · ${(pads[0]!.id.split('(')[0] || 'connected').trim()}` : 'Gamepad (connect one and press a button)'),
      table([...gp, ...GAMEPAD_COMMON])]),
      ...(touchUi ? [] : [h('h4', 'Keyboard'), table(KEYBOARD)]),
      h('h4', 'Settings'),
      settings,
      h('h4', 'Credits'),
      h('p', 'Tower kit: "Tron Buildings 1" by SpringSociety (sketchfab.com/jcreadingtutor), CC-BY-4.0, adapted into destructible block grids.'),
    );
  }
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;
/** Brief message at the top of the screen. */
export function toast(text: string, ms = 2800): void {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    document.body.append(el);
  }
  el.textContent = text;
  el.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el!.classList.remove('show'), ms);
}
