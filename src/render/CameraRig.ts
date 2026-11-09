import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { PLANET } from '../sim/layout.ts';

export type CameraMode = 'chase' | 'orbit';

const _offset = new THREE.Vector3();
const _look = new THREE.Vector3();
const _up = new THREE.Vector3();
const _delta = new THREE.Vector3();
const _right = new THREE.Vector3();
const _tilt = new THREE.Quaternion();
const WORLD_UP = new THREE.Vector3(0, 1, 0);

/** Orbit camera: normal zoom range, and how far it may pull back to frame the whole globe (m). */
const ORBIT_NEAR_MAX = 400;
const ORBIT_GLOBE_MAX = PLANET.radius * 4;
const ORBIT_MAX_POLAR = Math.PI * 0.495;
/**
 * Physics is flat and the renderer bends the world around the point under the camera, so a
 * far orbit camera must stay nearly above the craft: a flat horizontal offset d puts the craft
 * d / R radians round the globe (at d ≈ πR it would be on the far side). Limit the polar angle
 * so the offset stays within a quarter radius once the camera is far out.
 */
function orbitMaxPolar(dist: number): number {
  const s = (PLANET.radius * 0.25) / Math.max(1, dist);
  return s >= 1 ? ORBIT_MAX_POLAR : Math.min(ORBIT_MAX_POLAR, Math.asin(s));
}

/**
 * Where the chase camera aims at altitude `h` (m) so the planet stays in frame: `pitch` is the
 * look direction's angle below level (rad) and `blend` (0..1) how much it overrides the normal
 * chase view. The horizon sinks acos(R / (R + h)) below eye level (40° at 2.5 km, 73° at
 * 20 km), so a level chase camera sees only sky. Below ~1 km nothing changes; by ~4 km the
 * camera keeps the horizon in the upper part of the frame, and from ~12 km it looks (almost)
 * straight down at the globe with the limb all round. `halfFov`: half the vertical FOV (rad).
 */
export function chaseAimAt(h: number, halfFov: number): { pitch: number; blend: number } {
  if (h <= 1000) return { pitch: 0, blend: 0 };
  const R = PLANET.radius;
  const dip = Math.acos(R / (R + h));
  const t = Math.min(1, (h - 1000) / 3000);
  return { pitch: Math.min(dip + halfFov * 0.55, Math.PI / 2 - 0.02), blend: t * t * (3 - 2 * t) };
}

/** Smoothed chase camera plus a free orbit mode (C toggles). */
export class CameraRig {
  mode: CameraMode = 'chase';
  /** Chase offset in craft space: behind (+Z) and above. */
  readonly chaseOffset = new THREE.Vector3(0, 2.8, 13);
  /** How quickly the chase camera follows the craft's rotation (1/s). */
  rotationStiffness = 3.5;
  /** 0 = horizon stays level, 1 = camera rolls fully with the craft. */
  rollFollow = 0.6;

  private readonly controls: OrbitControls;
  private readonly smoothRot = new THREE.Quaternion();
  private readonly lastTarget = new THREE.Vector3();
  private initialised = false;

  constructor(
    readonly camera: THREE.PerspectiveCamera,
    dom: HTMLElement,
  ) {
    this.controls = new OrbitControls(camera, dom);
    this.controls.enabled = false;
    this.controls.enableDamping = true;
    this.controls.minDistance = 4;
    this.controls.maxDistance = ORBIT_GLOBE_MAX;
    this.controls.maxPolarAngle = ORBIT_MAX_POLAR;
  }

  private suspended = false;

  /** Stop (or resume) listening to the pointer, e.g. while another view owns the canvas. */
  setSuspended(on: boolean): void {
    this.suspended = on;
    this.controls.enabled = !on && this.mode === 'orbit';
  }

  toggle(target: THREE.Vector3): void {
    this.mode = this.mode === 'chase' ? 'orbit' : 'chase';
    this.controls.enabled = !this.suspended && this.mode === 'orbit';
    if (this.mode === 'orbit') {
      this.camera.up.copy(WORLD_UP);
      this.controls.target.copy(target);
      this.lastTarget.copy(target);
      this.controls.update();
    }
  }

