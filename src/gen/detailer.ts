import { boxesTouch, connectivityErrors, obb } from '../craft/connectivity.ts';
import { style1982 } from '../craft/style1982.ts';
import type { CraftDef, PartDef } from '../craft/types.ts';
import { validateCraft } from '../craft/validate.ts';
import { flightTest, type FlightReport } from '../sim/flightTest.ts';
import { extractJson, type ChatMessage, type OpenRouter } from './openrouter.ts';

/** Most a detail part may weigh (kg), and the share of the craft's mass all of them together may add. */
const DETAIL_MAX_KG = 2;
const DETAIL_MASS_SHARE = 0.02;
const MAX_PARTS = 200;

/**
 * The detail round's brief. The craft already flies (it passed its test card); the model adds
 * secondary and tertiary geometry only. The game enforces the rules below in code (mergeDetail),
 * so a model that breaks one loses that part, never the tested design.
 */
export function detailBrief(craft: CraftDef, concept: string): string {
  return `This craft passed its flight test. Now make it look finished and detailed, without changing how it flies.

Concept: ${concept}

Current craft (${craft.parts.length} parts):
${JSON.stringify(craft)}

Add 25-80 small VISUAL detail parts (aim for ${Math.min(MAX_PARTS, Math.max(40, craft.parts.length * 3))} parts in total). Rules, enforced by the game:
- Keep EVERY existing part exactly as it is (same id, position, rotation, shape, mass, modules, collider). Changed or removed parts are restored automatically.
- New parts: new unique ids, "collider": false, no "modules", mass 0.01-${DETAIL_MAX_KG} kg (all of them together under ${Math.round(DETAIL_MASS_SHARE * 100)}% of the craft's mass).
- Every new part must overlap or touch the craft (an existing part or another connected detail part). Floating parts are dropped.
- 1982 digital-world style: secondary geometry (fairings, armour plates, intakes, nacelle cowls, canopy frames, fender arcs over wheels, wheel hubs, struts and braces, fin caps, sensor pods, antenna masts, exhaust nozzles and rings, vents, steps and ledges) and tertiary geometry (thin panel seams and light lines a few cm thick along edges and around canopies, intakes, nozzles and wheel rims, kind "accent light"). Most detail is dark body colour; light lines use the circuit colour sparingly.
- Use geometry to make the silhouette richer and more distinctive: layered plates, stepped forms, chamfer-like angled boxes (rotationDeg), ribs, rings of small boxes. Keep the concept's identity.
- Use only shapes box, cylinder and sphere. Write compact JSON.

Reply with ONLY {"name": string, "notes": string, "craft": <the complete craft, existing parts plus your new ones>}.`;
}

export interface DetailMerge {
  craft: CraftDef;
  /** Detail parts kept. */
  added: number;
  /** Why proposed parts were dropped or changed (for the log). */
  notes: string[];
}

/**
 * Merge a detail proposal into the tested craft. Physics stays exactly as tested: every base part
 * is kept as it was (proposed edits to it are ignored, removals restored); new parts are forced
 * visual-only (no collider, no modules, no structural overrides), light, valid, and connected to
 * the craft (floating ones are dropped); their total mass is capped at a small share of the craft's.
 */
