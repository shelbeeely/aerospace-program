import * as THREE from 'three';
import { LAYOUT } from '../sim/layout.ts';

const HORIZON = new THREE.Color('#cfe3f2');
const ZENITH = new THREE.Color('#3f7fc4');
const SUN_DIR = new THREE.Vector3(-0.45, 0.8, 0.35).normalize();

/** Deterministic PRNG so scenery is identical every load (and for every racer). */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gridTexture(maxAnisotropy: number): THREE.CanvasTexture {
  const size = 512;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  g.fillStyle = '#6f9a4f';
  g.fillRect(0, 0, size, size);
  // Subtle noise so large areas don't look like flat paint.
  const rnd = mulberry32(7);
  for (let i = 0; i < 4000; i++) {
    g.fillStyle = rnd() < 0.5 ? 'rgba(0,0,0,0.05)' : 'rgba(255,255,255,0.04)';
    g.fillRect(rnd() * size, rnd() * size, 3, 3);
  }
  g.strokeStyle = 'rgba(30,50,20,0.35)';
  g.lineWidth = 2;
  for (let i = 1; i < 5; i++) {
    const p = (i * size) / 5;
    g.beginPath(); g.moveTo(p, 0); g.lineTo(p, size); g.stroke();
    g.beginPath(); g.moveTo(0, p); g.lineTo(size, p); g.stroke();
  }
  g.strokeStyle = 'rgba(25,40,15,0.6)';
  g.lineWidth = 6;
  g.strokeRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = maxAnisotropy;
  return tex;
}

function runwayTexture(maxAnisotropy: number): THREE.CanvasTexture {
  const { length, width } = LAYOUT.runway;
  const w = 256;
  const h = 4096;
  const sx = w / width; // px per metre across
  const sz = h / length; // px per metre along
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  g.fillStyle = '#3b3d40';
  g.fillRect(0, 0, w, h);
  const rnd = mulberry32(3);
  for (let i = 0; i < 20000; i++) {
    g.fillStyle = rnd() < 0.5 ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.05)';
    g.fillRect(rnd() * w, rnd() * h, 2, 2);
  }
  g.fillStyle = '#f2f2ee';
  // Edge lines
  g.fillRect(0.5 * sx, 0, 0.9 * sx, h);
  g.fillRect(w - 1.4 * sx, 0, 0.9 * sx, h);
  // Centre line dashes: 30 m dash, 20 m gap, kept clear of the ends
  for (let z = 70; z < length - 70; z += 50) g.fillRect(w / 2 - 0.45 * sx, z * sz, 0.9 * sx, 30 * sz);
  // Threshold "piano keys" and aiming points at both ends
  for (const end of [0, 1]) {
    const z0 = end === 0 ? 6 : length - 6 - 30;
    for (let i = 0; i < 6; i++) {
      const x = 2.5 + i * 1.8;
      g.fillRect(x * sx, z0 * sz, 1.2 * sx, 30 * sz);
      g.fillRect(w - (x + 1.2) * sx, z0 * sz, 1.2 * sx, 30 * sz);
    }
    const za = end === 0 ? 300 : length - 300 - 45;
    g.fillRect(w / 2 - 9 * sx, za * sz, 4 * sx, 45 * sz);
    g.fillRect(w / 2 + 5 * sx, za * sz, 4 * sx, 45 * sz);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = maxAnisotropy;
  return tex;
}

/** Static scenery: ground, runway, sky, sun + shadows, some objects for scale and speed cues. */
export class WorldView {
  readonly sun: THREE.DirectionalLight;
  private readonly sky: THREE.Mesh;

  constructor(scene: THREE.Scene, renderer: THREE.WebGLRenderer) {
    const aniso = renderer.capabilities.getMaxAnisotropy();
    scene.background = HORIZON.clone();
    scene.fog = new THREE.Fog(HORIZON.clone(), 1200, 9000);

    // Sky dome with a vertical gradient (follows the camera).
    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: { horizon: { value: HORIZON }, zenith: { value: ZENITH } },
      vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `uniform vec3 horizon; uniform vec3 zenith; varying vec3 vDir;
        void main(){ float t = clamp(vDir.y * 1.6, 0.0, 1.0); gl_FragColor = vec4(mix(horizon, zenith, pow(t, 0.7)), 1.0);
        #include <colorspace_fragment>
        }`,
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(9500, 32, 16), skyMat);
    this.sky.renderOrder = -1;
    this.sky.frustumCulled = false;
    scene.add(this.sky);

