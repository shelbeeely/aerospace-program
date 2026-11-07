import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export type CameraMode = 'chase' | 'orbit';

const _offset = new THREE.Vector3();
const _look = new THREE.Vector3();
const _up = new THREE.Vector3();
const _delta = new THREE.Vector3();
const WORLD_UP = new THREE.Vector3(0, 1, 0);

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
    this.controls.maxDistance = 400;
    this.controls.maxPolarAngle = Math.PI * 0.495;
  }

  toggle(target: THREE.Vector3): void {
    this.mode = this.mode === 'chase' ? 'orbit' : 'chase';
    this.controls.enabled = this.mode === 'orbit';
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

  update(dt: number, target: THREE.Vector3, rotation: THREE.Quaternion, velocity: THREE.Vector3): void {
    if (this.mode === 'orbit') {
      // Carry the camera along with the craft, keep user's orbit angle/distance.
      _delta.copy(target).sub(this.lastTarget);
      this.camera.position.add(_delta);
      this.controls.target.copy(target);
      this.lastTarget.copy(target);
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
    this.camera.position.copy(target).add(_offset);
    if (this.camera.position.y < 0.6) this.camera.position.y = 0.6;

    _look.set(0, 0.8, -20).applyQuaternion(this.smoothRot).add(target);
    _up.set(0, 1, 0).applyQuaternion(this.smoothRot).lerp(WORLD_UP, 1 - this.rollFollow).normalize();
    this.camera.up.copy(_up);
    this.camera.lookAt(_look);
  }
}
