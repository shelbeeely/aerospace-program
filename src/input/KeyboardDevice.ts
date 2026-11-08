import type { Action, InputDevice, RawInput } from './types.ts';

const GAME_CODES = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'KeyB', 'KeyR', 'KeyC', 'KeyZ', 'KeyX',
  'KeyT', 'KeyG', 'KeyH', 'KeyY', 'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'F3',
  'Space', 'KeyN', 'BracketLeft', 'BracketRight', 'KeyM', 'KeyP', 'KeyK', 'KeyF', 'Period', 'Comma', 'F6', 'F7', 'KeyU',
]);

export class KeyboardDevice implements InputDevice {
  private readonly down = new Set<string>();
  private actions: Action[] = [];
  private throttleSet: number | null = null;
  private flapSteps = 0;

  constructor(target: Window = window) {
    target.addEventListener('keydown', (e) => {
      // Typing in the Studio (or any form field) must not fly the plane.
      const el = e.target as HTMLElement | null;
      if (el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable)) return;
      if (GAME_CODES.has(e.code)) e.preventDefault(); // stops Ctrl+S, F3 search, etc. where allowed
      if (e.repeat) return;
      this.down.add(e.code);
      switch (e.code) {
        case 'KeyR': this.actions.push('reset'); break;
        case 'KeyC': this.actions.push('camera'); break;
        case 'F3': this.actions.push('debug'); break;
        case 'KeyH': this.actions.push('help'); break;
        case 'KeyN': this.actions.push('studio'); break;
        case 'KeyY': this.actions.push('trimReset'); break;
        case 'BracketLeft': this.actions.push('prevVehicle'); break;
        case 'BracketRight': this.actions.push('nextVehicle'); break;
        case 'KeyM': this.actions.push('mute'); break;
        case 'KeyP': this.actions.push('screenshot'); break;
        case 'KeyK': this.actions.push('record'); break;
        case 'KeyF': this.actions.push('mouseFlight'); break;
        case 'KeyU': this.actions.push('autopilot'); break;
        case 'Period': case 'F7': this.flapSteps++; break; // flaps down a notch
        case 'Comma': case 'F6': this.flapSteps--; break; // flaps up a notch
        case 'KeyZ': this.throttleSet = 1; break;
        case 'KeyX': this.throttleSet = 0; break;
      }
    });
    target.addEventListener('keyup', (e) => this.down.delete(e.code));
    // Losing focus would otherwise leave keys "stuck".
    target.addEventListener('blur', () => this.down.clear());
  }

  private axis(neg: string, pos: string): number {
    return (this.down.has(pos) ? 1 : 0) - (this.down.has(neg) ? 1 : 0);
  }

  read(raw: RawInput): void {
    raw.pitch += this.axis('KeyW', 'KeyS'); // W = nose down, S = nose up (KSP / flight-sim style)
    raw.roll += this.axis('KeyA', 'KeyD');
    raw.yaw += this.axis('KeyQ', 'KeyE');
    const up = this.down.has('ShiftLeft') || this.down.has('ShiftRight');
    const dn = this.down.has('ControlLeft') || this.down.has('ControlRight');
    raw.throttleRate += (up ? 1 : 0) - (dn ? 1 : 0);
    if (this.down.has('KeyB') || this.down.has('Space')) raw.brake = 1;
    raw.trimRate += this.axis('KeyT', 'KeyG'); // T = nose-down trim, G = nose-up trim
    raw.flapSteps += this.flapSteps;
    this.flapSteps = 0;
    if (this.throttleSet !== null) {
      raw.throttleSet = this.throttleSet;
      this.throttleSet = null;
    }
  }

  drainActions(out: Action[]): void {
    out.push(...this.actions);
    this.actions = [];
  }
}