export function mergeDetail(base: CraftDef, proposed: unknown): DetailMerge {
  const notes: string[] = [];
  const baseIds = new Set(base.parts.map((p) => p.id));
  const raw = (proposed as { parts?: unknown[] } | null)?.parts;
  const candidates = Array.isArray(raw) ? raw : [];
  let edited = 0;
  const fresh: PartDef[] = [];
  const used = new Set(baseIds);
  for (const c of candidates) {
    const p = c as PartDef;
    if (!p || typeof p !== 'object') continue;
    if (baseIds.has(p.id)) {
      const b = base.parts.find((x) => x.id === p.id)!;
      if (JSON.stringify(b) !== JSON.stringify(p)) edited++;
      continue;
    }
    // Visual only: strip anything with physics in it.
    const d: PartDef = {
      id: String(p.id ?? 'detail'),
      kind: typeof p.kind === 'string' ? p.kind : 'detail',
      mass: Math.min(DETAIL_MAX_KG, Math.max(0.01, Number(p.mass) || 0.1)),
      position: p.position,
      ...(p.rotationDeg ? { rotationDeg: p.rotationDeg } : {}),
      shape: p.shape,
      collider: false,
      color: typeof p.color === 'string' ? p.color : '#10284f',
    };
    if (validateCraft({ name: 'x', formatVersion: 1, parts: [d] }).length) continue; // malformed shape or position
    let id = d.id;
    for (let k = 2; used.has(id); k++) id = `${d.id}.${k}`;
    used.add(id);
    fresh.push({ ...d, id });
  }
  if (edited) notes.push(`${edited} edit(s) to tested parts ignored`);
  if (candidates.length && base.parts.some((b) => !candidates.some((c) => (c as PartDef)?.id === b.id))) notes.push('removed parts restored');
  // Connected: grow from the tested structure, adding detail parts that touch it.
  const boxes = new Map(fresh.map((p) => [p.id, obb(p)]));
  const connected = base.parts.map(obb);
  const kept: PartDef[] = [];
  let pending = [...fresh];
  for (let changed = true; changed && pending.length;) {
    changed = false;
    const rest: PartDef[] = [];
    for (const p of pending) {
      const b = boxes.get(p.id)!;
      if (connected.some((c) => boxesTouch(c, b))) {
        kept.push(p);
        connected.push(b);
        changed = true;
      } else rest.push(p);
    }
    pending = rest;
  }
  if (pending.length) notes.push(`${pending.length} floating detail part(s) dropped`);
  // Part budget, then the mass budget (scaled down together).
  const room = Math.max(0, MAX_PARTS - base.parts.length);
  if (kept.length > room) {
    notes.push(`${kept.length - room} detail part(s) over the ${MAX_PARTS}-part limit dropped`);
    kept.length = room;
  }
  const baseMass = base.parts.reduce((s, p) => s + p.mass, 0);
  const added = kept.reduce((s, p) => s + p.mass, 0);
  const cap = baseMass * DETAIL_MASS_SHARE;
  if (added > cap) {
    const k = cap / added;
    for (const p of kept) p.mass = Math.max(0.01, +(p.mass * k).toFixed(3));
    notes.push(`detail mass scaled to ${Math.round(DETAIL_MASS_SHARE * 100)}% of the craft`);
  }
  const craft: CraftDef = { ...base, parts: [...base.parts, ...kept] };
  return { craft, added: kept.length, notes };
}

export interface DetailRequest {
  model: string;
  fallbacks?: string[];
  craft: CraftDef;
  /** What the craft is meant to be (the original request). */
  concept: string;
  tester?: (craft: CraftDef) => Promise<FlightReport>;
  /** The base craft's report: the detailed one must do at least as well. */
  baseReport?: FlightReport;
  signal?: AbortSignal;
}

export interface DetailResult {
  /** The detailed craft if it was accepted, else the base craft unchanged. */
  craft: CraftDef;
  report: FlightReport | null;
  accepted: boolean;
  added: number;
  notes: string[];
  model: string;
  cost: number;
}

/**
 * The detail round: one model call adds visual detail to a craft that already flies; the merge
 * keeps the physics as tested; the detailed craft is flight-tested again and kept only if it
 * still passes (and scores no worse).
 */
export async function detailCraft(client: OpenRouter, req: DetailRequest): Promise<DetailResult> {
  const base = req.craft;
  const messages: ChatMessage[] = [
    { role: 'system', content: (await import('./craftDesigner.ts')).DESIGNER_SYSTEM_PROMPT },
    { role: 'user', content: detailBrief(base, req.concept) },
  ];
  const res = await client.chat({ model: req.model, fallbacks: req.fallbacks, messages, format: 'json', temperature: 0.6, maxTokens: 64000, reasoningEffort: 'low', signal: req.signal });
  const fail = (note: string): DetailResult => ({ craft: base, report: null, accepted: false, added: 0, notes: [note], model: res.model, cost: res.usage.cost });
  let parsed: unknown;
  try {
    const j = extractJson(res.content || res.reasoning) as Record<string, unknown>;
    parsed = j && typeof j === 'object' && 'craft' in j ? j.craft : j;
  } catch (e) {
    return fail(`detail reply was not JSON: ${e instanceof Error ? e.message : e}`);
  }
  const merged = mergeDetail(base, parsed);
  if (!merged.added) return fail('no usable detail parts');
  const craft = style1982(merged.craft);
  if (connectivityErrors(craft).length || validateCraft(craft).length) return fail('detailed craft failed validation');
  const report = await (req.tester ? req.tester(craft) : flightTest(craft, { yieldEvery: 1500 }));
  const ok = report.passed && (!req.baseReport || report.score >= req.baseReport.score);
  return { craft: ok ? craft : base, report, accepted: ok, added: merged.added, notes: ok ? merged.notes : [...merged.notes, `detailed version scored ${report.score}/100: kept the plain one`], model: res.model, cost: res.usage.cost };
}
