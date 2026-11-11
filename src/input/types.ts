/** Which control layout fits the craft being flown. */
export type ControlProfile = 'airplane' | 'rotorcraft' | 'lighter-than-air' | 'ground';

/** Raw per-device intent. All devices write into the same shape; axes are summed then clamped. */
export interface RawInput {
  pitch: number; // -1..1, +1 = nose up
  roll: number; // +1 = roll right
  yaw: number; // +1 = nose right
  /** Throttle rate: -1 (decrease) .. +1 (increase) */
  throttleRate: number;
  /** If set, jump the throttle to this value (Z/X keys, touch lever, rotorcraft collective stick). */
  throttleSet: number | null;
  brake: number;
  trimRate: number; // -1 nose down .. +1 nose up
  /** Flap detent steps this frame: +1 = one notch down, -1 = one notch up, 'cycle' = next notch (wraps). */
  flapSteps: number;
  flapCycle: boolean;
  /** Weapons triggers held this frame: primary (guns, cannon) and secondary (bombs, missiles). */
  fire: boolean;
  fireAlt: boolean;
  /** Turret traverse (+ right) and elevation (+ up), -1..1. */
  aimYaw: number;
  aimPitch: number;
}

export type Action =
  | 'reset'
  | 'resetWorld'
  | 'camera'
  | 'debug'
  | 'help'
  | 'trimReset'
  | 'studio'
  | 'nextVehicle'
  | 'prevVehicle'
  | 'mute'
  | 'screenshot'
  | 'record'
  | 'mouseFlight'
  | 'autopilot'
  | 'apPanel'
  | 'trail'
  | 'loadout'
  | 'map'
  | 'radarRange'
  | 'recentre'
  | 'chase'
  | 'mercs'
  | 'strategic';

/** What a device may know about the game when it reads. */
export interface InputContext {
  profile: ControlProfile;
  /** Current throttle 0..1 (so a touch lever can display it). */
  throttle: number;
  settings: InputSettings;
}

export interface InputDevice {
  /** Accumulate this device's intent into `raw`. */
  read(raw: RawInput, ctx: InputContext): void;
  /** Edge-triggered actions since the last call. */
  drainActions(out: Action[]): void;
  /** Optional haptics: strength 0..1, duration ms. */
  rumble?(strength: number, durationMs: number): void;
}

export interface InputSettings {
  /** Flip pitch on sticks/touch (some players expect "push up = nose up"). */
  invertPitch: boolean;
  /** Show the on-screen touch controls: auto (touch screens), always, or never. */
  touchControls: 'auto' | 'on' | 'off';
  /** Stick expo 0..1: softer around centre for fine control. */
  expo: number;
  /** Gamepad/phone vibration on crashes and structural failure. */
  haptics: boolean;
}

const SETTINGS_KEY = 'aerospace.input.v1';

export function loadInputSettings(): InputSettings {
  const d: InputSettings = { invertPitch: false, touchControls: 'auto', expo: 0.35, haptics: true };
  try {
    return { ...d, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') };
  } catch {
    return d;
  }
}

export function saveInputSettings(s: InputSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* storage blocked */
  }
}

/** Expo curve: keeps full range but softens the centre. */
export function applyExpo(v: number, expo: number): number {
  return v * (1 - expo) + v * v * v * expo;
}
