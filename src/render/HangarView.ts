import * as THREE from 'three/webgpu';
import { color, float, positionWorld, smoothstep, uniform, vec2 } from 'three/tsl';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { NEON, glow, gridLines, groundGridNode, neonFillMaterial, neonize, synthSkyNode, type TslNode } from './neon.ts';

const W = 46; // hangar width (x)
const H = 15; // height
const D = 42; // depth (z); the door is the whole -Z end
const DOOR_W = 34;
const DOOR_H = 11.5;

/**
 * The hangar: where craft are designed, inspected and picked. A separate scene from the flight
 * world, in the neon / synthwave style: a dark room drawn in glowing lines (grid floor, gridded
 * walls, outlined trusses), light strips overhead, a neon turntable, and the synthwave sky with
 * its striped sun through the open door. Image-based lighting is a probe of the hangar itself,
 * so the craft's dark metallic fills reflect the neon.
 */
export class HangarView {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  /** Height of the turntable's top surface (m): craft rest on it. */
  readonly turntableTop = 0.1;
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
    s.background = new THREE.Color('#05020c');
    const fill = neonFillMaterial();
    const glowMat = (c: string, k: number) => {
      const m = new THREE.MeshBasicNodeMaterial();
      m.colorNode = color(c).mul(k);
      return m;
    };

    // --- Floor: dark with a cyan grid (1 m minor, 6 m major), fading toward the walls.
    const floorMat = new THREE.MeshBasicNodeMaterial();
    floorMat.colorNode = groundGridNode(color('#06030f'), color(NEON.cyan).mul(1.8), { minor: 1, major: 6, fade: 70 });
    s.add(new THREE.Mesh(new THREE.PlaneGeometry(W, D).rotateX(-Math.PI / 2), floorMat));

    // Magenta safety ring around the turntable and a taxi line out of the door.
    const paint = glowMat(NEON.magenta, 3);
    const ring = new THREE.Mesh(new THREE.RingGeometry(9.2, 9.35, 128).rotateX(-Math.PI / 2), paint);
    ring.position.y = 0.004;
    s.add(ring);
    const taxi = new THREE.Mesh(new THREE.PlaneGeometry(0.15, D / 2 - 9.35).rotateX(-Math.PI / 2), paint);
    taxi.position.set(0, 0.004, -(9.35 + (D / 2 - 9.35) / 2));
    s.add(taxi);

