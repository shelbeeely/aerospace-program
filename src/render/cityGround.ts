import * as THREE from 'three/webgpu';
import { abs, cameraPosition, color, distance, float, floor, fract, fwidth, hash, max, min, mix, smoothstep, step, texture, uniform, vec2 } from 'three/tsl';
import { CITY } from '../sim/layout.ts';
import { blockSummary, GRID } from '../world/planetCity.ts';
import { flatWorld } from './curvature.ts';
import { terrainEdgesNode } from './terrainNode.ts';
import { gridLines, type TslNode } from './neon.ts';

/**
 * The planet's ground between the buildings, drawn by one shader on the ground disc:
 * - streets with glowing lanes, curbs and brighter data highways on the seamless block grid;
 * - from far away (beyond the box LOD) every block glows with city lights sized by its skyline
 *   height and tinted by its palette colour: the last distance LOD, and the view from orbit.
 * Block data comes from blockSummary() (370 × 370 texels, one per block).
 */
let summaryTex: THREE.DataTexture | null = null;
export function summary(): THREE.DataTexture {
  if (summaryTex) return summaryTex;
  const n = GRID.blocks;
  summaryTex = new THREE.DataTexture(blockSummary(), n, n, THREE.RGBAFormat, THREE.UnsignedByteType);
  summaryTex.magFilter = THREE.NearestFilter;
  summaryTex.minFilter = THREE.NearestFilter;
  summaryTex.wrapS = summaryTex.wrapT = THREE.RepeatWrapping;
  summaryTex.needsUpdate = true;
  return summaryTex;
}

