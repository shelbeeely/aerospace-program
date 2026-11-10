import * as THREE from 'three/webgpu';
import {
  abs, attribute, cameraPosition, clamp, color, dot, exp, float, floor, fract, fwidth, hash, max, min, mix, mod, normalize,
  positionWorld, pow, sin, smoothstep, step, texture, time, uniform, vec2, vec3,
} from 'three/tsl';
import { LIGHT_COLORS, LIGHT_ROLES, SURFACE_COLORS, SURFACES } from '../../arch/palette.ts';
import { flatWorld } from '../curvature.ts';
import type { TslNode } from '../neon.ts';
import { ARCH_LIGHTING } from './BuildingLightingController.ts';

/**
 * Reusable materials of the digital architecture (one shader for every structure, landform and
 * piece of infrastructure, so a district is one draw call):
 *
 * Surfaces are smooth and mostly unlit, shaded like the airbrushed 1982 concept paintings:
 * a soft key light that wraps, a cool sky fill, a dark-to-light gradient up each structure,
 * and the horizon colour bleeding onto grazing faces. Large panels carry shader-drawn
 * patterns (panel seams, wrapping survey lines, flutes, circuit traces, glowing panes).
 *
 * Light is the secondary layer and part of the architecture: selected edges (anti-aliased in
 * screen space, so they stay crisp at any distance) and emissive faces glow in their role's
 * colour, modulated by the structure's activity state (BuildingLightingController).
 */
export const ARCH_PARAMS = {
  /** HDR gain of all architectural light (edges and emissive faces). */
  glowGain: uniform(1.7),
  /** Edge line width (px). */
  edgeWidth: uniform(1.1),
  /** Strength of the surface patterns. */
  pattern: uniform(1),
  /** Surface brightness (exposure of the painted shading). */
  exposure: uniform(1),
  /** Key light direction (towards the light), sky fill and ground bounce colours, horizon colour. */
  keyDir: uniform(new THREE.Vector3(-0.42, 0.72, 0.55).normalize()),
  sky: uniform(new THREE.Color('#2a5aa8')),
  bounce: uniform(new THREE.Color('#0a1840')),
  horizon: uniform(new THREE.Color('#1c5a9a')),
  /** Debug view: 0 shaded, 1 geometric hierarchy, 2 flat surfaces, 3 activity states, 4 normals. */
  debug: uniform(0),
};

let paletteTex: THREE.DataTexture | null = null;
/** 16 × 2 float palette: row 0 surfaces, row 1 light roles (linear). */
export function archPalette(): THREE.DataTexture {
  if (paletteTex) return paletteTex;
  const data = new Float32Array(16 * 2 * 4);
  const c = new THREE.Color();
  SURFACES.forEach((s, i) => { c.set(SURFACE_COLORS[s]); data.set([c.r, c.g, c.b, 1], i * 4); });
  LIGHT_ROLES.forEach((r, i) => { c.set(LIGHT_COLORS[r]); data.set([c.r, c.g, c.b, 1], (16 + i) * 4); });
  paletteTex = new THREE.DataTexture(data, 16, 2, THREE.RGBAFormat, THREE.FloatType);
  paletteTex.magFilter = paletteTex.minFilter = THREE.NearestFilter;
  paletteTex.generateMipmaps = false;
  paletteTex.needsUpdate = true;
  return paletteTex;
}

/** Anti-aliased lines (0..1) every `spacing` metres on a 2D coordinate, `width` px wide. */
function lines(coord: TslNode, spacing: number, width = 1): TslNode {
  const c: TslNode = coord.div(spacing);
  const fw: TslNode = max(fwidth(c), vec2(1e-4, 1e-4));
  const g: TslNode = abs(fract(c.sub(0.5)).sub(0.5)).div(fw);
  const l: TslNode = float(1).sub(min(min(g.x, g.y).div(width), 1));
  // Fade to nothing where cells shrink below a few pixels (no moiré).
  return l.mul(float(1).sub(clamp(max(fw.x, fw.y).mul(3).sub(0.6), 0, 1)));
}

