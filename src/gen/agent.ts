import { connectivityErrors } from '../craft/connectivity.ts';
import { style1982 } from '../craft/style1982.ts';
import type { CraftDef, PartDef } from '../craft/types.ts';
import { validateCraft } from '../craft/validate.ts';
import { analyzeDesign, flightTest, formatReport, type FlightReport } from '../sim/flightTest.ts';
import { initPhysics, Simulation } from '../sim/Simulation.ts';
import { vehicleKind } from '../sim/vehicleTests.ts';
import { autoFix } from './autofix.ts';
import { designCraft, DESIGNER_SYSTEM_PROMPT, type DesignAttempt, type DesignRequest, type DesignResult } from './craftDesigner.ts';
import { mergeDetail } from './detailer.ts';
import { isAgenticOnly } from './catalog.ts';
import { supportsTools, type ChatMessage, type ModelInfo, type OpenRouter, type ToolCall, type ToolDef } from './openrouter.ts';

/**
 * The agent harness: the model runs the whole design pipeline itself, through tools, instead of
 * answering one JSON reply per round. It drafts a craft, checks it (validation, connectivity),
 * analyses it (mass, CoM, static margin, wing loading, T/W, stall speed, wheels), edits it with
 * small patches instead of rewriting it, flight-tests it, adds visual detail once it passes,
 * and finishes. The harness owns the gates: every craft is validated, auto-fixed (control
 * signs, wheel springs), connectivity-checked and restyled before it counts; detail can never
 * change the tested physics; and the final craft must have passed a flight test the harness ran
 * itself. Budgets cap model turns and flight tests. Models without tool calling (or a model
 * that won't call them) fall back to the fixed loop in craftDesigner.ts.
 */

export interface AgentRequest extends DesignRequest {
  /** The designer model's catalog entry (tool support), if known. */
  modelInfo?: ModelInfo;
  /** Model turns (default 28) and flight tests (default 8) the agent may use. */
  maxTurns?: number;
  maxTests?: number;
  /** How hard the model thinks each turn (default medium). */
  effort?: 'low' | 'medium' | 'high';
  /** Force the fixed pipeline (no tools). */
  noAgent?: boolean;
}

/** What the agent is doing, live: for the Studio's console and the turntable. */
export type AgentEvent =
  /** A tool ran; `summary` is the first line of its result. */
  | { type: 'tool'; name: string; summary: string; turn: number }
  /** Reasoning text streaming in (a delta). */
  | { type: 'thinking'; text: string; turn: number }
  /** Visible text streaming in (a delta). */
  | { type: 'text'; text: string; turn: number }
  /** A tool call streaming in: its name and how much argument text has arrived. */
  | { type: 'calling'; name: string; bytes: number; turn: number }
  /** The craft as it stands: `partial` while a tool call is still streaming its parts in. */
  | { type: 'craft'; craft: CraftDef; partial: boolean; turn: number };

/**
 * Complete part objects found so far in a tool call's argument JSON, which may be cut off
 * anywhere: every balanced {...} that parses and looks like a part (id, shape, position, mass).
 */
export function partialParts(text: string): PartDef[] {
  const out: PartDef[] = [];
  const seen = new Set<string>();
  const stack: number[] = [];
  let inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') stack.push(i);
    else if (ch === '}' && stack.length) {
      const start = stack.pop()!;
      const s = text.slice(start, i + 1);
      if (!s.includes('"shape"') || !s.includes('"position"')) continue;
      try {
        const p = JSON.parse(s) as PartDef;
        if (p && typeof p.id === 'string' && p.shape && Array.isArray(p.position) && typeof p.mass === 'number' && !seen.has(p.id)) {
          seen.add(p.id);
          out.push(p);
        }
      } catch { /* an outer object still open, or junk */ }
    }
  }
  return out;
}

