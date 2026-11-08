import RAPIER from '@dimforge/rapier3d-compat';
import { airportPlan } from './Airport.ts';
import { cityPlan } from './City.ts';

export interface StaticWorld {
  body: RAPIER.RigidBody;
  colliders: number;
  /** Rooftop lightning conductors: tallest point of each building (x, y, z). */
  conductors: Array<{ id: string; x: number; y: number; z: number }>;
}

/**
 * Solid city and airport: one fixed Rapier body carrying a cuboid (or upright cylinder for
 * octagonal towers) per piece. Static colliders cost nothing until something touches them, so a
 * crash into a skyscraper stops the craft and the impact damage model takes it from there.
 */
export function buildStaticWorld(world: RAPIER.World): StaticWorld {
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  let colliders = 0;
  const add = (shape: 'box' | 'oct', x: number, y: number, z: number, sx: number, sy: number, sz: number) => {
    const desc = shape === 'oct'
      ? RAPIER.ColliderDesc.cylinder(sy / 2, sx / 2)
      : RAPIER.ColliderDesc.cuboid(sx / 2, sy / 2, sz / 2);
    world.createCollider(desc.setTranslation(x, y, z).setFriction(0.7).setRestitution(0.05), body);
    colliders++;
  };
  const city = cityPlan();
  for (const p of city.pieces) add(p.shape, p.x, p.y, p.z, p.sx, p.sy, p.sz);
  const airport = airportPlan();
  for (const p of airport.pieces) if (p.solid) add(p.shape, p.x, p.y, p.z, p.sx, p.sy, p.sz);

  const conductors: StaticWorld['conductors'] = [];
  for (const b of city.buildings) conductors.push({ id: `city:${b.id}`, x: b.x, y: b.top, z: b.z });
  for (const s of city.spires) conductors.push({ id: `spire:${s.x.toFixed(0)},${s.z.toFixed(0)}`, x: s.x, y: s.y1, z: s.z });
  conductors.push({ id: 'airport:tower', x: airport.beacon.x, y: airport.beacon.y, z: airport.beacon.z });
  return { body, colliders, conductors };
}