interface Decoded {
  sid: TslNode; surf: TslNode; role: TslNode; pat: TslNode; tier: TslNode;
  N: TslNode; hgt: TslNode; e: TslNode; glowI: TslNode; uv: TslNode;
  surfCol: TslNode; lightCol: TslNode; act: TslNode; stateIdx: TslNode; visible: TslNode;
}

function decode(): Decoded {
  const info: TslNode = attribute('info', 'vec2');
  const sid: TslNode = info.x;
  const code: TslNode = info.y;
  const pat: TslNode = floor(code.div(128));
  const rem: TslNode = code.sub(pat.mul(128));
  const role: TslNode = floor(rem.div(16));
  const surf: TslNode = rem.sub(role.mul(16));
  const nrm: TslNode = attribute('nrm', 'vec4');
  const N: TslNode = normalize(nrm.xyz);
  const hgt: TslNode = clamp(nrm.w, 0, 1);
  const edge: TslNode = attribute('edge', 'vec4');
  const e: TslNode = edge.xyz.mul(8);
  const glowI: TslNode = edge.w.mul(4);
  const uv: TslNode = attribute('uvm', 'vec2');
  const pal = archPalette();
  const surfCol: TslNode = texture(pal, vec2(surf.add(0.5).div(16), 0.25)).rgb;
  let lightCol: TslNode = texture(pal, vec2(role.add(0.5).div(16), 0.75)).rgb;
  // Activity state from the lighting controller.
  const st: TslNode = texture(ARCH_LIGHTING.texture, vec2(mod(sid, 1024).add(0.5).div(1024), floor(sid.div(1024)).add(0.5).div(64)));
  const stateIdx: TslNode = floor(st.r.mul(255).add(0.5));
  const phase: TslNode = st.g.mul(6.283);
  const visible: TslNode = float(1).sub(step(3.5, stateIdx));
  const active: TslNode = float(0.8).add(sin(time.mul(1.7).add(phase).sub(hgt.mul(6))).mul(0.2));
  const flick: TslNode = step(0.42, hash(floor(time.mul(9)).add(sid.mul(1.37))));
  const damaged: TslNode = float(0.12).add(flick.mul(0.75));
  const act: TslNode = mix(mix(mix(active, float(0.42), step(0.5, stateIdx)), damaged, step(1.5, stateIdx)), float(0.05), step(2.5, stateIdx));
  const isDamaged: TslNode = step(1.5, stateIdx).mul(float(1).sub(step(2.5, stateIdx)));
  lightCol = mix(lightCol, color(LIGHT_COLORS.warning), isDamaged.mul(0.65));
  return { sid, surf, role, pat, tier: float(0), N, hgt, e, glowI, uv, surfCol, lightCol, act, stateIdx, visible };
}

/** Screen-space anti-aliased edge mask from the per-triangle barycentrics. */
function edgeMask(e: TslNode): TslNode {
  const fw: TslNode = max(fwidth(e), vec3(1e-5, 1e-5, 1e-5));
  const d: TslNode = e.div(fw.mul(ARCH_PARAMS.edgeWidth));
  const tiny: TslNode = smoothstep(0.02, 0.14, min(min(fw.x, fw.y), fw.z));
  return float(1).sub(smoothstep(0.5, 1.5, min(min(d.x, d.y), d.z))).mul(float(1).sub(tiny.mul(0.75)));
}

/** Procedural circuit traces on a face coordinate (metres): traces and pads (0..1). */
function circuit(uv: TslNode): TslNode {
  const s = 5;
  const cell: TslNode = floor(uv.div(s));
  const f: TslNode = fract(uv.div(s));
  const h: TslNode = hash(cell.x.mul(127.1).add(cell.y.mul(311.7)));
  const h2: TslNode = hash(cell.x.mul(269.5).add(cell.y.mul(183.3)));
  const fw: TslNode = max(fwidth(uv.x).div(s), 1e-4);
  const band = (v: TslNode, at: number, wdt: number): TslNode => float(1).sub(smoothstep(float(wdt), fw.mul(1.5).add(wdt), abs(v.sub(at))));
  const horiz: TslNode = band(f.y, 0.5, 0.05).mul(step(h, 0.4));
  const vert: TslNode = band(f.x, 0.5, 0.05).mul(step(0.4, h).mul(step(h, 0.75)));
  // L-bends: half a horizontal and half a vertical meeting at the centre.
  const bendH: TslNode = band(f.y, 0.5, 0.05).mul(step(f.x, 0.5));
  const bendV: TslNode = band(f.x, 0.5, 0.05).mul(step(0.5, f.y));
  const bend: TslNode = max(bendH, bendV).mul(step(0.75, h));
  const pad: TslNode = step(abs(f.x.sub(0.5)), 0.12).mul(step(abs(f.y.sub(0.5)), 0.12)).mul(step(0.7, h2));
  const fade: TslNode = float(1).sub(clamp(fw.mul(6).sub(0.4), 0, 1));
  return max(max(max(horiz, vert), bend), pad).mul(fade);
}