export const AGENT_TOOLS: ToolDef[] = [
  tool('submit_craft', 'Set the working craft to a complete design (your first draft, or a full rewrite). It is validated, auto-fixed (control signs, wheel springs), connectivity-checked and restyled to the 1982 palette; the result reports any problems.', {
    craft: { type: 'object', description: 'The complete craft: {"name","formatVersion":1,"parts":[...]}' },
  }, ['craft']),
  tool('patch', 'Edit the working craft with small operations instead of rewriting it. add: a new part; update: shallow-merge fields into a part by id (give "modules" in full to replace them); remove: a part by id. Returns the check result.', {
    ops: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          op: { type: 'string', enum: ['add', 'update', 'remove'] },
          id: { type: 'string', description: 'update/remove: the part id' },
          part: { type: 'object', description: 'add: the full new part' },
          set: { type: 'object', description: 'update: the fields to change' },
        },
        required: ['op'],
      },
    },
  }, ['ops']),
  tool('check', 'Validate the working craft: format errors, floating parts, modules off their part. Cheap; use it after every edit.', {}, []),
  tool('analyze', 'Numbers for the working craft: vehicle kind, mass, centre of mass, wing area and loading, static margin (chords), T/W, estimated stall speed, controls present, wheel positions. Use it before a flight test.', {}, []),
  tool('flight_test', 'Fly the working craft through its automated test card (takeoff/hover/drive per vehicle kind) and get the scored report. Limited budget: test when the analysis looks right.', {}, []),
  tool('add_detail', 'After the working craft has PASSED a flight test: add visual detail parts (secondary and tertiary geometry). Tested parts cannot change; new parts are forced visual-only (no collider, no modules, light) and must touch the craft and be visible (not inside the body). Re-test before finishing.', {
    parts: { type: 'array', items: { type: 'object' }, description: 'New detail parts (full part objects with new unique ids)' },
  }, ['parts']),
  tool('get_craft', 'Return the working craft as JSON.', {}, []),
  tool('finish', 'End the job. The harness flight-tests the working craft if it changed since the last test and keeps the best passing version.', {
    name: { type: 'string' },
    notes: { type: 'string', description: 'One or two sentences on the design intent' },
  }, ['name']),
];

function tool(name: string, description: string, properties: Record<string, unknown>, required: string[]): ToolDef {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } };
}

const AGENT_PROMPT = `${DESIGNER_SYSTEM_PROMPT.replace(/## Your output[\s\S]*$/, '')}
## Agent mode: you run the pipeline with tools
Ignore any instruction above to reply with JSON only: here you work by calling tools.
1. submit_craft with a complete first draft for the request (or patch the craft you were given).
2. check, then analyze. Fix problems with patch (small edits) before testing.
3. flight_test. Read the report; patch what it says; test again. Tests are limited, so think before each one.
4. Once it passes: add_detail with 25-80 visual detail parts (three tiers, 1982 style, on the outside surface), check, then flight_test again.
5. finish with a name and notes.
Every tool result is short text. Keep going until you call finish.`;

interface State {
  craft: CraftDef | null;
  /** JSON of the craft as last tested, and its report. */
  testedJson: string | null;
  lastReport: FlightReport | null;
  best: { craft: CraftDef; report: FlightReport } | null;
  /** The last craft that passed a test: the physics baseline for add_detail. */
  passed: { json: string; craft: CraftDef; report: FlightReport } | null;
  tests: number;
  finished: { name: string; notes: string } | null;
}

/** Normalise any craft input: format version, validation, auto-fix, 1982 style. */
function admit(raw: unknown, st: State): string {
  const c = raw && typeof raw === 'object' && 'craft' in (raw as object) ? (raw as { craft: unknown }).craft : raw;
  if (!c || typeof c !== 'object') return 'ERROR: no craft object given.';
  (c as CraftDef).formatVersion = 1;
  (c as CraftDef).name ??= 'Untitled';
  const errors = validateCraft(c);
  if (errors.length) return `REJECTED (working craft unchanged): ${errors.length} format error(s):\n${errors.slice(0, 20).join('\n')}`;
  const { craft, fixes } = autoFix(c as CraftDef);
  st.craft = style1982(craft);
  const conn = connectivityErrors(st.craft);
  return `OK: ${st.craft.parts.length} parts.${fixes.length ? `\nAuto-fixed: ${fixes.join('; ')}` : ''}${conn.length ? `\nPROBLEMS (fix before testing):\n${conn.slice(0, 15).join('\n')}` : '\nOne connected piece.'}`;
}

