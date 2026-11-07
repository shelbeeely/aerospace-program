import { TEST_PLANE } from '../craft/testPlane.ts';
import type { CraftDef } from '../craft/types.ts';
import { validateCraft } from '../craft/validate.ts';
import { flightTest, formatReport, type FlightReport } from '../sim/flightTest.ts';
import { extractJson, type ChatMessage, type OpenRouter } from './openrouter.ts';

/**
 * The spec a designer model gets. It documents the craft format and the physics conventions
 * the sim actually uses, so a model can reason about where to put things.
 */
export const DESIGNER_SYSTEM_PROMPT = `You are an aircraft designer for a physics sandbox game. You design craft as JSON part graphs. The game simulates them with real rigid-body physics and per-surface aerodynamics, so a badly balanced design really flies badly. Nothing is scripted.

## Coordinates and units
SI units: metres, kilograms, newtons, degrees. Craft-local axes: +X = right, +Y = up, -Z = FORWARD (the nose points toward -Z, the tail is at +Z). The origin is arbitrary; the ground is flat.

## Format
{ "name": string, "formatVersion": 1, "parts": Part[] }
Part = {
  "id": unique string, "kind": free-text label, "mass": kg (>0),
  "position": [x,y,z] (centre of the part), "rotationDeg"?: [x,y,z] Euler XYZ degrees,
  "shape": {"type":"box","size":[x,y,z]} | {"type":"cylinder","radius":r,"length":l,"axis":"x"|"y"|"z"} | {"type":"sphere","radius":r},
  "collider"?: boolean (default true; set false for thin landing-gear legs),
  "color": CSS hex colour,
  "modules"?: Module[]
}
Mass and inertia come ONLY from part masses and shapes. Modules are massless and attach to their part. Each module "offset" is relative to the part origin, in the part's rotated frame.

## Modules
1. Lifting surface: {"type":"aero","offset"?:[x,y,z],"span":m,"chord":m,"aspectRatio"?:number,"incidenceDeg"?:deg,"control"?:Control}
   The surface frame is the part's frame: chord along -Z (leading edge forward), lift normal +Y, span along +X. The offset is the aerodynamic centre (quarter chord).
   Lift slope comes from the aspect ratio (default span²/area). For half-wings or wing panels, set aspectRatio to the WHOLE wing's value (e.g. 6-8).
   Soft stall at about 15° angle of attack.
   Control = {"channel":"pitch"|"roll"|"yaw","maxDeflectionDeg":0-60,"gain":1|-1,"chordFraction"?:0.2-0.4,"spanFraction"?:0-1}
   Positive (gain × input) adds lift along the surface normal. Pilot inputs: pitch +1 = nose up, roll +1 = roll right, yaw +1 = nose right. So:
   - Elevator on a tail BEHIND the CoM: channel "pitch", gain -1. (A canard AHEAD of the CoM: gain +1.)
   - Ailerons: LEFT wing (x<0) gain +1, RIGHT wing (x>0) gain -1.
   - Vertical fin: give the part "rotationDeg":[0,0,90] (span then points up, normal points left, -X). Rudder: channel "yaw", gain +1 when the fin is behind the CoM.
2. Engine: {"type":"engine","offset"?:[x,y,z],"maxThrust":N,"propMaxSpeed"?:m/s,"propRadius"?:m,"spoolTime"?:s}
   Thrust acts along the part's -Z (forward) through the module point. For a propeller, propMaxSpeed is the airspeed where thrust fades to zero (80-120 typical). Omit it for jets. Keep propeller tips at least 0.2 m above the ground.
3. Wheel (raycast suspension): {"type":"wheel","offset"?:[x,y,z],"radius":m,"restLength":m,"stiffness":N/m,"damping":N·s/m,"maxSteerDeg"?:deg,"brakes"?:boolean}
   The offset is the suspension mount. A ray goes straight down (the part's -Y) for restLength+radius, so the lowest wheel point is mount.y - restLength - radius.
   Every collider must stay at least 0.2 m above that lowest point, or the airframe scrapes the ground.
   stiffness ≈ (weight on that wheel in N) / (0.3 × restLength); damping ≈ 0.11 × stiffness.
   Tricycle gear: a steerable nose wheel well ahead of the CoM, and two braked main wheels 0.3-0.8 m BEHIND the CoM, spread laterally (at least 2 m apart for a 10 m span).
4. Drag: {"type":"drag","offset"?:[x,y,z],"cdA":m²}. Quadratic drag (Cd × area) for fuselages, gear and pods.

## Design rules that matter in this sim
- Pitch stability: the CoM must be AHEAD (more negative z) of the centre of lift, by 10-40% of the mean wing chord. The game computes the centre of lift as the lift-slope × area weighted average of all roughly horizontal surfaces, tail included.
- Thrust/weight 0.4-0.6 for propeller planes, more for jets. Wing loading 30-70 kg/m² (lower = slower takeoff).
- The runway has about 1300 m of ground roll available. The test autopilot rotates at about 1.15 × the stall speed.
- Split each main wing into an inboard and an outboard panel (two aero modules on one wing part, offset along span). Give the outboard panel 2-3° LESS incidence (washout) and put the aileron on it, so the tips stall last.
- Give the wings 2-5° dihedral via the wing part's rotationDeg z (right wing +z, left wing -z) for roll stability.
- Horizontal tail: about 18-25% of wing area, with an arm of about 3× the wing chord behind the wing. Vertical fin: about 8-12% of wing area.
- Wing incidence about +2 to +3.5° (root), tail incidence about -1 to -2°.
- Use realistic masses. An engine is often the heaviest single part; balance it against the tail.
- At most 60 parts.

## Reference design (flies well, scores 100/100 in the flight test)
${JSON.stringify(TEST_PLANE)}

## Your output
Reply with ONLY a JSON object: {"name": string, "notes": "one or two sentences on the design intent and balance", "craft": <the full craft object>}.
Every reply must contain the COMPLETE craft, not a diff.`;

