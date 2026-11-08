import * as THREE from 'three/webgpu';
import {
  abs, color, float, fract, min, mix, mx_fractal_noise_float, mx_noise_float, positionWorld, sin, smoothstep, vec2,
} from 'three/tsl';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

const W = 46; // hangar width (x)
const H = 15; // height
const D = 42; // depth (z); the door is the whole -Z end
const DOOR_W = 34;
const DOOR_H = 11.5;

/**
 * The hangar: where craft are designed, inspected and picked. A separate scene from the flight
 * world, lit like a real hangar: a sunlit apron through the open door, rows of overhead light
 * strips, polished concrete that reflects them, corrugated steel walls. Image-based lighting
 * comes from a probe of the hangar itself, so reflections on the craft show the real room.
 */
export class HangarView {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  /** Height of the turntable's top surface (m): craft rest on it. */
  readonly turntableTop = 0.1;
  private readonly sun: THREE.DirectionalLight;
  private readonly turntable = new THREE.Group();
  private idle = 0;
  private envReady = false;

  constructor(
    private readonly renderer: THREE.WebGPURenderer,
    dom: HTMLElement,
  ) {
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 400);
    this.camera.position.set(-11, 3.6, -12);
    this.controls = new OrbitControls(this.camera, dom);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.minDistance = 3;
    this.controls.maxDistance = 30;
    this.controls.target.set(0, 1.4, 0);
    this.controls.autoRotateSpeed = 0.5;
    this.controls.addEventListener('start', () => {
      this.idle = 0;
      this.controls.autoRotate = false;
    });
    this.controls.enabled = false;

    const s = this.scene;
    s.background = new THREE.Color('#0d0f12');