function applyPatch(base: CraftDef, ops: unknown): { craft: CraftDef; log: string[] } {
  const parts: PartDef[] = structuredClone(base.parts);
  const log: string[] = [];
  for (const o of Array.isArray(ops) ? ops : []) {
    const op = o as { op?: string; id?: string; part?: PartDef; set?: Partial<PartDef> };
    if (op.op === 'add' && op.part) {
      if (parts.some((p) => p.id === op.part!.id)) log.push(`add ${op.part.id}: id exists, skipped`);
      else parts.push(op.part);
    } else if (op.op === 'remove' && op.id) {
      const i = parts.findIndex((p) => p.id === op.id);
      if (i < 0) log.push(`remove ${op.id}: no such part`);
      else parts.splice(i, 1);
    } else if (op.op === 'update' && op.id && op.set) {
      const p = parts.find((q) => q.id === op.id);
      if (!p) log.push(`update ${op.id}: no such part`);
      else Object.assign(p, op.set, { id: p.id });
    } else log.push(`bad op ${JSON.stringify(o).slice(0, 80)}`);
  }
  return { craft: { ...base, parts }, log };
}

async function analyzeText(craft: CraftDef): Promise<string> {
  await initPhysics();
  const sim = new Simulation(craft);
  const d = analyzeDesign(sim);
  const kind = vehicleKind(sim);
  const com = sim.craft.massProps.com;
  const wheels = sim.craft.wheels.map((w) => {
    const p = w.def.offset ?? [0, 0, 0];
    return `[${p.map((v) => +v.toFixed(2)).join(',')}] r${w.def.radius}${w.def.drive ? ' driven' : ''}${w.def.maxSteerDeg ? ' steer' : ''}${w.def.skid ? ' skid' : ''}`;
  });
  return [
    `kind ${kind}, mass ${d.mass} kg, CoM [${[com.x, com.y, com.z].map((v) => +v.toFixed(2)).join(', ')}]`,
    kind === 'airplane' ? `wing area ${d.wingArea} m², loading ${d.wingLoading} kg/m², static margin ${d.staticMargin} chords (target 0.1-0.3), T/W ${d.thrustToWeight}, est. stall ${d.stallSpeed} m/s` : `T/W ${d.thrustToWeight}`,
    `controls: ${Object.entries(d.controls).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none'}`,
    `wheels (${wheels.length}, module offsets on their parts): ${wheels.join('; ') || 'none'}`,
  ].join('\n');
}

/**
 * Run the design pipeline as an agent (or the fixed loop when tools aren't available).
 * Returns the same DesignResult as designCraft, so the Studio and the hangar treat both alike.
 */
