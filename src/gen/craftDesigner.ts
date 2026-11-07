import { BLIMP, HELICOPTER, QUADCOPTER } from '../craft/builtins.ts';
import { TEST_PLANE } from '../craft/testPlane.ts';
import type { CraftDef } from '../craft/types.ts';
import { validateCraft } from '../craft/validate.ts';
import { flightTest, formatReport, type FlightReport } from '../sim/flightTest.ts';
import { extractJson, type ChatMessage, type OpenRouter } from './openrouter.ts';

/**
 * The spec a designer model gets. It documents the craft format and the physics conventions
 * the sim actually uses, so a model can reason about where to put things.
 */
export const DESIGNER_SYSTEM_PROMPT = `You are an aircraft designer for a physics sandbox game. You design craft (airplanes, multirotor drones, helicopters, blimps) as JSON part graphs. The game simulates them with real rigid-body physics, per-surface aerodynamics, blade-element rotors, buoyancy, wind, fuel burn and structural failure, so a badly balanced design really flies badly. Nothing is scripted.

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
  "modules"?: Module[],
  "strength"?: N (load before the part breaks off; omit for a sensible default; 0 = unbreakable)
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
2. Engine: {"type":"engine","offset"?:[x,y,z],"maxThrust":N,"propMaxSpeed"?:m/s,"propRadius"?:m,"propDirection"?:1|-1|0,"fuelFlow"?:kg/s,"spoolTime"?:s}
   Thrust acts along the part's -Z (forward) through the module point. For a propeller, propMaxSpeed is the airspeed where thrust fades to zero (80-120 typical). Omit it for jets. Keep propeller tips at least 0.2 m above the ground.
   Propellers make reaction torque and P-factor (a single prop rolls/yaws the craft). Twin engines with opposite propDirection cancel it.
   If the craft has fuel tanks, engines burn fuel and stop when it runs out. Without tanks they run forever.
3. Wheel (raycast suspension): {"type":"wheel","offset"?:[x,y,z],"radius":m,"restLength":m,"stiffness":N/m,"damping":N·s/m,"maxSteerDeg"?:deg,"brakes"?:boolean}
   The offset is the suspension mount. A ray goes straight down (the part's -Y) for restLength+radius, so the lowest wheel point is mount.y - restLength - radius.
   Every collider must stay at least 0.2 m above that lowest point, or the airframe scrapes the ground.
   stiffness ≈ (weight on that wheel in N) / (0.3 × restLength); damping ≈ 0.11 × stiffness.
   Tricycle gear: a steerable nose wheel well ahead of the CoM, and two braked main wheels 0.3-0.8 m BEHIND the CoM, spread laterally (at least 2 m apart for a 10 m span).
4. Drag: {"type":"drag","offset"?:[x,y,z],"cdA":m²}. Quadratic drag (Cd × area) for fuselages, gear and pods.
5. Fuel tank: {"type":"fuel","offset"?:[x,y,z],"capacity":kg,"fill"?:0-1}. The fuel's mass sits at the tank, so burning it moves the CoM. Put tanks near the CoM.
6. Gas cell: {"type":"buoyancy","offset"?:[x,y,z],"volume":m³,"gas"?:"helium"|"hydrogen"|"hot-air"}. Lift = air density × (1 - gas ratio) × volume × g. Helium lifts about 1.06 kg per m³ at sea level, hydrogen 1.14, hot air 0.31.
7. Rotor (blade element): {"type":"rotor","offset"?:[x,y,z],"radius":m,"blades":int,"chord":m,"maxRpm":rpm,"mode":"rpm"|"collective","pitchDeg":deg,"minPitchDeg"?:deg,"twistDeg"?:deg,"spin":1|-1,"cyclicDeg"?:deg,"inputs"?:{"collective":"throttle"|"yaw"},"spoolTime"?:s}
   Thrust is along the part's +Y axis. "spin" 1 = counter-clockwise seen from above; the airframe gets the opposite reaction torque.
   - "rpm" mode (drones): fixed pitch (pitchDeg ≈ 10-14), thrust from motor speed. Diagonal rotors share a spin direction; neighbours are opposite.
   - "collective" mode (helicopters): governed rpm, thrust from blade pitch between minPitchDeg and pitchDeg; cyclicDeg (6-10) tilts the disk.
   - Tail rotor: collective mode, inputs.collective "yaw", symmetric pitch (e.g. minPitchDeg -20, pitchDeg 20), part rotated so +Y points sideways (rotationDeg [0,0,-90] points +Y to +X).
   Keep tip speed (rpm × 2π/60 × radius) under 220 m/s.
8. Flight controller: {"type":"flightController","mode":"multirotor"|"helicopter","maxTiltDeg"?:deg,"maxYawRateDeg"?:deg}. REQUIRED for any rotorcraft. It stabilises attitude and mixes the stick into rotor commands automatically from rotor positions and spin directions. Throttle 0.5 ≈ hover for multirotors.

## Design rules that matter in this sim
Airplanes:
- Pitch stability: the CoM must be AHEAD (more negative z) of the centre of lift, by 10-40% of the mean wing chord. The game computes the centre of lift as the lift-slope × area weighted average of all roughly horizontal surfaces, tail included.
- Thrust/weight 0.4-0.6 for propeller planes, more for jets. Wing loading 30-70 kg/m² (lower = slower takeoff).
- The runway has about 1300 m of ground roll available. The test autopilot rotates at about 1.15 × the stall speed.
- Split each main wing into an inboard and an outboard panel (two aero modules on one wing part, offset along span). Give the outboard panel 2-3° LESS incidence (washout) and put the aileron on it, so the tips stall last.
- Give the wings 2-5° dihedral via the wing part's rotationDeg z (right wing +z, left wing -z) for roll stability.
- Horizontal tail: about 18-25% of wing area, with an arm of about 3× the wing chord behind the wing. Vertical fin: about 8-12% of wing area.
- Wing incidence about +2 to +3.5° (root), tail incidence about -1 to -2°.
- Use realistic masses. An engine is often the heaviest single part; balance it against the tail.
Rotorcraft:
- Put the CoM directly under the rotor (helicopter: under the mast; drone: centred between the rotors).
- Rotor static thrust should be 1.8-2.6 × the weight. Skids (collider parts) at the bottom, spread wider than the CoM height.
- Helicopters need a tail rotor whose thrust cancels the main rotor torque. The flight controller drives it.
Blimps:
- Make total mass about 98-100% of the gas lift (slightly heavy) and put the centre of buoyancy directly above the CoM: heavy gondola low and under the gas.
- Cruciform tail fins with elevators and rudders far aft; the hull's own lift acts forward of its centre and is destabilising.
General:
- Structures break when overloaded: wings at about 8 g of their share of the weight, gear on very hard landings. Don't give tiny surfaces huge control throws.
- At most 60 parts.

## The automated flight test (pick the vehicle type that fits the request)
- Airplane: rest on the runway, take off, climb to 140 m, turn 90°, fly hands-off.
- Rotorcraft (has rotors + flight controller): lift off, hover 10 m, climb to 50 m, fly forward 150 m, yaw 90°, land softly.
- Lighter-than-air (gas lifts >70% of the weight): rest, climb to 60 m under power, turn 90° with the rudder, fly hands-off.

## Reference designs (each flies well and scores 100/100 on its test card)
Airplane: ${JSON.stringify(TEST_PLANE)}

Quadcopter: ${JSON.stringify(QUADCOPTER)}

Helicopter: ${JSON.stringify(HELICOPTER)}

Blimp: ${JSON.stringify(BLIMP)}

## Your output
Reply with ONLY a JSON object: {"name": string, "notes": "one or two sentences on the design intent and balance", "craft": <the full craft object>}.
Every reply must contain the COMPLETE craft, not a diff.`;