    scene.add(new THREE.HemisphereLight('#dceeff', '#55663f', 1.1));
    this.sun = new THREE.DirectionalLight('#fff4e0', 2.2);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const s = this.sun.shadow.camera;
    s.left = s.bottom = -40;
    s.right = s.top = 40;
    s.near = 1;
    s.far = 600;
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.03;
    scene.add(this.sun, this.sun.target);

    // Ground
    const groundTex = gridTexture(aniso);
    const tile = 50; // metres per texture repeat (minor lines every 10 m)
    groundTex.repeat.set(LAYOUT.groundSize / tile, LAYOUT.groundSize / tile);
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(LAYOUT.groundSize, LAYOUT.groundSize),
      // Pushed back slightly in depth so the runway decal never z-fights with it at distance.
      new THREE.MeshStandardMaterial({
        map: groundTex,
        roughness: 1,
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 4,
      }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);

    // Runway (visual only; physically the ground is flat everywhere)
    const { length, width, centerZ } = LAYOUT.runway;
    const runway = new THREE.Mesh(
      new THREE.PlaneGeometry(width, length),
      new THREE.MeshStandardMaterial({
        map: runwayTexture(aniso),
        roughness: 0.9,
      }),
    );
    runway.rotation.x = -Math.PI / 2;
    runway.position.set(0, 0.03, centerZ);
    runway.receiveShadow = true;
    scene.add(runway);

    this.addScenery(scene);
  }

  private addScenery(scene: THREE.Scene): void {
    const rnd = mulberry32(42);
    const { width, centerZ, length } = LAYOUT.runway;

    // Hangars next to the runway for scale.
    const hangarMat = new THREE.MeshStandardMaterial({ color: '#9aa3ab', roughness: 0.8 });
    for (let i = 0; i < 4; i++) {
      const h = new THREE.Mesh(new THREE.BoxGeometry(24, 9, 20), hangarMat);
      h.position.set(-width / 2 - 70, 4.5, LAYOUT.spawnZ - 60 - i * 34);
      h.castShadow = h.receiveShadow = true;
      scene.add(h);
    }
    // Windsock pole + tower
    const tower = new THREE.Mesh(
      new THREE.CylinderGeometry(2.5, 3, 18, 8),
      new THREE.MeshStandardMaterial({ color: '#d9d4c7' }),
    );
    tower.position.set(-width / 2 - 60, 9, LAYOUT.spawnZ - 220);
    tower.castShadow = true;
    scene.add(tower);

    // Instanced trees, kept away from the runway strip.
    const count = 1500;
    const trunkGeo = new THREE.ConeGeometry(2.2, 9, 6);
    trunkGeo.translate(0, 4.5, 0);
    const trees = new THREE.InstancedMesh(
      trunkGeo,
      new THREE.MeshStandardMaterial({ color: '#2f5a2a', flatShading: true }),
      count,
    );
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const sc = new THREE.Vector3();
    const p = new THREE.Vector3();
    let n = 0;
    while (n < count) {
      // Clustered: pick a cluster centre, scatter around it.
      const cx = (rnd() - 0.5) * 6000;
      const cz = (rnd() - 0.5) * 6000;
      const clusterSize = 5 + Math.floor(rnd() * 25);
      for (let k = 0; k < clusterSize && n < count; k++) {
        p.set(cx + (rnd() - 0.5) * 120, 0, cz + (rnd() - 0.5) * 120);
        const nearRunway = Math.abs(p.x) < 150 && Math.abs(p.z - centerZ) < length / 2 + 400;
        if (nearRunway) continue;
        const s = 0.6 + rnd() * 0.9;
        sc.set(s, s * (0.8 + rnd() * 0.6), s);
        m.compose(p, q, sc);
        trees.setMatrixAt(n++, m);
      }
    }
    trees.castShadow = false;
    trees.receiveShadow = false;
    scene.add(trees);
  }

  /** Keep the sky centred on the camera and the shadow frustum around the focus point. */
  update(camera: THREE.Camera, focus: THREE.Vector3): void {
    this.sky.position.copy(camera.position);
    this.sun.target.position.copy(focus);
    this.sun.position.copy(focus).addScaledVector(SUN_DIR, 300);
  }
}
