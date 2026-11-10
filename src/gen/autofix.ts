import * as THREE from 'three';
import { partQuaternion } from '../craft/massProperties.ts';
import type { CraftDef, PartDef, Vec3Tuple } from '../craft/types.ts';
import { partMinMass } from '../craft/moduleMass.ts';

const G = 9.81;

/**
 * Deterministic repairs for the mistakes designer models make most often, applied before a
 * draft is flight-tested (so a good concept isn't thrown away over a sign error):
 *
 * - Weight floors: a part lighter than its modules can be (moduleMass.ts) is raised to the floor.
 * - Control gain signs: each control surface's gain is checked against the torque its lift
 *   actually makes about the centre of mass (r × n): pitch input +1 must pitch the nose up,
 *   roll +1 must roll right, yaw +1 must yaw the nose right.
 * - Wheel springs: the static load on each wheel is split by moments about the CoM, and
 *   springs far from (load / (0.3 × restLength)) are resized, with damping at 0.11 × stiffness.
 *
 * Returns a corrected copy and a plain-English list of what changed (fed back to the model).
 */
export function autoFix(input: CraftDef): { craft: CraftDef; fixes: string[] } {
  const craft = structuredClone(input) as CraftDef;
  const fixes: string[] = [];
  // Weight floors: a part can't weigh less than what it carries (engines, boosters, batteries).
  for (const p of craft.parts) {
    const min = partMinMass(p);
    if (min.kg > p.mass * 1.001) {
      const kg = Math.ceil(min.kg);
      fixes.push(`part "${p.id}" weighed ${p.mass} kg, too light for its ${min.reasons.join(' + ')}: raised to ${kg} kg (budget the mass in your design)`);
      p.mass = kg;
    }
  }
  const total = craft.parts.reduce((s, p) => s + p.mass, 0);
  if (!(total > 0)) return { craft, fixes };
  const com = new THREE.Vector3();
  for (const p of craft.parts) com.addScaledVector(new THREE.Vector3(...p.position), p.mass / total);
  // Fuel shifts the CoM too (the tanks start full unless "fill" says otherwise).
  let fuelMass = 0;
  const fuelCom = new THREE.Vector3();
  for (const p of craft.parts) for (const m of p.modules ?? []) {
    if (m.type !== 'fuel') continue;
    const kg = m.capacity * (m.fill ?? 1);
    fuelMass += kg;
    fuelCom.addScaledVector(modulePoint(p, m.offset), kg);
  }
  if (fuelMass > 0) com.multiplyScalar(total).add(fuelCom).divideScalar(total + fuelMass);

  const q = new THREE.Quaternion();
  const r = new THREE.Vector3();
  const n = new THREE.Vector3();
  const t = new THREE.Vector3();
  // ---- control surfaces
  for (const p of craft.parts) {
    partQuaternion(p, q);
    for (const m of p.modules ?? []) {
      if (m.type !== 'aero' || !m.control || m.control.channel === 'flaps') continue;
      r.copy(modulePoint(p, m.offset)).sub(com);
      n.set(0, 1, 0).applyQuaternion(q);
      t.crossVectors(r, n);
      const c = m.control;
      // The torque component this channel needs, and how decisive it is (ignore near-zero arms).
      const want = c.channel === 'pitch' ? t.x : c.channel === 'roll' ? -t.z : -t.y;
      if (Math.abs(want) < 0.15 * t.length() || Math.abs(want) < 0.05) continue;
      const gain = Math.sign(want);
      if (Math.sign(c.gain) !== gain) {
        fixes.push(`${p.id}: ${c.channel} control gain ${c.gain} → ${gain} (it moved the craft the wrong way)`);
        c.gain = gain * Math.abs(c.gain || 1);
      }
    }
  }

  // ---- wheel springs
  const wheels: Array<{ part: PartDef; m: Extract<NonNullable<PartDef['modules']>[number], { type: 'wheel' }>; x: number; z: number }> = [];
  for (const p of craft.parts) for (const m of p.modules ?? []) {
    if (m.type !== 'wheel') continue;
    const at = modulePoint(p, m.offset).sub(com);
    wheels.push({ part: p, m, x: at.x, z: at.z });
  }
  if (wheels.length >= 3) {
    const loads = staticLoads(wheels, (total + fuelMass) * G);
    wheels.forEach((w, i) => {
      const k = loads[i] / (0.3 * Math.max(0.05, w.m.restLength));
      const ratio = w.m.stiffness / k;
      if (ratio > 0.5 && ratio < 2) return;
      const nk = Math.round(k);
      fixes.push(`${w.part.id}: wheel stiffness ${Math.round(w.m.stiffness)} → ${nk} N/m (carries ~${Math.round(loads[i] / G)} kg at rest), damping → ${Math.round(nk * 0.11)}`);
      w.m.stiffness = nk;
      w.m.damping = Math.round(nk * 0.11);
    });
  }
  return { craft, fixes };
}

function modulePoint(p: PartDef, offset?: Vec3Tuple): THREE.Vector3 {
  const v = new THREE.Vector3(...(offset ?? [0, 0, 0]));
  return v.applyQuaternion(partQuaternion(p)).add(new THREE.Vector3(...p.position));
}

/**
 * Static wheel loads: the minimum-norm solution of ΣF = W, Σx·F = 0, Σz·F = 0 (positions
 * relative to the CoM), with no wheel below 5% of the weight share.
 */
export function staticLoads(wheels: ReadonlyArray<{ x: number; z: number }>, weight: number): number[] {
  // A F = b with rows [1, x, z]; F = Aᵀ (A Aᵀ)⁻¹ b.
  const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const w of wheels) {
    const a = [1, w.x, w.z];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) M[i][j] += a[i] * a[j];
  }
  const y = solve3(M, [weight, 0, 0]);
  const floor = (0.05 * weight) / wheels.length;
  if (!y) return wheels.map(() => weight / wheels.length);
  return wheels.map((w) => Math.max(floor, y[0] + y[1] * w.x + y[2] * w.z));
}

function solve3(m: number[][], b: number[]): number[] | null {
  const det = (a: number[][]) =>
    a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1]) - a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0]) + a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]);
  const d = det(m);
  if (Math.abs(d) < 1e-9) return null;
  return [0, 1, 2].map((c) => det(m.map((row, i) => row.map((v, j) => (j === c ? b[i] : v)))) / d);
}
