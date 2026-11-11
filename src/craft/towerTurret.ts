import type { CraftDef } from './types.ts';

/**
 * The tower turret: a hostile emplacement on a tower roof. A short dark pedestal with a lit
 * collar, a turret head that traverses on it, twin gun barrels and a missile barrel that elevate
 * (fitted weapons: rounds leave from the muzzles), and a thin light line round the head. It is a
 * craft definition so it reuses the turret rig (craft/turret.ts), the weapon system and the
 * renderer; it never becomes a physics craft. Origin: the roof surface under its centre.
 */
export const TOWER_TURRET: CraftDef = {
  name: 'Tower Turret',
  formatVersion: 1,
  parts: [
    { id: 'pedestal', kind: 'pedestal', mass: 4000, position: [0, 1.1, 0], shape: { type: 'cylinder', radius: 1.5, length: 2.2, axis: 'y' }, color: '#1a0a08' },
    { id: 'pedestal.collar', kind: 'accent light', mass: 5, position: [0, 2.15, 0], shape: { type: 'cylinder', radius: 1.54, length: 0.06, axis: 'y' }, collider: false, color: '#ff2a12' },
    { id: 'head', kind: 'turret', mass: 2500, position: [0, 2.9, 0], shape: { type: 'box', size: [2.6, 1.3, 2.8] }, color: '#2a0e08' },
    {
      id: 'barrel.left', kind: 'barrel', mass: 150, position: [-0.5, 3.0, -2.9], shape: { type: 'cylinder', radius: 0.12, length: 3.0, axis: 'z' }, color: '#4a1a10',
      modules: [{ type: 'weapon', kind: 'gun', offset: [0, 0, -0.35], ammo: 2000 }],
    },
    {
      id: 'barrel.right', kind: 'barrel', mass: 150, position: [0.5, 3.0, -2.9], shape: { type: 'cylinder', radius: 0.12, length: 3.0, axis: 'z' }, color: '#4a1a10',
      modules: [{ type: 'weapon', kind: 'gun', offset: [0, 0, -0.35], ammo: 2000 }],
    },
    {
      id: 'turret.pod', kind: 'missile barrel', mass: 300, position: [1.65, 3.05, -0.7], shape: { type: 'box', size: [0.7, 0.7, 1.8] }, color: '#1a0a08',
      modules: [{ type: 'weapon', kind: 'missile', offset: [0, 0.12, 0.2], ammo: 99 }],
    },
    { id: 'turret.light', kind: 'accent light', mass: 5, position: [0, 3.56, -1.38], shape: { type: 'box', size: [2.5, 0.05, 0.05] }, collider: false, color: '#ff2a12' },
  ],
};

/**
 * The railgun turret: the same pedestal and traversing head, one long twin-rail barrel that
 * elevates (a fitted railgun at its tip) and a lit breech on the head. No missiles: it charges
 * for a moment, then puts a slug through whatever is on the line.
 */
export const RAIL_TURRET: CraftDef = {
  name: 'Railgun Turret',
  formatVersion: 1,
  parts: [
    { id: 'pedestal', kind: 'pedestal', mass: 4000, position: [0, 1.1, 0], shape: { type: 'cylinder', radius: 1.6, length: 2.2, axis: 'y' }, color: '#1a0a08' },
    { id: 'pedestal.collar', kind: 'accent light', mass: 5, position: [0, 2.15, 0], shape: { type: 'cylinder', radius: 1.64, length: 0.06, axis: 'y' }, collider: false, color: '#ff2a12' },
    { id: 'head', kind: 'turret', mass: 3200, position: [0, 2.95, 0.2], shape: { type: 'box', size: [2.2, 1.4, 3.2] }, color: '#2a0e08' },
    {
      id: 'barrel.rail', kind: 'barrel', mass: 400, position: [0, 3.05, -3.5], shape: { type: 'box', size: [0.5, 0.34, 4.4] }, color: '#4a1a10',
      modules: [{ type: 'weapon', kind: 'rail', offset: [0, 0, -0.3], ammo: 2000 }],
    },
    { id: 'turret.breech', kind: 'accent light', mass: 5, position: [0, 3.66, 0.6], shape: { type: 'box', size: [0.7, 0.05, 1.2] }, collider: false, color: '#ff2a12' },
  ],
};