export async function designWithAgent(client: OpenRouter, req: AgentRequest, onTool?: (e: AgentEvent) => void): Promise<DesignResult> {
  const agentic = isAgenticOnly(req.model);
  // The fixed rounds as a fallback, except for agentic-only endpoints (their terms forbid it).
  const fixed = (why: string): Promise<DesignResult> => {
    if (agentic) throw new Error(`${req.model} ${why}, and it may only be used through the agent harness, so there is no fixed-round fallback. Try again or pick another model.`);
    return designCraft(client, req);
  };
  if (req.noAgent || (req.modelInfo && !supportsTools(req.modelInfo))) return fixed('cannot call tools');
  const emit = req.onEvent ?? (() => {});
  const maxTurns = req.maxTurns ?? 28;
  const maxTests = req.maxTests ?? 8;
  const st: State = { craft: null, testedJson: null, lastReport: null, best: null, passed: null, tests: 0, finished: null };
  const attempts: DesignAttempt[] = [];
  let cost = 0;
  const models = new Set<string>();
  const test = async (): Promise<FlightReport> => {
    const craft = st.craft!;
    st.tests++;
    emit({ type: 'status', message: `Agent: flight test ${st.tests}/${maxTests} of "${craft.name}"…` });
    const report = await (req.tester ? req.tester(craft) : flightTest(craft, { yieldEvery: 1500 }));
    st.testedJson = JSON.stringify(craft);
    st.lastReport = report;
    if (report.passed) st.passed = { json: st.testedJson, craft, report };
    if (!st.best || report.score > st.best.report.score || (report.passed && report.score >= st.best.report.score)) st.best = { craft, report };
    const attempt: DesignAttempt = { iteration: st.tests, role: 'designer', craft, report, cost: 0 };
    attempts.push(attempt);
    emit({ type: 'attempt', attempt });
    return report;
  };

  if (req.base) admit(req.base, st);
  const messages: ChatMessage[] = [
    { role: 'system', content: AGENT_PROMPT },
    {
      role: 'user',
      content: req.base
        ? `Modify the working craft (already loaded; get_craft shows it). Requested change: ${req.prompt}${req.feedback ? `\n\nFeedback from the last test flight:\n${req.feedback}` : ''}`
        : `Design this vehicle: ${req.prompt}`,
    },
  ];
  if (req.detail === false) (messages[1] as { content: string }).content += '\n\nSkip add_detail: finish as soon as the design passes.';

  const run = async (call: ToolCall): Promise<string> => {
    let args: Record<string, unknown> = {};
    try {
      args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
    } catch {
      return 'ERROR: arguments were not valid JSON. Send compact, complete JSON.';
    }
    const need = () => (st.craft ? null : 'ERROR: no working craft yet. Call submit_craft first.');
    switch (call.function.name) {
      case 'submit_craft':
        return admit(args.craft ?? args, st);
      case 'patch': {
        if (need()) return need()!;
        const { craft, log } = applyPatch(st.craft!, args.ops);
        return `${log.length ? `${log.join('\n')}\n` : ''}${admit(craft, st)}`;
      }
      case 'check': {
        if (need()) return need()!;
        const e = [...validateCraft(st.craft), ...connectivityErrors(st.craft!)];
        return e.length ? `${e.length} problem(s):\n${e.slice(0, 20).join('\n')}` : `OK: ${st.craft!.parts.length} parts, one connected piece, valid.`;
      }
      case 'analyze':
        if (need()) return need()!;
        return analyzeText(st.craft!);
      case 'flight_test': {
        if (need()) return need()!;
        const e = connectivityErrors(st.craft!);
        if (e.length) return `NOT TESTED: fix these first:\n${e.slice(0, 10).join('\n')}`;
        if (st.tests >= maxTests) return `NOT TESTED: the flight-test budget (${maxTests}) is spent. Call finish.`;
        return formatReport(await test());
      }
      case 'add_detail': {
        if (need()) return need()!;
        if (!st.passed || st.passed.json !== JSON.stringify(st.craft)) return 'NOT ADDED: add_detail needs a craft that just passed a flight test (unchanged since). Test it first.';
        const m = mergeDetail(st.passed.craft, { parts: [...st.passed.craft.parts, ...(Array.isArray(args.parts) ? args.parts : [])] });
        st.craft = style1982(m.craft);
        return `Added ${m.added} detail part(s) (${st.craft.parts.length} parts now).${m.notes.length ? ` ${m.notes.join('; ')}.` : ''} Run flight_test, then finish.`;
      }
      case 'get_craft':
        return st.craft ? JSON.stringify(st.craft) : 'No working craft yet.';
      case 'finish':
        st.finished = { name: String(args.name ?? st.craft?.name ?? 'Untitled'), notes: String(args.notes ?? '') };
        return 'Finishing.';
      default:
        return `ERROR: unknown tool ${call.function.name}.`;
    }
  };

  // Live preview: parts streaming in through submit_craft / patch / add_detail, shown as they arrive.
  let lastPreview = { name: '', count: -1, at: 0 };
  const preview = (name: string, args: string, turn: number) => {
    if (!onTool || !/^(submit_craft|patch|add_detail)$/.test(name)) return;
    const now = Date.now();
    if (now - lastPreview.at < 150 && lastPreview.name === name) return;
    const parts = partialParts(args).filter((p) => validateCraft({ name: 'x', formatVersion: 1, parts: [p] }).length === 0);
    if (parts.length === lastPreview.count && lastPreview.name === name) return;
    lastPreview = { name, count: parts.length, at: now };
    if (!parts.length) return;
    const base = name === 'submit_craft' ? [] : (st.craft?.parts ?? []);
    const ids = new Set(base.map((p) => p.id));
    const craft: CraftDef = { name: st.craft?.name ?? 'Draft', formatVersion: 1, parts: [...base, ...parts.filter((p) => !ids.has(p.id))] };
    onTool({ type: 'craft', craft, partial: true, turn });
  };

  let nudges = 0;
  for (let turn = 1; turn <= maxTurns && !st.finished; turn++) {
    let res;
    try {
      res = await client.chat({
        // tool_choice is left at the provider default ('auto'): some endpoints don't accept the field.
        model: req.model, fallbacks: req.designerFallbacks, messages, tools: AGENT_TOOLS,
        temperature: turn === 1 ? 0.7 : 0.35, maxTokens: 64000, reasoningEffort: req.effort ?? 'medium', signal: req.signal,
        onDelta: (d) => {
          if (d.kind === 'reasoning') onTool?.({ type: 'thinking', text: d.text, turn });
          else if (d.kind === 'content') onTool?.({ type: 'text', text: d.text, turn });
          else {
            onTool?.({ type: 'calling', name: d.name, bytes: d.args.length, turn });
            preview(d.name, d.args, turn);
          }
        },
      });
    } catch (e) {
      if (req.signal?.aborted) throw e;
      // A model that can't take tools at all: run the fixed pipeline instead.
      if (turn === 1) {
        emit({ type: 'status', message: `Agent mode unavailable (${e instanceof Error ? e.message.slice(0, 80) : e}); running the fixed pipeline.` });
        return fixed(`failed on its first agent turn (${e instanceof Error ? e.message.slice(0, 120) : e})`);
      }
      break; // keep what we have
    }
    cost += res.usage.cost;
    models.add(res.model);
    messages.push({ role: 'assistant', content: res.content ?? '', ...(res.toolCalls.length ? { tool_calls: res.toolCalls } : {}) });
    if (!res.toolCalls.length) {
      // No tool call: a model that answers in prose/JSON only. Nudge twice, then fall back.
      if (turn === 1 && !st.craft && nudges === 0 && /"parts"\s*:/.test(res.content)) {
        try { admit(JSON.parse(res.content.slice(res.content.indexOf('{'), res.content.lastIndexOf('}') + 1)), st); } catch { /* ignore */ }
      }
      if (++nudges > 2) {
        if (!st.craft) {
          emit({ type: 'status', message: 'The model would not use tools; running the fixed pipeline.' });
          return fixed('would not use the tools');
        }
        break;
      }
      messages.push({ role: 'user', content: 'Use the tools: submit_craft / patch / check / analyze / flight_test / add_detail, then finish.' });
      continue;
    }
    for (const call of res.toolCalls) {
      const before = st.craft;
      const out = await run(call);
      if (st.craft && st.craft !== before) onTool?.({ type: 'craft', craft: st.craft, partial: false, turn });
      lastPreview = { name: '', count: -1, at: 0 };
      onTool?.({ type: 'tool', name: call.function.name, summary: out.split('\n')[0].slice(0, 160), turn });
      emit({ type: 'status', message: `Agent: ${call.function.name} → ${out.split('\n')[0].slice(0, 100)}` });
      messages.push({ role: 'tool', tool_call_id: call.id, content: out });
      if (st.finished) break;
    }
  }

  // The harness's own gate: the final craft must have passed a test the harness ran.
  if (st.craft && st.testedJson !== JSON.stringify(st.craft) && st.tests < maxTests + 2 && connectivityErrors(st.craft).length === 0) await test();
  const pick = st.lastReport?.passed && st.testedJson === JSON.stringify(st.craft) ? { craft: st.craft!, report: st.lastReport } : st.passed ?? st.best;
  if (!pick) throw new Error('The agent never produced a craft that could be flight-tested. Try another model.');
  return {
    craft: pick.craft,
    name: st.finished?.name ?? pick.craft.name,
    notes: st.finished?.notes ?? '',
    report: pick.report,
    attempts,
    model: [...models].join(' + ') || req.model,
    prompt: req.prompt,
    cost,
  };
}
