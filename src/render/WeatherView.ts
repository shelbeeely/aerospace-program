import * as THREE from 'three/webgpu';
import type { Atmosphere, Precipitation } from '../sim/atmosphere.ts';
import type { WorldView } from './WorldView.ts';

const MAX_DROPS = 9000;
const BOX = 44; // metres, cube of falling drops around the camera
const CLOUD_RES = 128;
const CLOUD_SPAN = 16000; // metres covered by the cloud texture
const SKY_CLEAR = { horizon: new THREE.Color('#cfe3f2'), zenith: new THREE.Color('#3f7fc4') };
const SKY_OVERCAST = { horizon: new THREE.Color('#a3abb2'), zenith: new THREE.Color('#79838c') };
const SKY_STORM = { horizon: new THREE.Color('#5e666d'), zenith: new THREE.Color('#3e454c') };

const SNOW = new THREE.Color('#f2f5f8');
const _p = new THREE.Vector3();
const _rel = new THREE.Vector3();
const _c = new THREE.Color();

/**
 * Weather visuals, driven by the same Atmosphere the physics uses, so what you see is what the
 * craft flies through: rain streaks / snow falling with the wind's drift, a cloud deck drawn
 * from the same drifting cell field (base and tops), fog from visibility (and near-zero inside
 * cloud), dimmer and greyer light under overcast, a darker, shinier runway when it is wet.
 */