/** The colour of an architectural surface fragment (shared by structures and terrain). */
function shade(d: Decoded): TslNode {
  const { N, hgt, uv, surfCol, lightCol, act, surf, pat, role, e, glowI } = d;
  const V: TslNode = normalize(cameraPosition.sub(positionWorld));
  const wrap: TslNode = clamp(dot(N, ARCH_PARAMS.keyDir).mul(0.5).add(0.5), 0, 1);
  const key: TslNode = pow(wrap, 1.7);
  const fill: TslNode = mix(ARCH_PARAMS.bounce, ARCH_PARAMS.sky, N.y.mul(0.5).add(0.5));
  // Airbrushed gradient: dark at the footing, luminous toward the top.
  const grad: TslNode = float(0.45).add(hgt.mul(0.85));
  const rim: TslNode = pow(float(1).sub(clamp(abs(dot(N, V)), 0, 1)), 3);
  let lit: TslNode = surfCol.mul(float(0.4).add(key.mul(1.9))).mul(grad).mul(ARCH_PARAMS.exposure)
    .add(fill.mul(surfCol).mul(0.9))
    .add(ARCH_PARAMS.horizon.mul(rim.mul(0.22)));
  const P: TslNode = ARCH_PARAMS.pattern;
  const isPat = (k: number): TslNode => step(k - 0.5, pat).mul(step(pat, k + 0.5));
  // Panels: large geometric panel seams (dark), every 8 m and a stronger one every 32 m.
  const seams: TslNode = max(lines(uv, 8, 1).mul(0.5), lines(uv, 32, 1.3));
  lit = lit.mul(float(1).sub(seams.mul(0.45).mul(P).mul(isPat(1))));
  // Grid: thin luminous survey lines wrapping the form.
  lit = lit.add(lightCol.mul(lines(uv, 7, 1).mul(0.35).mul(P).mul(isPat(2))).mul(act));
  // Flutes: vertical slat shading.
  const flute: TslNode = abs(sin(uv.x.mul(Math.PI / 2.4)));
  lit = lit.mul(mix(float(1), float(0.62).add(flute.mul(0.6)), isPat(3).mul(P)));
  // Circuit: traces and pads on faces that look up (book p. 12), in the role colour.
  const up: TslNode = smoothstep(0.55, 0.8, N.y);
  lit = lit.add(lightCol.mul(circuit(uv).mul(up).mul(isPat(4)).mul(P).mul(0.75)).mul(act));
  // Skylight: a grid of glowing translucent panes (book pp. 10, 53).
  const pf: TslNode = fract(uv.div(7));
  const pane: TslNode = smoothstep(0.06, 0.1, pf.x).mul(smoothstep(0.06, 0.1, float(1).sub(pf.x))).mul(smoothstep(0.06, 0.1, pf.y)).mul(smoothstep(0.06, 0.1, float(1).sub(pf.y)));
  const paneFade: TslNode = float(1).sub(clamp(max(fwidth(uv.x), fwidth(uv.y)).div(7).mul(4).sub(0.5), 0, 1));
  lit = lit.add(mix(lightCol, color('#bfe8ff'), 0.5).mul(pane.mul(paneFade).add(float(1).sub(paneFade).mul(0.55)).mul(isPat(5)).mul(0.55).mul(act)));
  // Emissive edges.
  const edgeGlow: TslNode = lightCol.mul(edgeMask(e).mul(glowI).mul(ARCH_PARAMS.glowGain).mul(act));
  // Emissive faces: data light flows along the world (moving packets), others breathe.
  const isGlow: TslNode = step(6.5, surf).mul(step(surf, 7.5));
  const isData: TslNode = step(0.5, role).mul(step(role, 1.5));
  const flow: TslNode = mix(float(1), float(0.55).add(smoothstep(0.35, 0.65, fract(flatWorld.x.add(flatWorld.z).div(24).sub(time.mul(0.6)))).mul(0.7)), isData);
  const glowCol: TslNode = lightCol.mul(glowI.mul(ARCH_PARAMS.glowGain).mul(act).mul(flow));
  return mix(lit.add(edgeGlow), glowCol, isGlow);
}