let paletteTex: THREE.DataTexture | null = null;
function palette(): THREE.DataTexture {
  if (paletteTex) return paletteTex;
  const data = new Uint8Array(8 * 4);
  CITY.colors.forEach((hex, i) => {
    const c = new THREE.Color(hex);
    data.set([c.r * 255, c.g * 255, c.b * 255, 255], i * 4);
  });
  paletteTex = new THREE.DataTexture(data, 8, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  paletteTex.magFilter = paletteTex.minFilter = THREE.NearestFilter;
  paletteTex.needsUpdate = true;
  return paletteTex;
}

/** Distance (m) beyond which far blocks light up (the box LOD covers nearer ones). */
export const CITY_LIGHTS_FROM = uniform(6000);

/** Street + city-lights colour at the fragment's flat world position (null-safe for sea: caller masks). */
export function cityGroundNode(): TslNode {
  const p = flatWorld;
  const pitch = GRID.pitch;
  const gx0 = GRID.x0, gz0 = GRID.z0;
  const S = CITY.street;
  const lx: TslNode = fract(p.x.sub(gx0).div(pitch)).mul(pitch);
  const lz: TslNode = fract(p.z.sub(gz0).div(pitch)).mul(pitch);
  const n = CITY.highwayEvery;
  const majorX: TslNode = step(fract(floor(p.x.sub(gx0).div(pitch).add(0.5)).div(n)), float(0.5 / n));
  const majorZ: TslNode = step(fract(floor(p.z.sub(gz0).div(pitch).add(0.5)).div(n)), float(0.5 / n));
  const dx: TslNode = min(lx, float(pitch).sub(lx));
  const dz: TslNode = min(lz, float(pitch).sub(lz));
  const onX: TslNode = step(dx, float(S / 2));
  const onZ: TslNode = step(dz, float(S / 2));
  const street: TslNode = max(onX, onZ);
  const centreX: TslNode = step(dx, float(0.22)).mul(float(1).sub(onZ));
  const centreZ: TslNode = step(dz, float(0.22)).mul(float(1).sub(onX));
  const dashZ: TslNode = step(fract(p.z.div(9)), float(0.5));
  const dashX: TslNode = step(fract(p.x.div(9)), float(0.5));
  const laneX: TslNode = step(abs(dx.sub(S / 4)), float(0.12)).mul(dashZ).mul(float(1).sub(onZ));
  const laneZ: TslNode = step(abs(dz.sub(S / 4)), float(0.12)).mul(dashX).mul(float(1).sub(onX));
  const curb: TslNode = max(step(abs(dx.sub(S / 2)), float(0.3)), step(abs(dz.sub(S / 2)), float(0.3))).mul(float(1).sub(street).add(0.5).min(1));

  // Block data: which block is this, what is on it.
  const bi: TslNode = floor(p.x.sub(gx0).div(pitch));
  const bj: TslNode = floor(p.z.sub(gz0).div(pitch));
  const uv: TslNode = vec2(bi.add(0.5).div(GRID.blocks), bj.add(0.5).div(GRID.blocks));
  const block: TslNode = texture(summary(), uv);
  const kind: TslNode = block.b; // 0 city, 0.25 Off-Grid, 0.5 open, 0.75 airfield, 1 sea
  const isCity: TslNode = float(1).sub(step(0.125, kind));
  const offGrid: TslNode = step(0.125, kind).mul(float(1).sub(step(0.375, kind)));
  const noRoads: TslNode = max(step(0.6, kind), offGrid); // airfields, sea and the Off-Grid have no streets

  const pad: TslNode = mix(color('#040820'), color('#0b1a5a'), gridLines(p.xz, 10, 1).mul(0.6));
  const asphalt: TslNode = color('#020311');
  let c: TslNode = mix(pad, asphalt, street);
  c = c.add(color('#ff8a1f').mul(max(centreX.mul(majorX.mul(2).add(1)), centreZ.mul(majorZ.mul(2).add(1))).mul(2.2)));
  c = c.add(color('#00eaff').mul(max(laneX.mul(majorX.mul(1.5).add(1)), laneZ.mul(majorZ.mul(1.5).add(1))).mul(1.4)));
  c = c.add(color('#2a5cff').mul(curb.mul(1.8)));
  c = mix(c, color('#040820'), noRoads);

  // Far LOD: city lights on built blocks, brighter for taller skylines, sparkling per window cell.
  const height: TslNode = block.r; // skyline / 400 m
  const tint: TslNode = texture(palette(), vec2(block.g.mul(255).add(0.5).div(8), 0.5)).rgb;
  const cell: TslNode = hash(floor(p.x.div(9)).mul(7919).add(floor(p.z.div(9)).mul(104729)));
  const sparkle: TslNode = step(0.55, cell).mul(0.6).add(0.4);
  const interior: TslNode = float(1).sub(street);
  const far: TslNode = smoothstep(CITY_LIGHTS_FROM, CITY_LIGHTS_FROM.mul(1.3), distance(p.xz, cameraPosition.xz));
  const lights: TslNode = tint.mul(height.mul(5).add(0.6)).mul(sparkle).mul(interior).mul(isCity).mul(far);

  // The Off-Grid, outside the system: black and deep-blue ground under a faint electric-blue
  // survey grid; its geometric solids are drawn by light in the contrasting palette: amber
  // square contours every 40 m, ridgelines and base outlines glowing orange to red at the apex.
  const h: TslNode = max(p.y, float(0));
  const t: TslNode = fract(h.div(40));
  const contour: TslNode = float(1).sub(smoothstep(0, max(fwidth(h.div(40)).mul(1.5), float(0.02)), min(t, float(1).sub(t)))).mul(smoothstep(2, 10, h));
  const edges: TslNode = terrainEdgesNode(summary(), p.x, p.z);
  const hot: TslNode = mix(color('#ff8a1f'), color('#ff2a1a'), smoothstep(60, 300, h));
  const survey: TslNode = gridLines(p.xz, 50, 1).mul(0.35);
  const waste: TslNode = mix(color('#010208'), color('#06102a'), smoothstep(0, 250, h))
    .add(color('#1f6bff').mul(survey))
    .add(color('#ffb347').mul(contour.mul(0.9)))
    .add(hot.mul(edges.mul(2.6)));
  return mix(c.add(lights), waste, offGrid);
}