export class WeatherView {
  private readonly drops: THREE.LineSegments;
  private readonly dropPos: Float32Array;
  private readonly seeds: Float32Array;
  private readonly dropMat: THREE.LineBasicMaterial;
  private readonly cloudTex: THREE.DataTexture;
  private readonly cloudBase: THREE.Mesh;
  private readonly cloudTop: THREE.Mesh;
  private readonly baseMat: THREE.MeshBasicMaterial;
  private readonly topMat: THREE.MeshBasicMaterial;
  private readonly precip: Precipitation = { rate: 0, kind: 'none', waterContent: 0, velocity: new THREE.Vector3() };
  private cloudTimer = 1e9;
  private readonly cloudCenter = new THREE.Vector2();
  private readonly baseGround = new THREE.Color();
  private readonly baseRunway = new THREE.Color();
  private snowCover = 0;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly world: WorldView,
  ) {
    this.dropPos = new Float32Array(MAX_DROPS * 6);
    this.seeds = new Float32Array(MAX_DROPS * 3);
    for (let i = 0; i < this.seeds.length; i++) this.seeds[i] = Math.random() * BOX;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.dropPos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setDrawRange(0, 0);
    this.dropMat = new THREE.LineBasicMaterial({ color: '#c8d6e2', transparent: true, opacity: 0.35, depthWrite: false, fog: false });
    this.drops = new THREE.LineSegments(g, this.dropMat);
    this.drops.frustumCulled = false;
    this.drops.renderOrder = 2;
    scene.add(this.drops);

    const data = new Uint8Array(CLOUD_RES * CLOUD_RES * 4);
    this.cloudTex = new THREE.DataTexture(data, CLOUD_RES, CLOUD_RES, THREE.RGBAFormat);
    this.cloudTex.magFilter = THREE.LinearFilter;
    this.cloudTex.minFilter = THREE.LinearFilter;
    this.cloudTex.colorSpace = THREE.SRGBColorSpace;
    const plane = new THREE.PlaneGeometry(CLOUD_SPAN, CLOUD_SPAN);
    plane.rotateX(-Math.PI / 2);
    this.baseMat = new THREE.MeshBasicMaterial({ map: this.cloudTex, transparent: true, depthWrite: false, side: THREE.DoubleSide, color: '#8d969e' });
    this.topMat = new THREE.MeshBasicMaterial({ map: this.cloudTex, transparent: true, depthWrite: false, side: THREE.DoubleSide, color: '#f4f7fa' });
    this.cloudBase = new THREE.Mesh(plane, this.baseMat);
    this.cloudTop = new THREE.Mesh(plane, this.topMat);
    for (const m of [this.cloudBase, this.cloudTop]) {
      m.frustumCulled = false;
      m.visible = false;
      scene.add(m);
    }
    this.baseGround.copy(world.groundMat.color);
    this.baseRunway.copy(world.runwayMat.color);
  }

  /** Rebuild the cloud texture from the atmosphere's cell field around (x, z). */
  private paintClouds(atm: Atmosphere, x: number, z: number): void {
    const cover = atm.settings.cloudCover ?? 0;
    const data = this.cloudTex.image.data as Uint8Array;
    const step = CLOUD_SPAN / CLOUD_RES;
    const x0 = x - CLOUD_SPAN / 2;
    const z0 = z - CLOUD_SPAN / 2;
    const storm = atm.settings.storm ?? 0;
    for (let j = 0; j < CLOUD_RES; j++) {
      for (let i = 0; i < CLOUD_RES; i++) {
        // Texture v runs opposite to world z on the rotated plane.
        const wx = x0 + (i + 0.5) * step;
        const wz = z0 + (CLOUD_RES - j - 0.5) * step;
        const v = atm.cellValue(wx, wz);
        const a = Math.min(1, Math.max(0, (v - (1 - cover)) / 0.12));
        const core = Math.min(1, Math.max(0, (v - (1 - cover)) / Math.max(0.05, cover)));
        const shade = 255 - Math.round(core * (70 + 90 * storm));
        const k = (j * CLOUD_RES + i) * 4;
        data[k] = data[k + 1] = data[k + 2] = shade;
        // Fade toward the texture edge so the deck has no hard border.
        const ex = Math.min(i, CLOUD_RES - 1 - i, j, CLOUD_RES - 1 - j) / 12;
        data[k + 3] = Math.round(255 * a * Math.min(1, ex) * (cover >= 0.95 ? 1 : 0.92));
      }
    }
    this.cloudTex.needsUpdate = true;
    this.cloudCenter.set(x, z);
  }

  update(dt: number, camera: THREE.Camera, cameraVelocity: THREE.Vector3, atm: Atmosphere, groundWetness: number, inCloud: boolean): void {
    const s = atm.settings;
    const cam = camera.position;
    const cover = s.cloudCover ?? 0;
    const base = s.cloudBase ?? 1200;
    const top = Math.max(base + 50, s.cloudTop ?? 2500);
    const storm = s.storm ?? 0;

    // --- Cloud deck (repainted every couple of seconds; it drifts slowly)
    const showClouds = cover > 0.01;
    this.cloudBase.visible = this.cloudTop.visible = showClouds;
    if (showClouds) {
      this.cloudTimer += dt;
      if (this.cloudTimer > 2 || Math.hypot(cam.x - this.cloudCenter.x, cam.z - this.cloudCenter.y) > 1500) {
        this.cloudTimer = 0;
        this.paintClouds(atm, cam.x, cam.z);
      }
      // Ground fog (base at the surface) is drawn by the fog alone: a plane there would fight
      // the ground for depth.
      // From inside the layer only the fog shows; from below only the base, from above only the tops.
      this.cloudBase.visible = base > 30 && cam.y < base;
      this.cloudTop.visible = cam.y > top;
      this.cloudBase.position.set(this.cloudCenter.x, base, this.cloudCenter.y);
      this.cloudTop.position.set(this.cloudCenter.x, top, this.cloudCenter.y);
      this.baseMat.color.set(storm > 0.3 ? '#5d656c' : '#8d969e');
    } else this.cloudTimer = 1e9;

    // --- Light and sky: overcast when under (or in) the deck
    const below = cam.y < top ? 1 : 0.15;
    const overcast = Math.min(1, cover * below * (cover > 0.6 ? 1 : 0.6));
    _c.copy(SKY_CLEAR.horizon).lerp(SKY_OVERCAST.horizon, overcast).lerp(SKY_STORM.horizon, storm * below);
    this.world.horizon.copy(_c);
    _c.copy(SKY_CLEAR.zenith).lerp(SKY_OVERCAST.zenith, overcast).lerp(SKY_STORM.zenith, storm * below);
    this.world.zenith.copy(_c);
    this.world.sun.intensity = 2.2 * (1 - 0.85 * overcast) * (1 - 0.5 * storm * below);
    this.world.hemi.intensity = 1.1 * (1 - 0.35 * overcast);

    // --- Fog from visibility (Koschmieder: contrast falls to 2% at the visibility distance)
    const fog = this.scene.fog as THREE.FogExp2;
    const vis = inCloud ? 60 : Math.min(15000, s.visibility ?? 15000);
    const density = 1.978 / vis; // see WorldView: 2% contrast at the visibility distance
    // Ease in log space so entering cloud closes in quickly but smoothly.
    fog.density = Math.exp(Math.log(fog.density) + (Math.log(density) - Math.log(fog.density)) * Math.min(1, dt * 2));
    fog.color.copy(inCloud ? _c.set('#c9ced2') : this.world.horizon);

    // --- Wet ground darkens; falling snow whitens it (colour only, so no shader variants).
    const w = Math.min(1, groundWetness * 3);
    atm.precipitationAt(_p.set(cam.x, 1, cam.z), 0, this.precip);
    const snowing = this.precip.kind === 'snow' ? Math.min(1, this.precip.rate / 3) : 0;
    this.snowCover += ((snowing > 0 ? 0.65 * snowing : 0) - this.snowCover) * Math.min(1, dt / (snowing > 0 ? 30 : 300));
    this.world.groundMat.color.copy(this.baseGround).multiplyScalar(1 - 0.3 * w).lerp(SNOW, this.snowCover);
    this.world.runwayMat.color.copy(this.baseRunway).multiplyScalar(1 - 0.4 * w).lerp(SNOW, this.snowCover * 0.5);

    // --- Rain / snow around the camera, falling with the physics' drop velocity
    atm.precipitationAt(cam, 0, this.precip);
    const p = this.precip;
    const n = p.kind === 'none' ? 0 : Math.min(MAX_DROPS, Math.round((p.kind === 'snow' ? 600 : 150) * p.rate ** (p.kind === 'snow' ? 0.6 : 0.85)));
    this.drops.geometry.setDrawRange(0, n * 2);
    if (n === 0) return;
    const snow = p.kind === 'snow';
    this.dropMat.color.set(snow ? '#ffffff' : '#c8d6e2');
    this.dropMat.opacity = snow ? 0.85 : Math.min(0.5, 0.2 + p.rate / 300);
    // Streak = drop motion relative to the camera during a ~1/40 s "exposure".
    _rel.copy(p.velocity).sub(cameraVelocity).multiplyScalar(snow ? 0.012 : 0.025);
    if (_rel.lengthSq() < (snow ? 0.0025 : 0.09)) _rel.setLength(snow ? 0.05 : 0.3);
    const seeds = this.seeds;
    const pos = this.dropPos;
    const v = p.velocity;
    const half = BOX / 2;
    for (let i = 0; i < n; i++) {
      const k = i * 3;
      // Advance each seed with the drop velocity (snow flutters a little) and wrap in the box.
      seeds[k] = (((seeds[k]! + (v.x + (snow ? Math.sin(i + seeds[k + 1]!) * 0.6 : 0)) * dt) % BOX) + BOX) % BOX;
      seeds[k + 1] = (((seeds[k + 1]! + v.y * dt) % BOX) + BOX) % BOX;
      seeds[k + 2] = (((seeds[k + 2]! + v.z * dt) % BOX) + BOX) % BOX;
      // Position relative to the camera: wrap world coordinates into the box centred on it.
      _p.set(
        cam.x + ((((seeds[k]! - cam.x) % BOX) + BOX + half) % BOX) - half,
        cam.y + ((((seeds[k + 1]! - cam.y) % BOX) + BOX + half) % BOX) - half,
        cam.z + ((((seeds[k + 2]! - cam.z) % BOX) + BOX + half) % BOX) - half,
      );
      if (_p.y < 0) _p.y = -_p.y; // no drops under the ground
      const o = i * 6;
      pos[o] = _p.x;
      pos[o + 1] = _p.y;
      pos[o + 2] = _p.z;
      pos[o + 3] = _p.x - _rel.x;
      pos[o + 4] = _p.y - _rel.y;
      pos[o + 5] = _p.z - _rel.z;
    }
    (this.drops.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
  }
}