/** Debug colourings (geometric hierarchy, flat surfaces, activity, normals). */
function debugColor(d: Decoded, shaded: TslNode): TslNode {
  const m: TslNode = ARCH_PARAMS.debug;
  const flat: TslNode = d.surfCol.mul(3).add(d.lightCol.mul(edgeMask(d.e).mul(d.glowI)));
  const stateCol: TslNode = mix(mix(mix(color('#36ff8a'), color('#36a0ff'), step(0.5, d.stateIdx)), color('#ff2a1a'), step(1.5, d.stateIdx)), color('#303040'), step(2.5, d.stateIdx));
  const actCol: TslNode = stateCol.mul(float(0.35).add(d.hgt.mul(0.5))).add(color('#ffffff').mul(edgeMask(d.e).mul(0.4)));
  const nrmCol: TslNode = d.N.mul(0.5).add(0.5);
  // Hierarchy (from the edge glow and surface): primary bright, emissive tertiary orange.
  const hier: TslNode = mix(color('#d8f0ff').mul(float(0.25).add(d.hgt.mul(0.4))), color('#ff8a1f'), step(6.5, d.surf).mul(step(d.surf, 7.5))).add(color('#36e2ff').mul(edgeMask(d.e)));
  let c: TslNode = shaded;
  c = mix(c, hier, step(0.5, m).mul(step(m, 1.5)));
  c = mix(c, flat, step(1.5, m).mul(step(m, 2.5)));
  c = mix(c, actCol, step(2.5, m).mul(step(m, 3.5)));
  c = mix(c, nrmCol, step(3.5, m));
  return c;
}

let opaque: THREE.MeshBasicNodeMaterial | null = null;
/** The opaque architecture material (shared by every district, landform set and infrastructure mesh). */
export function archMaterial(): THREE.MeshBasicNodeMaterial {
  if (opaque) return opaque;
  const m = new THREE.MeshBasicNodeMaterial({ side: THREE.FrontSide });
  const d = decode();
  m.colorNode = debugColor(d, shade(d));
  m.opacityNode = d.visible;
  m.alphaTest = 0.5;
  m.name = 'arch-surface';
  return (opaque = m);
}

let interior: THREE.MeshBasicNodeMaterial | null = null;
/** Same shader, double-sided: interiors are seen from inside their shells. */
export function archInteriorMaterial(): THREE.MeshBasicNodeMaterial {
  if (interior) return interior;
  const m = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
  const d = decode();
  m.colorNode = debugColor(d, shade(d));
  m.opacityNode = d.visible;
  m.alphaTest = 0.5;
  m.name = 'arch-interior';
  return (interior = m);
}

let translucent: THREE.MeshBasicNodeMaterial | null = null;
/** Additive translucent light: beams, energy columns, light shafts. Fades with height. */
export function archLightMaterial(): THREE.MeshBasicNodeMaterial {
  if (translucent) return translucent;
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: true });
  const d = decode();
  const V: TslNode = normalize(cameraPosition.sub(positionWorld));
  const edgeOn: TslNode = float(0.35).add(pow(float(1).sub(abs(dot(d.N, V))), 1.4).mul(0.9));
  const fade: TslNode = exp(d.uv.y.div(-700));
  m.colorNode = d.lightCol.mul(d.glowI.mul(ARCH_PARAMS.glowGain).mul(0.32).mul(d.act).mul(edgeOn).mul(fade).mul(d.visible));
  m.name = 'arch-light';
  return (translucent = m);
}