  snap(): void {
    this.initialised = false;
  }

  /**
   * Orbit mode: set the camera's distance from the craft (m), keeping its direction. Far
   * enough (a few planet radii) and the whole globe is in frame.
   */
  setOrbitDistance(d: number): void {
    if (this.mode !== 'orbit') return;
    const t = this.controls.target;
    _offset.copy(this.camera.position).sub(t);
    if (_offset.lengthSq() < 1e-6) _offset.set(0, 1, 1);
    const dist = Math.min(ORBIT_GLOBE_MAX, Math.max(this.controls.minDistance, d));
    _offset.setLength(dist);
    this.controls.maxPolarAngle = orbitMaxPolar(dist);
    this.camera.position.copy(t).add(_offset);
    this.controls.update(); // clamps the polar angle
  }

  /** Frame a craft of the given bounding radius (m): bigger craft get a more distant chase cam. */
  fitCraft(radius: number): void {
    // Small drones get a close camera; big craft (blimps) a farther, higher one.
    const k = Math.min(3, Math.max(0.35, radius / 6));
    this.chaseOffset.set(0, 2.8 * k * (k > 1.5 ? 1.4 : 1), 13 * k);
  }

  update(dt: number, target: THREE.Vector3, rotation: THREE.Quaternion, velocity: THREE.Vector3): void {
    if (this.mode === 'orbit') {
      // Carry the camera along with the craft, keep user's orbit angle/distance.
      _delta.copy(target).sub(this.lastTarget);
      this.camera.position.add(_delta);
      this.controls.target.copy(target);
      this.lastTarget.copy(target);
      // Mouse-wheel zoom is a fixed ratio per notch: speed it up far out so the globe view is
      // a few spins away rather than a hundred.
      const dist = this.camera.position.distanceTo(target);
      this.controls.zoomSpeed = dist > ORBIT_NEAR_MAX ? 3 : 1;
      this.controls.maxPolarAngle = orbitMaxPolar(dist);
      this.controls.update();
      return;
    }

    if (!this.initialised) {
      this.smoothRot.copy(rotation);
      this.initialised = true;
    }
    this.smoothRot.slerp(rotation, 1 - Math.exp(-this.rotationStiffness * dt));

    // Pull back slightly with speed for a sense of velocity.
    const speedPull = Math.min(1, velocity.length() / 80) * 4;
    _offset.copy(this.chaseOffset).setZ(this.chaseOffset.z + speedPull).applyQuaternion(this.smoothRot);
    _look.set(0, 0.8, -20).applyQuaternion(this.smoothRot);
    _up.set(0, 1, 0).applyQuaternion(this.smoothRot).lerp(WORLD_UP, 1 - this.rollFollow).normalize();

    // High up, swing the whole rig down about the horizontal right axis (camera rises over the
    // craft and looks down) so the planet, not empty sky, fills the frame.
    const aim = chaseAimAt(target.y, THREE.MathUtils.degToRad(this.camera.fov) / 2);
    if (aim.blend > 0) {
      _delta.subVectors(_look, _offset); // view direction, camera → aim point
      _right.crossVectors(_delta, WORLD_UP);
      if (_right.lengthSq() < 1e-8) _right.set(1, 0, 0).applyQuaternion(this.smoothRot).setY(0);
      if (_right.lengthSq() > 1e-8) {
        // Measured from the craft's own pitch, so a climb or dive ends at the same view.
        const pitch = Math.atan2(_delta.y, Math.hypot(_delta.x, _delta.z));
        const tilt = Math.min(Math.max(0, (pitch + aim.pitch) * aim.blend), pitch + Math.PI / 2 - 0.02);
        if (tilt > 1e-4) {
          _tilt.setFromAxisAngle(_right.normalize(), -tilt);
          _offset.applyQuaternion(_tilt).multiplyScalar(1 + aim.blend * 1.2);
          _look.applyQuaternion(_tilt);
          _up.applyQuaternion(_tilt);
        }
      }
    }
    this.camera.position.copy(target).add(_offset);
    if (this.camera.position.y < 0.6) this.camera.position.y = 0.6;
    _look.add(target);
    this.camera.up.copy(_up);
    this.camera.lookAt(_look);
  }
}
