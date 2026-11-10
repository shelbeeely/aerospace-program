import * as THREE from 'three/webgpu';
import { abs, cameraPosition, clamp, color, distance, float, floor, fract, fwidth, hash, max, min, mix, mod, smoothstep, step, texture, time, uniform, vec2, vec3 } from 'three/tsl';
import { OUTLANDS } from '../arch/DigitalTerrainGenerator.ts';
import { CITY_REGIONS, REGION_PROFILES, TERRAIN_ARCHETYPES, TERRAIN_PROFILES } from '../arch/WorldRegionManager.ts';
import { CITY } from '../sim/layout.ts';
import { BLOCK_KIND, blockSummary, GRID, terrainStyleSummary } from '../world/planetCity.ts';
import { flatWorld } from './curvature.ts';
import { gridLines, type TslNode } from './neon.ts';

/**
 * The planet's ground as an electronic substrate (book pp. 12–13, 15, 35): one shader on the
 * ground disc, driven by the per-block summary (370 × 370 texels):
 * - lots: dark region-tinted plates with faint circuit traces and large panel subdivisions;
 *   inside a multi-block lot there is no street at all (structures span it);
 * - streets: recessed channels, near black, lined by thin cyan boundaries (not roads);
 * - lightcycle highways (every 6th line, every 37th through the Outlands): bright cyan edges,
 *   blue lanes, a white centre line and data packets running along them;
 * - open computational plains: vast clean grid planes;
 * - Outlands: per-archetype ground, blended between regions: grid flats, the pale dashed Sea of
 *   Simulation, dark canyon and cavern slate, dusty wastelands with amber survey marks;
 * - far away (and from orbit) all of it fades to filtered averages, with structure footprints
 *   glowing faintly so the planet reads as a lit machine.
 */
let summaryTex: THREE.DataTexture | null = null;
export function summary(): THREE.DataTexture {
  if (summaryTex) return summaryTex;
  const n = GRID.blocks;
  summaryTex = new THREE.DataTexture(blockSummary(), n, n, THREE.RGBAFormat, THREE.UnsignedByteType);
  summaryTex.magFilter = summaryTex.minFilter = THREE.NearestFilter;
  summaryTex.wrapS = summaryTex.wrapT = THREE.RepeatWrapping;
  summaryTex.needsUpdate = true;
  return summaryTex;
}

let styleTex: THREE.DataTexture | null = null;
function styles(): THREE.DataTexture {
  if (styleTex) return styleTex;
  const n = GRID.blocks;
  styleTex = new THREE.DataTexture(terrainStyleSummary(), n, n, THREE.RGBAFormat, THREE.UnsignedByteType);
  styleTex.magFilter = THREE.LinearFilter;
  styleTex.minFilter = THREE.LinearMipmapLinearFilter;
  styleTex.generateMipmaps = true;
  styleTex.wrapS = styleTex.wrapT = THREE.RepeatWrapping;
  styleTex.needsUpdate = true;
  return styleTex;
}

let tintTex: THREE.DataTexture | null = null;
/** Ground tints: row 0 civilised regions, row 1 terrain archetypes. */
function tints(): THREE.DataTexture {
  if (tintTex) return tintTex;
  const data = new Uint8Array(16 * 2 * 4);
  const c = new THREE.Color();
  CITY_REGIONS.forEach((r, i) => { c.set(REGION_PROFILES[r].atmosphere.ground); data.set([c.r * 255, c.g * 255, c.b * 255, 255], i * 4); });
  TERRAIN_ARCHETYPES.forEach((t, i) => { c.set(TERRAIN_PROFILES[t].atmosphere.ground); data.set([c.r * 255, c.g * 255, c.b * 255, 255], (16 + i) * 4); });
  tintTex = new THREE.DataTexture(data, 16, 2, THREE.RGBAFormat, THREE.UnsignedByteType);
  tintTex.magFilter = tintTex.minFilter = THREE.NearestFilter;
  tintTex.needsUpdate = true;
  return tintTex;
}

