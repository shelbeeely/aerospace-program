import type { ControlProfile } from '../input/types.ts';

/**
 * What the screen shows for each kind of vehicle, and for the player's Bit on foot. Pure data:
 * the HUD shows the primary readouts in its compact strip (touch) and keeps the rest behind a
 * tap; the touch controls take their labels and hints from here.
 */
export type UiProfile = ControlProfile | 'foot';

/** HUD rows by key (the `#h-<key>` value element inside each row). */
export type HudKey = 'speed' | 'alt' | 'vs' | 'hdg' | 'thr' | 'fuel' | 'task' | 'strat';

export interface ProfileUi {
  /** Shown in the compact strip, in order. */
  primary: HudKey[];
  /** Label for the speed readout. */
  speedLabel: string;
  /** Label for the throttle readout and the lever (null: no lever). */
  lever: string | null;
  /** Hints under the thumbs. */
  leftHint: string;
  rightHint: string;
  /** Rows that mean nothing for this vehicle (hidden even when the HUD is opened). */
  hide: string[];
}

export const PROFILE_UI: Record<UiProfile, ProfileUi> = {
  airplane: {
    primary: ['speed', 'alt', 'vs', 'hdg', 'thr'],
    speedLabel: 'AIRSPEED',
    lever: 'POWER',
    leftHint: 'Slide: power\nSideways: rudder',
    rightHint: 'Drag down: nose up\nSideways: bank',
    hide: [],
  },
  rotorcraft: {
    primary: ['speed', 'alt', 'vs', 'hdg', 'thr'],
    speedLabel: 'SPEED',
    lever: 'LIFT',
    leftHint: 'Slide: lift (middle hovers)\nSideways: turn',
    rightHint: 'Drag: tilt and fly\nthat way',
    hide: ['aoa', 'flaps'],
  },
  'lighter-than-air': {
    primary: ['speed', 'alt', 'vs', 'hdg', 'thr'],
    speedLabel: 'SPEED',
    lever: 'POWER',
    leftHint: 'Slide: power\nSideways: turn',
    rightHint: 'Drag down: nose up\nSideways: turn',
    hide: ['aoa', 'flaps'],
  },
  ground: {
    primary: ['speed', 'hdg', 'thr', 'fuel'],
    speedLabel: 'SPEED',
    lever: 'CRUISE',
    leftHint: 'Slide: cruise power\nSideways: steer',
    rightHint: 'Up: go · Down: brake, reverse\nSideways: steer',
    hide: ['aoa', 'flaps', 'g', 'vs', 'alt', 'orb'],
  },
  foot: {
    // On foot the strip shows only what is under way: an errand, a charge counting down.
    primary: ['task', 'strat'],
    speedLabel: 'SPEED',
    lever: null,
    leftHint: '',
    rightHint: 'Drag up: walk\nSideways: turn',
    hide: ['aoa', 'flaps', 'g', 'vs', 'alt', 'orb', 'thr', 'trim', 'fuel', 'batt', 'bus', 'wind', 'wx', 'oat', 'speed'],
  },
};

/** The profile the screen should show: on foot wins over the vehicle's. */
export function uiProfile(vehicle: ControlProfile, onFoot: boolean): UiProfile {
  return onFoot ? 'foot' : vehicle;
}