    // --- Polished concrete floor: large-scale tone variation, fine aggregate, saw-cut joints
    //     every 6 m, glossy where it's worn smooth.
    const p = positionWorld.xz;
    const macro = mx_fractal_noise_float(p.mul(0.12), 4, 2, 0.5).mul(0.5).add(0.5);
    const fine = mx_noise_float(p.mul(6)).mul(0.5).add(0.5);
    const g = fract(p.div(6));
    const edge = min(min(g.x, float(1).sub(g.x)), min(g.y, float(1).sub(g.y)));
    const joint = smoothstep(0.0, 0.004, edge);
    const floorMat = new THREE.MeshStandardNodeMaterial();
    floorMat.colorNode = mix(color('#5d5c58'), color('#8b8a85'), macro).mul(mix(0.88, 1.06, fine)).mul(mix(0.45, 1, joint));
    floorMat.roughnessNode = mix(0.12, 0.5, mx_fractal_noise_float(p.mul(0.35), 3, 2, 0.5).mul(0.5).add(0.5)).add(float(1).sub(joint).mul(0.4));
    floorMat.metalnessNode = float(0);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, D).rotateX(-Math.PI / 2), floorMat);
    floor.receiveShadow = true;
    s.add(floor);

    // Painted safety lines: a ring around the turntable and a taxi line out of the door.
    const paint = new THREE.MeshStandardMaterial({ color: '#d9a51c', roughness: 0.6 });
    const ring = new THREE.Mesh(new THREE.RingGeometry(9.2, 9.45, 96).rotateX(-Math.PI / 2), paint);
    ring.position.y = 0.004;
    ring.receiveShadow = true;
    s.add(ring);
    const taxi = new THREE.Mesh(new THREE.PlaneGeometry(0.25, D / 2 - 9.5).rotateX(-Math.PI / 2), paint);
    taxi.position.set(0, 0.004, -(9.45 + (D / 2 - 9.5) / 2));
    taxi.receiveShadow = true;
    s.add(taxi);

    // --- Corrugated steel walls and roof.
    const wallMat = new THREE.MeshStandardNodeMaterial({ metalness: 0.65, roughness: 0.42 });
    const corr = sin(positionWorld.x.add(positionWorld.z).mul(14)).mul(0.5).add(0.5);
    const grime = mx_fractal_noise_float(positionWorld.mul(0.3), 3, 2, 0.5).mul(0.5).add(0.5);
    wallMat.colorNode = mix(color('#59626b'), color('#7b858e'), corr).mul(mix(0.7, 1, grime)).mul(mix(0.6, 1, smoothstep(0, 2.5, positionWorld.y)));
    const wall = (w: number, h: number, x: number, y: number, z: number, ry: number) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), wallMat);
      m.position.set(x, y, z);
      m.rotation.y = ry;
      m.receiveShadow = true;
      s.add(m);
    };
    wall(D, H, -W / 2, H / 2, 0, Math.PI / 2);
    wall(D, H, W / 2, H / 2, 0, -Math.PI / 2);
    wall(W, H, 0, H / 2, D / 2, Math.PI);
    // Front wall around the door opening.
    const side = (W - DOOR_W) / 2;
    wall(side, H, -W / 2 + side / 2, H / 2, -D / 2, 0);
    wall(side, H, W / 2 - side / 2, H / 2, -D / 2, 0);
    wall(DOOR_W, H - DOOR_H, 0, DOOR_H + (H - DOOR_H) / 2, -D / 2, 0);
    for (const m of s.children.slice(-3)) m.rotation.y = 0;
    const roofMat = new THREE.MeshStandardMaterial({ color: '#2a2e33', roughness: 0.8, metalness: 0.4 });
    const roof = new THREE.Mesh(new THREE.PlaneGeometry(W, D).rotateX(Math.PI / 2), roofMat);
    roof.position.y = H;
    s.add(roof);

    // Roof trusses (steel I-beams) every 6 m.
    const steel = new THREE.MeshStandardMaterial({ color: '#3b4148', roughness: 0.5, metalness: 0.8 });
    for (let z = -D / 2 + 3; z < D / 2; z += 6) {
      const beam = new THREE.Mesh(new THREE.BoxGeometry(W, 0.7, 0.3), steel);
      beam.position.set(0, H - 0.6, z);
      beam.castShadow = true;
      s.add(beam);
    }
    // Light strips: HDR emissive (they bloom) between the trusses.
    const lamp = new THREE.MeshBasicNodeMaterial();
    lamp.colorNode = color('#fff6e8').mul(9);
    for (let x = -15; x <= 15; x += 7.5) {
      const strip = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.08, D - 6), lamp);
      strip.position.set(x, H - 1.05, 0);
      s.add(strip);
    }

    // --- Outside: sunlit apron and a bright, slightly hazy sky seen through the door.
    const apronMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.9 });
    apronMat.colorNode = mix(color('#77746d'), color('#8e8b83'), mx_fractal_noise_float(p.mul(0.08), 3, 2, 0.5).mul(0.5).add(0.5));
    const apron = new THREE.Mesh(new THREE.PlaneGeometry(260, 160).rotateX(-Math.PI / 2), apronMat);
    apron.position.set(0, -0.01, -D / 2 - 80);
    apron.receiveShadow = true;
    s.add(apron);
    const skyMat = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide, fog: false });
    const t = smoothstep(-2, 60, positionWorld.y);
    skyMat.colorNode = mix(color('#e9eef2'), color('#7ea6cf'), t).mul(2.4);
    const sky = new THREE.Mesh(new THREE.CylinderGeometry(170, 170, 140, 48, 1, true, Math.PI * 0.5, Math.PI), skyMat);
    sky.position.set(0, 60, -D / 2);
    s.add(sky);
    // Distant tree line on the horizon.
    const trees = new THREE.MeshStandardMaterial({ color: '#2f4a2c', roughness: 1 });
    for (let i = 0; i < 60; i++) {
      const a = Math.PI * (0.55 + (i / 60) * 0.9);
      const r = 150 + (i % 3) * 6;
      const h = 6 + ((i * 37) % 7);
      const cone = new THREE.Mesh(new THREE.ConeGeometry(3 + (i % 4), h, 7), trees);
      cone.position.set(Math.cos(a) * r, h / 2, -D / 2 + Math.sin(a) * -r);
      s.add(cone);
    }

    // --- Lights. Sun through the door (shadowed), soft sky fill, a warm overhead fill.
    this.sun = new THREE.DirectionalLight('#fff1dc', 3.2);
    this.sun.position.set(-30, 26, -60);
    this.sun.target.position.set(0, 0, 4);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = sc.bottom = -24;
    sc.right = sc.top = 24;
    sc.near = 10;
    sc.far = 160;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.02;
    this.sun.shadow.radius = 3;
    s.add(this.sun, this.sun.target);
    s.add(new THREE.HemisphereLight('#dfe8f2', '#3a3833', 0.35));
    const over = new THREE.SpotLight('#fff3e2', 900, 40, Math.PI * 0.32, 0.8, 2);
    over.position.set(0, H - 1.2, 2);
    over.target.position.set(0, 0, 0);
    over.castShadow = true;
    over.shadow.mapSize.set(1024, 1024);
    over.shadow.radius = 6;
    over.shadow.bias = -0.0005;
    s.add(over, over.target);

    // --- Turntable: brushed steel disc with a lit edge.
    const disc = new THREE.Mesh(
      new THREE.CylinderGeometry(7, 7, 0.1, 96),
      new THREE.MeshStandardMaterial({ color: '#4a4f55', roughness: 0.28, metalness: 0.9 }),
    );
    disc.position.y = 0.05;
    disc.receiveShadow = true;
    this.turntable.add(disc);
    const rimMat = new THREE.MeshBasicNodeMaterial();
    rimMat.colorNode = color('#bfe6ff').mul(3);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(7, 0.03, 8, 128).rotateX(Math.PI / 2), rimMat);
    rim.position.y = 0.1;
    this.turntable.add(rim);
    s.add(this.turntable);

    // Props for scale: tool chests and oil drums along the walls.
    const chest = new THREE.MeshStandardMaterial({ color: '#a8261f', roughness: 0.35, metalness: 0.3 });
    const drum = new THREE.MeshStandardMaterial({ color: '#2c5d8a', roughness: 0.4, metalness: 0.5 });
    for (const [x, z] of [[-W / 2 + 1.2, 6], [-W / 2 + 1.2, 9], [W / 2 - 1.2, -4]] as const) {
      const c = new THREE.Mesh(new THREE.BoxGeometry(0.7, 1.1, 1.6), chest);
      c.position.set(x, 0.55, z);
      c.castShadow = c.receiveShadow = true;
      s.add(c);
    }
    for (let i = 0; i < 5; i++) {
      const d = new THREE.Mesh(new THREE.CylinderGeometry(0.29, 0.29, 0.88, 24), drum);
      d.position.set(W / 2 - 1 - (i % 2) * 0.62, 0.44, 12 + Math.floor(i / 2) * 0.62);
      d.castShadow = d.receiveShadow = true;
      s.add(d);
    }
    void vec2;
    void abs;
  }

  /** Bake the image-based lighting from the hangar itself (call once the renderer is up). */
  bakeEnvironment(): void {
    if (this.envReady) return;
    this.envReady = true;
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const rt = pmrem.fromScene(this.scene, 0, 0.1, 300, { size: 256, position: new THREE.Vector3(0, 3, 0) });
    this.scene.environment = rt.texture;
    this.scene.environmentIntensity = 0.9;
    pmrem.dispose();
  }

  setActive(on: boolean): void {
    this.controls.enabled = on;
    this.controls.autoRotate = false;
    this.idle = 0;
  }

  /** Frame a craft of this bounding radius sitting on the turntable. */
  fit(radius: number, centerHeight: number): void {
    const r = Math.max(1, radius);
    this.controls.target.set(0, Math.max(0.6, centerHeight), 0);
    this.controls.minDistance = r * 1.1;
    this.controls.maxDistance = Math.min(19, r * 6);
    const dir = new THREE.Vector3(-0.62, 0.22, -0.75).normalize();
    this.camera.position.copy(this.controls.target).addScaledVector(dir, Math.min(18, r * 2.6 + 2));
    this.controls.update();
  }

  resize(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  update(dt: number): void {
    // Slow showroom spin after 8 s without input.
    this.idle += dt;
    if (this.idle > 8) this.controls.autoRotate = true;
    this.controls.update(dt);
  }
}