let glowTex: THREE.DataTexture | null = null;
/** Far LOD: per-block average colour (structures' faint glow, plains, Outlands tints), mipmapped. */
function glowTexture(): THREE.DataTexture {
  if (glowTex) return glowTex;
  const n = GRID.blocks;
  const src = blockSummary();
  const out = new Uint8Array(n * n * 4);
  const c = new THREE.Color(), t = new THREE.Color();
  for (let i = 0; i < n * n; i++) {
    const o = i * 4;
    const kind = src[o + 2];
    const region = src[o + 1] & 15;
    if (kind === BLOCK_KIND.lot) {
      c.set(REGION_PROFILES[CITY_REGIONS[region] ?? 'plains'].atmosphere.ground).multiplyScalar(1.4);
      t.set('#36e2ff').multiplyScalar(0.05 + 0.25 * (src[o] / 255));
      c.add(t);
    } else if (kind === BLOCK_KIND.plain) c.set('#0b2052').multiplyScalar(1.3);
    else if (kind === BLOCK_KIND.outlands) c.set(TERRAIN_PROFILES[TERRAIN_ARCHETYPES[region] ?? 'grid-plains'].atmosphere.ground);
    else if (kind === BLOCK_KIND.sea) c.set('#020919');
    else c.set('#06102a');
    out[o] = Math.min(255, c.r * 255); out[o + 1] = Math.min(255, c.g * 255); out[o + 2] = Math.min(255, c.b * 255); out[o + 3] = 255;
  }
  glowTex = new THREE.DataTexture(out, n, n, THREE.RGBAFormat, THREE.UnsignedByteType);
  glowTex.magFilter = THREE.LinearFilter;
  glowTex.minFilter = THREE.LinearMipmapLinearFilter;
  glowTex.generateMipmaps = true;
  glowTex.wrapS = glowTex.wrapT = THREE.RepeatWrapping;
  glowTex.needsUpdate = true;
  return glowTex;
}

/** Recompute the summary textures in place (a new world seed: shaders keep their textures). */
export function refreshGroundTextures(): void {
  const swap = (t: THREE.DataTexture | null, make: () => THREE.DataTexture) => {
    if (!t) return;
    const fresh = make();
    (t.image.data as Uint8Array).set(fresh.image.data as Uint8Array);
    t.needsUpdate = true;
    fresh.dispose();
  };
  const s = summaryTex, st = styleTex, g = glowTex;
  summaryTex = styleTex = glowTex = null;
  swap(s, summary);
  swap(st, styles);
  swap(g, glowTexture);
  summaryTex = s ?? summaryTex;
  styleTex = st ?? styleTex;
  glowTex = g ?? glowTex;
}

/** Distance (m) beyond which the far average takes over completely (kept for the orbit view). */
export const CITY_LIGHTS_FROM = uniform(6000);
/** Above this camera altitude (m) the planet is seen whole (the globe view). */
export const GLOBE_VIEW_ALT = 8000;
export const GLOBE_VIEW = { on: false };
/** Overall gain of the far glow (WorldView raises it a little from orbit). */
export const CITY_LIGHTS_GAIN = uniform(1);

const col = (h: string): TslNode => color(h);

/** Band mask (0..1) |v - at| < half, anti-aliased in the units of v. */
function band(v: TslNode, at: number | TslNode, half: number): TslNode {
  const d: TslNode = abs(v.sub(at)).sub(half);
  return float(1).sub(smoothstep(float(0), max(fwidth(v), 1e-4), d));
}

