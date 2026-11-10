import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { CraftDef } from '../craft/types.ts';
import { vehicleGrammar, type PieceShape, type VehiclePiece } from '../craft/grammar.ts';
import { edgeColor, fillColor } from './CraftView.ts';
import { glow, neonFillMaterial, neonize } from './neon.ts';

/** A lit group of pieces (one part's lights of one kind), whose brightness the owner drives. */
export interface GrammarLight {
  partId: string;
  kind: 'running' | 'nozzle';
  engine: number;
  afterburner: boolean;
  material: THREE.MeshBasicNodeMaterial;
  base: THREE.Color;
  mesh: THREE.Mesh;
}

export interface GrammarModel {
  /** Everything drawn, per part (hidden with the part when it breaks off). */
  byPart: Map<string, THREE.Object3D[]>;
  lights: GrammarLight[];
  pieces: number;
}

function pieceGeometry(s: PieceShape): THREE.BufferGeometry {
  switch (s.type) {
    case 'box': return new THREE.BoxGeometry(...s.size);
    // radiusTop is +Y, which rotateX(+90°) turns to +Z (the back).
    case 'frustum': return new THREE.CylinderGeometry(s.rBack, s.rFront, s.length, 16, 1, true).rotateX(Math.PI / 2);
    case 'ring': return new THREE.TorusGeometry(s.radius, s.tube, 6, 28, s.arc ?? Math.PI * 2);
    case 'disc': return new THREE.CircleGeometry(s.radius, 20);
  }
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);

function placed(p: VehiclePiece): THREE.BufferGeometry {
  const g = pieceGeometry(p.shape);
  _q.set(...p.quaternion);
  _p.set(...p.position);
  g.applyMatrix4(_m.compose(_p, _q, _s));
  return g.index ? g.toNonIndexed() : g;
}

/**
 * Draws the vehicle grammar (src/craft/grammar.ts) into `root`: body pieces as dark fills with
 * dim seams, lit pieces as glowing fills, merged per part and tone so a craft costs a few draw
 * calls per part, not per piece.
 */
export function buildGrammar(def: CraftDef, root: THREE.Object3D): GrammarModel {
  const model: GrammarModel = { byPart: new Map(), lights: [], pieces: 0 };
  let pieces: VehiclePiece[];
  try {
    pieces = vehicleGrammar(def);
  } catch {
    return model; // a design the grammar can't read just gets no extra detail
  }
  model.pieces = pieces.length;
  const groups = new Map<string, VehiclePiece[]>();
  for (const p of pieces) {
    const key = p.tone === 'light'
      ? `${p.partId}|L|${p.color}|${p.light?.kind}|${p.light?.kind === 'nozzle' ? p.light.engine : ''}`
      : `${p.partId}|B|${p.color}`;
    const list = groups.get(key) ?? [];
    list.push(p);
    groups.set(key, list);
  }
  const track = (id: string, o: THREE.Object3D) => {
    const l = model.byPart.get(id) ?? [];
    l.push(o);
    model.byPart.set(id, l);
  };
  for (const list of groups.values()) {
    const first = list[0];
    const geo = mergeGeometries(list.map(placed), false);
    if (!geo) continue;
    if (first.tone === 'light') {
      const base = new THREE.Color(first.color);
      const material = new THREE.MeshBasicNodeMaterial({ color: glow(base, 2.2), side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(geo, material);
      root.add(mesh);
      track(first.partId, mesh);
      const l = first.light ?? { kind: 'running' as const };
      model.lights.push({
        partId: first.partId, kind: l.kind, engine: l.kind === 'nozzle' ? l.engine : -1,
        afterburner: l.kind === 'nozzle' && l.afterburner, material, base, mesh,
      });
    } else {
      const mesh = new THREE.Mesh(geo, neonFillMaterial(fillColor(first.color)));
      // Seams and plates carry dim structural edges, like the body they sit on.
      mesh.add(neonize(geo, edgeColor(first.color).multiplyScalar(first.tone === 'seam' ? 0.8 : 1)));
      root.add(mesh);
      track(first.partId, mesh);
    }
  }
  return model;
}

const AB = new THREE.Color('#ffd28a');
const _c = new THREE.Color();

/**
 * Set the lights' state (AGENTS.md §5): running lights dim when idle and full when active;
 * a nozzle glows with its engine's spool and flares toward white-amber on afterburner; a
 * damaged part's lights flicker (the worse the damage, the more they drop out); an inactive
 * craft's lights are off.
 */
export function driveGrammarLights(
  model: GrammarModel,
  state: {
    activity: number;
    inactive?: boolean;
    engine?: (i: number) => { spool: number; afterburner: number } | undefined;
    integrity?: (partId: string) => number;
    time: number;
  },
): void {
  for (const l of model.lights) {
    let k: number;
    if (state.inactive) k = 0;
    else if (l.kind === 'nozzle') {
      const e = state.engine?.(l.engine);
      const spool = e?.spool ?? 0;
      const ab = e?.afterburner ?? 0;
      k = spool < 0.02 ? 0.04 : 0.15 + spool * 0.65 + ab * 0.5; // bright, never a blown-out disc
      _c.copy(l.base).lerp(AB, Math.min(1, ab));
      l.material.color.copy(glow(_c, 2.2 * k));
      continue;
    } else k = 0.4 + 0.6 * Math.min(1, state.activity);
    const integrity = state.integrity?.(l.partId) ?? 1;
    if (integrity < 0.98) {
      // Flicker: a fast, irregular on/off pattern, off more often as integrity falls.
      const n = Math.sin(state.time * 37.1 + l.engine * 3.3 + l.partId.length) * Math.sin(state.time * 13.7 + l.partId.charCodeAt(0));
      k *= n > (integrity - 0.6) * 1.5 ? 0.12 : 1;
    }
    l.material.color.copy(glow(l.base, 2.2 * k));
  }
}