export interface DesignAttempt {
  iteration: number;
  craft?: CraftDef;
  validationErrors?: string[];
  report?: FlightReport;
  error?: string;
  cost: number;
}

export type DesignEvent =
  | { type: 'status'; message: string }
  | { type: 'attempt'; attempt: DesignAttempt };

export interface DesignRequest {
  model: string;
  prompt: string;
  /** Existing craft to modify (refinement). */
  base?: CraftDef;
  /** Extra feedback, e.g. the player's notes from a test flight. */
  feedback?: string;
  /** Total model calls allowed, including repairs (default 3). */
  maxIterations?: number;
  onEvent?: (e: DesignEvent) => void;
  signal?: AbortSignal;
}

export interface DesignResult {
  craft: CraftDef;
  name: string;
  notes: string;
  report: FlightReport;
  attempts: DesignAttempt[];
  model: string;
  prompt: string;
  cost: number;
}

function normalize(raw: unknown): { craft: unknown; name?: string; notes?: string } {
  if (typeof raw !== 'object' || raw === null) return { craft: raw };
  const r = raw as Record<string, unknown>;
  if ('craft' in r) {
    const craft = r.craft as Record<string, unknown> | null;
    if (craft && typeof craft === 'object') {
      craft.formatVersion = 1;
      craft.name ??= r.name;
    }
    return { craft, name: r.name as string, notes: r.notes as string };
  }
  if ('parts' in r) {
    r.formatVersion = 1;
    return { craft: r, name: r.name as string };
  }
  return { craft: raw };
}

/**
 * Generate (or refine) a craft. Generate, validate, flight-test, then feed problems back to
 * the model until it passes or the budget runs out. Returns the best design seen.
 */
export async function designCraft(client: OpenRouter, req: DesignRequest): Promise<DesignResult> {
  const emit = req.onEvent ?? (() => {});
  const maxIterations = req.maxIterations ?? 3;
  const messages: ChatMessage[] = [{ role: 'system', content: DESIGNER_SYSTEM_PROMPT }];

  let userMsg = req.base
    ? `Modify this existing craft:\n${JSON.stringify(req.base)}\n\nRequested change: ${req.prompt}`
    : `Design this craft: ${req.prompt}`;
  if (req.feedback) userMsg += `\n\nFeedback from the last test flight:\n${req.feedback}`;
  messages.push({ role: 'user', content: userMsg });

  const attempts: DesignAttempt[] = [];
  let best: DesignResult | null = null;
  let totalCost = 0;

  for (let i = 1; i <= maxIterations; i++) {
    emit({ type: 'status', message: `Asking ${req.model} (round ${i}/${maxIterations})…` });
    const attempt: DesignAttempt = { iteration: i, cost: 0 };
    attempts.push(attempt);
    let reply: string;
    try {
      const res = await client.chat({
        model: req.model,
        messages,
        format: 'json',
        temperature: 0.4,
        maxTokens: 16000,
        signal: req.signal,
      });
      reply = res.content;
      attempt.cost = res.usage.cost;
      totalCost += res.usage.cost;
    } catch (e) {
      attempt.error = e instanceof Error ? e.message : String(e);
      emit({ type: 'attempt', attempt });
      if (best) break;
      throw e;
    }
    messages.push({ role: 'assistant', content: reply });

    let parsed: ReturnType<typeof normalize>;
    try {
      parsed = normalize(extractJson(reply));
    } catch (e) {
      attempt.error = `Could not parse JSON: ${e instanceof Error ? e.message : e}`;
      emit({ type: 'attempt', attempt });
      messages.push({ role: 'user', content: `${attempt.error}. Reply with ONLY the JSON object described in the instructions.` });
      continue;
    }

    const errors = validateCraft(parsed.craft);
    if (errors.length) {
      attempt.validationErrors = errors;
      emit({ type: 'attempt', attempt });
      messages.push({
        role: 'user',
        content: `The craft failed validation:\n${errors.slice(0, 30).join('\n')}\nFix these and reply with the complete corrected JSON.`,
      });
      continue;
    }
    const craft = parsed.craft as CraftDef;
    attempt.craft = craft;

    emit({ type: 'status', message: `Flight-testing "${craft.name}"…` });
    let report: FlightReport;
    try {
      report = await flightTest(craft, { yieldEvery: 1500 });
    } catch (e) {
      attempt.error = `Simulation error: ${e instanceof Error ? e.message : e}`;
      emit({ type: 'attempt', attempt });
      messages.push({ role: 'user', content: `${attempt.error}. Fix the design and reply with the complete JSON.` });
      continue;
    }
    attempt.report = report;
    emit({ type: 'attempt', attempt });

    if (!best || report.score > best.report.score) {
      best = {
        craft,
        name: parsed.name ?? craft.name,
        notes: parsed.notes ?? '',
        report,
        attempts,
        model: req.model,
        prompt: req.prompt,
        cost: totalCost,
      };
    }
    if (report.passed) break;
    messages.push({
      role: 'user',
      content: `Automated flight test results:\n${formatReport(report)}\n\nFix the issues while keeping the requested concept. Reply with the complete corrected JSON.`,
    });
  }

  if (!best) throw new Error('The model never produced a valid craft. Try another model or a simpler request.');
  best.cost = totalCost;
  best.attempts = attempts;
  return best;
}