/** The ground colour at the fragment's flat world position. */
export function cityGroundNode(): TslNode {
  const p = flatWorld;
  const pitch = GRID.pitch, S = CITY.street;
  const gx0 = GRID.x0, gz0 = GRID.z0, N = GRID.blocks;
  const fx: TslNode = p.x.sub(gx0).div(pitch), fz: TslNode = p.z.sub(gz0).div(pitch);
  const lx: TslNode = fract(fx).mul(pitch), lz: TslNode = fract(fz).mul(pitch);
  const dx: TslNode = min(lx, float(pitch).sub(lx)), dz: TslNode = min(lz, float(pitch).sub(lz));
  const bi: TslNode = floor(fx), bj: TslNode = floor(fz);
  const at = (i: TslNode, j: TslNode): TslNode => texture(summary(), vec2(i.add(0.5).div(N), j.add(0.5).div(N)));
  const block: TslNode = at(bi, bj);
  const kind: TslNode = block.b;
  const g255: TslNode = floor(block.g.mul(255).add(0.5));
  const region: TslNode = mod(g255, 16);
  const is = (k: number): TslNode => step(abs(kind.sub(k / 255)), 0.03);
  const isLot: TslNode = is(BLOCK_KIND.lot), isPlain: TslNode = is(BLOCK_KIND.plain), isOut: TslNode = is(BLOCK_KIND.outlands);
  const isOpen: TslNode = is(BLOCK_KIND.open), isAir: TslNode = is(BLOCK_KIND.airfield);
  // Streets: absent where one lot covers both sides (bit 64: lot continues +x, bit 128: +z).
  const westI: TslNode = bi.sub(step(lx, pitch / 2));
  const southJ: TslNode = bj.sub(step(lz, pitch / 2));
  const wg: TslNode = floor(at(westI, bj).g.mul(255).add(0.5));
  const sg: TslNode = floor(at(bi, southJ).g.mul(255).add(0.5));
  const joinedX: TslNode = step(64, mod(wg, 128));
  const joinedZ: TslNode = step(128, sg);
  const kx: TslNode = floor(fx.add(0.5)), kz: TslNode = floor(fz.add(0.5));
  const hwX: TslNode = step(mod(kx, CITY.highwayEvery), 0.5), hwZ: TslNode = step(mod(kz, CITY.highwayEvery), 0.5);
  const HW = pitch * OUTLANDS.highwayEvery;
  const tx: TslNode = mod(p.x.sub(gx0), HW), tz: TslNode = mod(p.z.sub(gz0), HW);
  const ohX: TslNode = step(min(tx, float(HW).sub(tx)), S / 2).mul(isOut), ohZ: TslNode = step(min(tz, float(HW).sub(tz)), S / 2).mul(isOut);
  const roads: TslNode = max(max(isLot, isOpen), isPlain.mul(0)); // plains: highways only
  const onX: TslNode = step(dx, S / 2).mul(float(1).sub(joinedX)), onZ: TslNode = step(dz, S / 2).mul(float(1).sub(joinedZ));
  // Connector roads (sim/roadRules.ts): bit 32 = a road on the block's -x edge, 16 = its -z edge.
  const eg: TslNode = floor(at(westI.add(1), bj).g.mul(255).add(0.5));
  const ng: TslNode = floor(at(bi, southJ.add(1)).g.mul(255).add(0.5));
  const extraX: TslNode = step(32, mod(eg, 64)), extraZ: TslNode = step(16, mod(ng, 32));
  const streetX: TslNode = onX.mul(max(max(roads, max(isPlain, isOpen).mul(hwX)), extraX));
  const streetZ: TslNode = onZ.mul(max(max(roads, max(isPlain, isOpen).mul(hwZ)), extraZ));
  const hwyX: TslNode = max(streetX.mul(hwX), ohX), hwyZ: TslNode = max(streetZ.mul(hwZ), ohZ);
  const street: TslNode = max(max(streetX, streetZ), max(ohX, ohZ));

  // --- Substrate (lots): region-tinted plate, panel subdivisions, faint circuit traces.
  const tint: TslNode = texture(tints(), vec2(region.add(0.5).div(16), 0.25)).rgb;
  const bh: TslNode = hash(bi.mul(7919).add(bj.mul(104729)));
  let plate: TslNode = tint.mul(float(0.75).add(bh.mul(0.3)));
  const sub: TslNode = gridLines(vec2(lx, lz), pitch / 4, 1);
  plate = plate.mul(float(1).sub(sub.mul(0.35)));
  const cellC: TslNode = floor(p.xz.div(6));
  const hc: TslNode = hash(cellC.x.mul(127.1).add(cellC.y.mul(311.7)));
  const fc: TslNode = fract(p.xz.div(6));
  const trace: TslNode = max(band(fc.y, 0.5, 0.04).mul(step(hc, 0.3)), band(fc.x, 0.5, 0.04).mul(step(0.3, hc).mul(step(hc, 0.55))));
  const traceFade: TslNode = float(1).sub(smoothstep(0.08, 0.3, fwidth(p.x).div(6)));
  plate = plate.add(col('#2f74ff').mul(trace.mul(traceFade).mul(0.12)));
  // Lot boundary: a thin cyan line where the plate meets a channel.
  const curbX: TslNode = band(dx, S / 2 + 0.4, 0.22).mul(float(1).sub(joinedX)), curbZ: TslNode = band(dz, S / 2 + 0.4, 0.22).mul(float(1).sub(joinedZ));
  plate = plate.add(col('#36e2ff').mul(max(curbX, curbZ).mul(roads).mul(0.3)));

  // --- Channels and lightcycle highways.
  const chan: TslNode = col('#01030b');
  const edgeX: TslNode = band(dx, S / 2 - 0.8, 0.18).mul(streetX), edgeZ: TslNode = band(dz, S / 2 - 0.8, 0.18).mul(streetZ);
  let road: TslNode = chan.add(col('#1a6cff').mul(max(edgeX, edgeZ).mul(0.4)));
  const hEdge: TslNode = max(band(dx, S / 2 - 0.8, 0.28).mul(hwyX), band(dz, S / 2 - 0.8, 0.28).mul(hwyZ));
  const hLane: TslNode = max(band(dx, S / 4, 0.12).mul(hwyX), band(dz, S / 4, 0.12).mul(hwyZ));
  const dashX: TslNode = step(fract(p.z.div(24)), 0.55), dashZ: TslNode = step(fract(p.x.div(24)), 0.55);
  const hCentre: TslNode = max(band(dx, 0, 0.16).mul(hwyX).mul(dashX), band(dz, 0, 0.16).mul(hwyZ).mul(dashZ));
  // Data packets riding the highways.
  const pk: TslNode = max(step(0.94, fract(p.z.div(180).sub(time.mul(0.35)))).mul(band(dx, S / 4, 0.4)).mul(hwyX), step(0.94, fract(p.x.div(180).add(time.mul(0.3)))).mul(band(dz, S / 4, 0.4)).mul(hwyZ));
  road = road.add(col('#36e2ff').mul(hEdge.mul(1.6))).add(col('#2f74ff').mul(hLane.mul(0.45))).add(col('#eaf6ff').mul(hCentre.mul(0.8))).add(col('#eaf6ff').mul(pk.mul(1.5)));

  // --- Open computational plains: vast clean grid planes (and the zoned open ground, sparser).
  const plainBase: TslNode = col('#06143a');
  const plain: TslNode = plainBase.add(col('#2a7bff').mul(gridLines(vec2(lx, lz), pitch, 1.4).mul(0.85))).add(col('#2a7bff').mul(gridLines(p.xz, pitch / 6, 1).mul(0.22)));
  const openG: TslNode = col('#050c22').add(col('#1f5cff').mul(gridLines(p.xz, pitch / 4, 1).mul(0.25)));
  const airG: TslNode = col('#03071a').add(col('#1f5cff').mul(gridLines(p.xz, 20, 1).mul(0.12)));

  // --- Outlands ground styles, blended by the filtered style texture.
  const st: TslNode = texture(styles(), vec2(fx.div(N), fz.div(N)));
  const wsum: TslNode = max(st.r.add(st.g).add(st.b).add(st.a), 1e-3);
  const plainsS: TslNode = col('#061537').add(col('#2a7bff').mul(gridLines(p.xz, 100, 1.3).mul(0.6))).add(col('#2a7bff').mul(gridLines(p.xz, 20, 1).mul(0.12)));
  const dc: TslNode = floor(p.xz.div(9));
  const dh: TslNode = hash(dc.x.mul(41.3).add(dc.y.mul(289.1)));
  const df: TslNode = fract(p.xz.div(9));
  const dash: TslNode = band(df.y, 0.5, 0.05).mul(step(abs(df.x.sub(0.5)), 0.18)).mul(step(0.55, dh));
  const tri: TslNode = max(gridLines(p.xz, 30, 1), gridLines(vec2(p.x.add(p.z), p.x.sub(p.z)).mul(0.7071), 30 * 0.7071, 1));
  const seaS: TslNode = mix(col('#1d3a6e'), col('#2f5694'), smoothstep(-1, 1, abs(fract(p.x.div(400).add(p.z.div(700))).sub(0.5)).mul(4).sub(1)))
    .add(col('#bcd6ff').mul(dash.mul(float(1).sub(smoothstep(0.1, 0.4, fwidth(p.x).div(9)))).mul(0.35))).add(col('#7fb0ff').mul(tri.mul(0.08)));
  const canyonS: TslNode = col('#04070f').add(col('#1f4bff').mul(gridLines(p.xz, 50, 1).mul(0.16)));
  const sv: TslNode = fract(p.xz.div(40));
  const mark: TslNode = max(band(sv.x, 0.5, 0.012).mul(step(abs(sv.y.sub(0.5)), 0.05)), band(sv.y, 0.5, 0.012).mul(step(abs(sv.x.sub(0.5)), 0.05)));
  const wasteS: TslNode = col('#121828').add(col('#ffb347').mul(mark.mul(0.55)));
  const outl: TslNode = plainsS.mul(st.r).add(seaS.mul(st.g)).add(canyonS.mul(st.b)).add(wasteS.mul(st.a)).div(wsum);
  const outland: TslNode = mix(plainsS, outl, smoothstep(0.02, 0.12, wsum));

  // Compose near.
  let c: TslNode = plate.mul(isLot);
  c = c.add(plain.mul(isPlain)).add(openG.mul(isOpen)).add(airG.mul(isAir)).add(outland.mul(isOut));
  c = mix(c, road, street);

  // Far LOD: the filtered per-block colours plus the highway grid, faint lot glow.
  const fp: TslNode = max(fwidth(p.x), fwidth(p.z));
  const avg: TslNode = smoothstep(3, 14, fp);
  const g: TslNode = texture(glowTexture(), vec2(fx.div(N), fz.div(N))).rgb;
  const hwyFar: TslNode = gridLines(vec2(p.x.sub(gx0), p.z.sub(gz0)), pitch * CITY.highwayEvery, 1).mul(float(1).sub(isOut));
  const outHwyFar: TslNode = gridLines(vec2(p.x.sub(gx0), p.z.sub(gz0)), HW, 1).mul(isOut);
  const far: TslNode = smoothstep(CITY_LIGHTS_FROM.mul(0.5), CITY_LIGHTS_FROM, distance(p.xz, cameraPosition.xz));
  const farC: TslNode = g.mul(float(1).add(far.mul(0.4)).mul(CITY_LIGHTS_GAIN)).add(col('#36e2ff').mul(hwyFar.add(outHwyFar).mul(0.35)));
  return mix(c, farC, avg);
}

void vec3;
void clamp;
