import * as THREE from 'three';

function phase(seed: number, axis: number, harmonic: number): number {
  let h = Math.imul(seed ^ (axis * 92821 + harmonic * 68917), 2246822519);
  h ^= h >>> 13;
  return ((h >>> 0) / 4294967296) * Math.PI * 2;
}

/** Analytic band-limited ground motion with a C2 envelope; no integration drift. */
function sample(age: number, duration: number, seed: number, amplitude: number, derivative: 0 | 2, out: THREE.Vector3): THREE.Vector3 {
  out.set(0, 0, 0);
  if (age <= 0 || age >= duration) return out;
  const a = Math.PI / duration;
  const s = Math.sin(a * age);
  const c = Math.cos(a * age);
  const envelope = s ** 4;
  const first = 4 * a * s ** 3 * c;
  const second = 4 * a * a * (3 * s * s * c * c - s ** 4);
  for (let axis = 0; axis < 3; axis++) {
    let value = 0;
    for (let k = 0; k < 4; k++) {
      const omega = 2 * Math.PI * (0.8 + k * 0.65 + axis * 0.12);
      const theta = omega * age + phase(seed, axis, k);
      const scale = amplitude * (axis === 1 ? 0.4 : 1) / (4 * (k + 1));
      value += scale * (derivative === 0 ? envelope * Math.sin(theta)
        : (second - envelope * omega * omega) * Math.sin(theta) + 2 * first * omega * Math.cos(theta));
    }
    out.setComponent(axis, value);
  }
  return out;
}

export function groundDisplacement(age: number, duration: number, seed: number, amplitude = 0.12, out = new THREE.Vector3()): THREE.Vector3 {
  return sample(age, duration, seed, amplitude, 0, out);
}

/** Acceleration (m/s²), also available to building support systems. */
export function groundAcceleration(age: number, duration: number, seed: number, amplitude = 0.12, out = new THREE.Vector3()): THREE.Vector3 {
  return sample(age, duration, seed, amplitude, 2, out);
}