export interface DesignAttempt {
  iteration: number;
  /** Which job did this round, and which model actually answered (may be a fallback). */
  role: 'designer' | 'engineer';
  model?: string;
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
  /** Designer: writes the first draft. */
  model: string;
  /** Engineer: does the repair rounds. Defaults to the designer model. */
  engineerModel?: string;
  /** Backup models per job (OpenRouter fails over to them on rate limits). */
  designerFallbacks?: string[];
  engineerFallbacks?: string[];
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

  let engineerStuck = false;
  for (let i = 1; i <= maxIterations; i++) {
    // Round 1 is the designer's draft; later rounds are the engineer fixing reported problems.
    // If the engineer couldn't produce usable JSON, the designer takes the next round back.
    const role = i === 1 || engineerStuck ? 'designer' : 'engineer';
    const model = role === 'designer' ? req.model : (req.engineerModel ?? req.model);
    const fallbacks = role === 'designer' ? req.designerFallbacks : req.engineerFallbacks;
    emit({ type: 'status', message: `${role === 'designer' ? 'Designer' : 'Engineer'} (${model}) working, round ${i}/${maxIterations}…` });
    const attempt: DesignAttempt = { iteration: i, role, cost: 0 };
    attempts.push(attempt);
    let reply: string;
    let reasoning = '';
    try {
      const res = await client.chat({
        model,
        fallbacks,
        messages,
        format: 'json',
        temperature: 0.4,
        maxTokens: 16000,
        // Designers get room to think; engineers make targeted fixes and must not run out of
        // tokens mid-JSON (free reasoning models will happily think for 40K characters).
        reasoningEffort: role === 'designer' ? 'medium' : 'low',
        signal: req.signal,
      });
      reply = res.content;
      reasoning = res.reasoning;
      attempt.model = res.model;
      attempt.cost = res.usage.cost;
      totalCost += res.usage.cost;
    } catch (e) {
      attempt.error = e instanceof Error ? e.message : String(e);
      emit({ type: 'attempt', attempt });
      if (best) break;
      throw e;
    }
    let parsed: ReturnType<typeof normalize>;
    try {
      try {
        parsed = normalize(extractJson(reply));
      } catch (e) {
        // Some models leave the answer in their reasoning when the visible reply is empty.
        if (!reasoning) throw e;
        parsed = normalize(extractJson(reasoning));
        reply = JSON.stringify({ name: parsed.name, notes: parsed.notes, craft: parsed.craft });
      }
      messages.push({ role: 'assistant', content: reply });
      engineerStuck = false;
    } catch (e) {
      attempt.error = `Could not parse JSON${reply ? "" : reasoning ? " (answer was only in its reasoning, and malformed)" : " (empty reply)"}: ${e instanceof Error ? e.message : e}`;
      emit({ type: 'attempt', attempt });
      // Don't leave an empty assistant turn in the thread; hand the next round to the designer.
      if (role === 'engineer') engineerStuck = true;
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
  // Credit everyone who worked on it, in order (designer first, then engineers/fallbacks).
  best.model = [...new Set(attempts.map((a) => a.model).filter((m): m is string => !!m))].join(' + ') || req.model;
  return best;
}