    // --- Walls: near-black with a faint violet grid and two glowing bands (pink low, cyan high).
    const wallMat = new THREE.MeshBasicNodeMaterial();
    const wc: TslNode = vec2(positionWorld.x.add(positionWorld.z), positionWorld.y);
    const wy: TslNode = positionWorld.y;
    const bandAt = (y: number, half: number): TslNode => float(1).sub(smoothstep(half, half + 0.04, wy.sub(y).abs()));
    const wallBase: TslNode = color('#07040f');
    wallMat.colorNode = wallBase
      .add(color(NEON.violet).mul(gridLines(wc, 3, 1).mul(0.9)))
      .add(color(NEON.pink).mul(2.6).mul(bandAt(1.2, 0.05)))
      .add(color(NEON.cyan).mul(2.2).mul(bandAt(H - 2.2, 0.04)));
    const wall = (w: number, h: number, x: number, y: number, z: number, ry: number) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), wallMat);
      m.position.set(x, y, z);
      m.rotation.y = ry;
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
    const roof = new THREE.Mesh(new THREE.PlaneGeometry(W, D).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ color: '#030108' }));
    roof.position.y = H;
    s.add(roof);
    // Glowing outline of the room's corners, and the door frame in magenta.
    const shell = neonize(new THREE.BoxGeometry(W - 0.05, H - 0.05, D - 0.05), NEON.cyan, { intensity: 2.6 });
    shell.position.y = H / 2;
    s.add(shell);
    const doorFrame = new THREE.LineSegments(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-DOOR_W / 2, 0, 0), new THREE.Vector3(-DOOR_W / 2, DOOR_H, 0),
        new THREE.Vector3(-DOOR_W / 2, DOOR_H, 0), new THREE.Vector3(DOOR_W / 2, DOOR_H, 0),
        new THREE.Vector3(DOOR_W / 2, DOOR_H, 0), new THREE.Vector3(DOOR_W / 2, 0, 0),
      ]),
      new THREE.LineBasicMaterial({ color: glow(NEON.magenta, 3.5) }),
    );
    doorFrame.position.z = -D / 2 + 0.02;
    s.add(doorFrame);

    // Roof trusses every 6 m: dark beams with magenta edges.
    const beamGeo = new THREE.BoxGeometry(W, 0.7, 0.3);
    for (let z = -D / 2 + 3; z < D / 2; z += 6) {
      const beam = new THREE.Mesh(beamGeo, fill);
      beam.add(neonize(beamGeo, NEON.magenta, { intensity: 2.4 }));
      beam.position.set(0, H - 0.6, z);
      s.add(beam);
    }
    // Light strips: HDR emissive (they bloom) between the trusses.
    const lamp = glowMat(NEON.cyan, 5);
    for (let x = -15; x <= 15; x += 7.5) {
      const strip = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.06, D - 6), lamp);
      strip.position.set(x, H - 1.05, 0);
      s.add(strip);
    }

    // --- Outside: grid apron, wireframe tree line, the synthwave sky and sun through the door.
    const apronMat = new THREE.MeshBasicNodeMaterial();
    apronMat.colorNode = groundGridNode(color('#05020c'), color(NEON.cyan).mul(2), { minor: 5, major: 25, fade: 180 });
    const apron = new THREE.Mesh(new THREE.PlaneGeometry(320, 200).rotateX(-Math.PI / 2), apronMat);
    apron.position.set(0, -0.01, -D / 2 - 100);
    s.add(apron);
    const skyMat = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false, fog: false });
    skyMat.colorNode = synthSkyNode(uniform(new THREE.Color(NEON.horizon)), uniform(new THREE.Color(NEON.zenith)), {
      sunDir: new THREE.Vector3(0, 0.09, -1),
      sunRadius: 0.22,
    });
    const sky = new THREE.Mesh(new THREE.SphereGeometry(200, 48, 24), skyMat);
    sky.position.set(0, 0, -D / 2);
    sky.renderOrder = -1;
    s.add(sky);
    const coneGeo = new THREE.ConeGeometry(3, 8, 6);
    for (let i = 0; i < 40; i++) {
      const a = Math.PI * (0.55 + (i / 40) * 0.9);
      const r = 120 + (i % 3) * 8;
      const k = 0.8 + ((i * 37) % 7) / 8;
      const cone = new THREE.Mesh(coneGeo, fill);
      cone.add(neonize(coneGeo, NEON.purple, { intensity: 2 }));
      cone.scale.setScalar(k);
      cone.position.set(Math.cos(a) * r, 4 * k, -D / 2 + Math.sin(a) * -r);
      s.add(cone);
    }

    // --- Lights: dim coloured fill so the craft's dark fills still show their shape.
    s.add(new THREE.HemisphereLight('#7a4cff', '#ff2bd6', 0.6));
    const key = new THREE.DirectionalLight('#ff9be8', 1.2);
    key.position.set(-30, 26, -60);
    s.add(key);
    const over = new THREE.SpotLight('#9fe8ff', 500, 40, Math.PI * 0.32, 0.8, 2);
    over.position.set(0, H - 1.2, 2);
    over.target.position.set(0, 0, 0);
    s.add(over, over.target);

    // --- Turntable: dark glossy disc, cyan rim, magenta inner ring.
    const discGeo = new THREE.CylinderGeometry(7, 7, 0.1, 96);
    const disc = new THREE.Mesh(discGeo, neonFillMaterial('#0a0814', { roughness: 0.25, metalness: 0.9, flatShading: false }));
    disc.position.y = 0.05;
    disc.add(neonize(discGeo, NEON.cyan, { thresholdAngle: 30, intensity: 2.5 }));
    this.turntable.add(disc);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(7, 0.03, 8, 128).rotateX(Math.PI / 2), glowMat(NEON.cyan, 4));
    rim.position.y = 0.1;
    this.turntable.add(rim);
    const inner = new THREE.Mesh(new THREE.RingGeometry(3.4, 3.46, 96).rotateX(-Math.PI / 2), glowMat(NEON.magenta, 2.5));
    inner.position.y = 0.102;
    this.turntable.add(inner);
    s.add(this.turntable);

    // Props for scale: tool chests and oil drums along the walls, as wireframes.
    const chestGeo = new THREE.BoxGeometry(0.7, 1.1, 1.6);
    const drumGeo = new THREE.CylinderGeometry(0.29, 0.29, 0.88, 12);
    for (const [x, z] of [[-W / 2 + 1.2, 6], [-W / 2 + 1.2, 9], [W / 2 - 1.2, -4]] as const) {
      const c = new THREE.Mesh(chestGeo, fill);
      c.add(neonize(chestGeo, NEON.magenta));
      c.position.set(x, 0.55, z);
      s.add(c);
    }
    for (let i = 0; i < 5; i++) {
      const d = new THREE.Mesh(drumGeo, fill);
      d.add(neonize(drumGeo, NEON.yellow, { thresholdAngle: 40 }));
      d.position.set(W / 2 - 1 - (i % 2) * 0.62, 0.44, 12 + Math.floor(i / 2) * 0.62);
      s.add(d);
    }
  }

  /** Bake the image-based lighting from the hangar itself (call once the renderer is up). */
  bakeEnvironment(): void {
    if (this.envReady) return;
    this.envReady = true;
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const rt = pmrem.fromScene(this.scene, 0, 0.1, 300, { size: 256, position: new THREE.Vector3(0, 3, 0) });
    this.scene.environment = rt.texture;
    this.scene.environmentIntensity = 1.0;
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
