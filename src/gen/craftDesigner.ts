import { BLIMP, HELICOPTER, QUADCOPTER } from '../craft/builtins.ts';
import { JET } from '../craft/jet.ts';
import { ORBITER } from '../craft/orbiter.ts';
import { TEST_PLANE } from '../craft/testPlane.ts';
import { TWIN_PLANE } from '../craft/twinPlane.ts';
import type { CraftDef } from '../craft/types.ts';
import { validateCraft } from '../craft/validate.ts';
import { autoFix } from './autofix.ts';
import { TUNING } from '../tuning.ts';
import { PLANET } from '../sim/layout.ts';
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
  "strength"?: N (load before the part breaks off; omit for a sensible default; 0 = unbreakable),
  "hp"?: J (impact energy the part absorbs before breaking off in a collision; omit for a default from mass and size; 0 = indestructible),
  "reinforce"?: 0-3 (structural reinforcement level; each level adds 15% to the part's mass, 60% to its strength and 80% to its impact HP)
}
Mass and inertia come ONLY from part masses and shapes. Modules are massless and attach to their part. Each module "offset" is relative to the part origin, in the part's rotated frame.

## Modules
1. Lifting surface: {"type":"aero","offset"?:[x,y,z],"span":m,"chord":m,"aspectRatio"?:number,"incidenceDeg"?:deg,"camberDeg"?:deg,"cm0"?:number,"criticalMach"?:number,"control"?:Control}
   The surface frame is the part's frame: chord along -Z (leading edge forward), lift normal +Y, span along +X. The offset is the aerodynamic centre (quarter chord).
   Lift slope comes from the aspect ratio (default span²/area). For half-wings or wing panels, set aspectRatio to the WHOLE wing's value (e.g. 6-8).
   Soft stall at about 15° angle of attack (lagged: dynamic stall). camberDeg (0-4 for wings, 0 for tails/fins) = zero-lift angle shift of a cambered airfoil; it adds lift at zero incidence and a nose-down pitching moment (cm0 defaults from it). Small or slow surfaces (low Reynolds number) stall earlier and have more drag; rain and ice make that worse.
   Surfaces behind a wing sit in its downwash, so a tail feels less angle of attack than the wing.
   Control = {"channel":"pitch"|"roll"|"yaw"|"flaps","maxDeflectionDeg":0-60,"gain":1|-1,"chordFraction"?:0.2-0.4,"spanFraction"?:0-1}
   Positive (gain × input) adds lift along the surface normal. Pilot inputs: pitch +1 = nose up, roll +1 = roll right, yaw +1 = nose right. So:
   - Elevator on a tail BEHIND the CoM: channel "pitch", gain -1. (A canard AHEAD of the CoM: gain +1.)
   - Ailerons: LEFT wing (x<0) gain +1, RIGHT wing (x>0) gain -1.
   - Flaps: channel "flaps", gain 1, maxDeflectionDeg 30, on the INBOARD wing panels (trailing edge, chordFraction 0.25). The pilot lowers them in 3 notches.
   - Vertical fin: give the part "rotationDeg":[0,0,90] (span then points up, normal points left, -X). Rudder: channel "yaw", gain +1 when the fin is behind the CoM.
2. Engine: {"type":"engine","offset"?:[x,y,z],"maxThrust":N,"kind"?:"prop"|"turbofan"|"rocket","propMaxSpeed"?:m/s,"propRadius"?:m,"propDirection"?:1|-1|0,"bypassRatio"?:number,"afterburner"?:{"thrustRatio":number,"fuelRatio":number},"isp"?:s,"rcsTorque"?:N·m,"fuelFlow"?:kg/s,"spoolTime"?:s}
   Thrust acts along the part's -Z (forward) through the module point. maxThrust is the static sea-level thrust.
   - Propeller ("kind":"prop" or just set propMaxSpeed): propMaxSpeed is the airspeed where thrust fades to zero (80-130 typical). Keep propeller tips at least 0.2 m above the ground. Thrust scales with air density.
     Propellers make reaction torque and P-factor (a single prop rolls/yaws the craft). Twin engines with opposite propDirection (counter-rotating: left 1, right -1) cancel it.
   - Turbofan ("kind":"turbofan", NO propMaxSpeed/propDirection/propRadius): thrust = maxThrust × σ^${TUNING.turbofanDensityExponent} × (1 - ${TUNING.turbofanMachLapse}·M·(1+BPR)/(1+0.1·BPR)), σ = density ratio, M = Mach, BPR = bypassRatio (default 1; 0-1 trainers/fighters, 3-5 business jets: more static thrust per fuel but faster lapse with speed). Fuel per newton rises with Mach. Expect ~30% of static thrust at Mach 0.8 and 10 km. spoolTime 1-3 s for jets.
     afterburner (optional, turbofan only): above ${Math.round(TUNING.afterburnerThrottle * 100)}% throttle once spooled up, thrust × thrustRatio (1.3-1.7) and fuel flow × fuelRatio (3-5). Great for takeoff and climb, very thirsty.
   - Rocket ("kind":"rocket", NO propeller fields): carries its own oxidiser, so thrust = maxThrust × throttle at any altitude, in vacuum too. Propellant flow = maxThrust / (isp × ${TUNING.standardGravity}) kg/s at full power (isp default ${TUNING.rocketDefaultIsp} s; ~250-320 kerosene/solid, ~450 hydrogen): about 10× a jet's burn, so give rocket craft big tanks. Ignition is quick (spoolTime default ${TUNING.rocketSpoolTime} s).
   - Reaction control ("rcsTorque", any engine, usually the rocket): thrusters that turn the craft from the pitch/roll/yaw stick with up to rcsTorque N·m per axis, burning a little fuel. Rate-command: full stick asks for ${TUNING.rcsMaxRate} rad/s, a centred stick holds the attitude still. Full authority below ${TUNING.rcsFullQ} Pa of dynamic pressure, fading out by ${TUNING.rcsFadeQ} Pa, where the control surfaces take over (they lose authority in thin air). ~1-2 N·m per kg of craft turns a spaceplane briskly.
   - Orbits: the planet is small (radius ${PLANET.radius} m, surface gravity ${PLANET.gravity} m/s²). Orbital speed is ~${Math.round(Math.sqrt(PLANET.gravity * PLANET.radius))} m/s at the surface but ~${Math.round(Math.sqrt((PLANET.gravity * PLANET.radius ** 2) / (PLANET.radius + 40000)))} m/s at 40 km, where the air is thin enough to stay up. A spaceplane needs a rocket, RCS, and wings and gear to land; climb steeply out of the thick air, then build horizontal speed and circularise at the apoapsis.
   - Omitting both kind and propMaxSpeed gives a simple jet with flat thrust (density scaling only).
   If the craft has fuel tanks, engines burn fuel and stop when it runs out. Without tanks they run forever.
3. Wheel (raycast suspension): {"type":"wheel","offset"?:[x,y,z],"radius":m,"restLength":m,"stiffness":N/m,"damping":N·s/m,"maxSteerDeg"?:deg,"brakes"?:boolean}
   The offset is the suspension mount. A ray goes straight down (the part's -Y) for restLength+radius, so the lowest wheel point is mount.y - restLength - radius.
   Every collider must stay at least 0.2 m above that lowest point, or the airframe scrapes the ground.
   stiffness ≈ (weight on that wheel in N) / (0.3 × restLength); damping ≈ 0.11 × stiffness.
   Tricycle gear: a steerable nose wheel well ahead of the CoM, and two braked main wheels 0.3-0.8 m BEHIND the CoM, spread laterally (at least 2 m apart for a 10 m span).
4. Drag: {"type":"drag","offset"?:[x,y,z],"cdA":m²}. Quadratic drag (Cd × area) for gear, struts and small pods.
4b. Slender body: {"type":"body","offset"?:[x,y,z],"length":m,"diameter":m,"cdFront"?:number}. Use for fuselages, nacelles and hulls (axis along the part's Z). Gives nose-on drag, crossflow drag when yawed/pitched, and the destabilising Munk moment that the tail has to overcome. cdFront ≈ 0.1 streamlined, 0.25 boxy.
5. Fuel tank: {"type":"fuel","offset"?:[x,y,z],"capacity":kg,"fill"?:0-1}. The fuel's mass sits at the tank, so burning it moves the CoM. Put tanks near the CoM.
6. Gas cell: {"type":"buoyancy","offset"?:[x,y,z],"volume":m³,"gas"?:"helium"|"hydrogen"|"hot-air"}. Lift = air density × (1 - gas ratio) × volume × g. Helium lifts about 1.06 kg per m³ at sea level, hydrogen 1.14, hot air 0.31.
7. Rotor (blade element): {"type":"rotor","offset"?:[x,y,z],"radius":m,"blades":int,"chord":m,"maxRpm":rpm,"mode":"rpm"|"collective","pitchDeg":deg,"minPitchDeg"?:deg,"twistDeg"?:deg,"spin":1|-1,"cyclicDeg"?:deg,"inputs"?:{"collective":"throttle"|"yaw"},"spoolTime"?:s}
   Thrust is along the part's +Y axis. "spin" 1 = counter-clockwise seen from above; the airframe gets the opposite reaction torque.
   - "rpm" mode (drones): fixed pitch (pitchDeg ≈ 10-14), thrust from motor speed. Diagonal rotors share a spin direction; neighbours are opposite.
   - "collective" mode (helicopters): governed rpm, thrust from blade pitch between minPitchDeg and pitchDeg; cyclicDeg (6-10) tilts the disk.
   - Tail rotor: collective mode, inputs.collective "yaw", symmetric pitch (e.g. minPitchDeg -20, pitchDeg 20), part rotated so +Y points sideways (rotationDeg [0,0,-90] points +Y to +X).
   Keep tip speed (rpm × 2π/60 × radius) under 220 m/s.
   Motors/engines are sized from the rotor itself with ~15-25% torque margin at full rpm. Rain, ice and heavy loads eat that margin. Rotors get ground effect near the surface and lose thrust in vortex ring state (fast vertical descent).
8. Flight controller: {"type":"flightController","mode":"multirotor"|"helicopter","maxTiltDeg"?:deg,"maxYawRateDeg"?:deg}. REQUIRED for any rotorcraft. It stabilises attitude and mixes the stick into rotor commands automatically from rotor positions and spin directions. Throttle 0.5 ≈ hover for multirotors.
9. Battery: {"type":"battery","offset"?:[x,y,z],"cells":int,"capacityAh":Ah,"cellResistance":Ω,"cellVmax":V,"cellVmin":V,"thermalMass"?:J/K,"maxTempC"?:°C}. Voltage sags by I·R under load and the pack heats by I²R; it cuts off when a cell drops below cellVmin under load or it overheats. LiPo: cellVmax 4.2, cellVmin 3.3, cellResistance 0.002-0.005, ~150 Wh/kg (include its mass in the part). Lead-acid aircraft battery: 12 cells (24 V), 2.13/1.85, 0.003-0.005.
10. Motor: {"type":"motor","kv":rpm/V,"rWinding":Ω,"maxCurrent":A}. Electric motor for the rotor ON THE SAME PART (one per part); needs a battery on the craft. Torque = 60/(2π·kv) × current, current = (V − rpm/kv)/R limited to maxCurrent. Pick kv so kv × pack voltage ≈ 1.25-1.35 × maxRpm (e.g. 12S LiPo ≈ 44 V, 4500 rpm → kv 130), rWinding 0.03-0.1 Ω for heavy lifters, maxCurrent ~1.7× the current at full thrust. Without a motor module, a rotor gets an idealised motor/engine sized automatically.
11. Generator: {"type":"generator","ratedAmps":A,"minRpmFraction"?:0-1}. Alternator driven by the engine on its part (else the first engine): powers the bus and recharges the battery once the engine is above minRpmFraction (default 0.05).
12. Avionics: {"type":"avionics","loadW":W,"essential"?:bool}. Electrical load. Non-essential loads are shed when no generator is online. If every essential avionics box loses power, the flight controller stops and the instruments go blank, so drones die when the battery cuts off. Battery-powered craft: give them a battery sized for the flight (hover power ≈ 100 W per kg for heavy-lift quads) plus a small essential avionics load.

## Design rules that matter in this sim
Airplanes:
- Pitch stability: the CoM must be AHEAD (more negative z) of the centre of lift, by 10-40% of the mean wing chord. The game computes the centre of lift as the lift-slope × area weighted average of all roughly horizontal surfaces, tail included.
- Thrust/weight (static maxThrust, without afterburner) 0.4-0.6 for propeller planes, 0.5-0.8 for jets. Wing loading 30-70 kg/m² for light props (lower = slower takeoff), ~70-90 for light twins, 150-300 for jets (they need the long runway).
- Twins: put the engines in wing nacelles close to the fuselage, props ahead of the leading edge, counter-rotating, with the main gear under the nacelles.
- Jets: engine in the rear fuselage, fuel near the CoM (wings, fuselage over the wing). Make the fuselage, each wing, each tail surface and the engine separate parts so damage is local.
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
- Weather is real: wind, gusts, rain (costs lift and adds water weight), icing in supercooled cloud, thermals and storm downdrafts, wet runways (longer braking, aquaplaning above ~25 m/s). Margins matter.
- Structures break when overloaded: wings at about 8 g of their share of the weight, gear on very hard landings. Don't give tiny surfaces huge control throws.
- At most 200 parts (most good designs need 10-40). For large craft, write compact JSON without extra whitespace so it fits in one reply.

## Damage and crashes
Every part is a grid of 0.25 m voxels. Hard contacts (buildings, the ground, debris) bite voxels out at the contact point; a part keeps its mass, lift and thrust in proportion to the voxels it has left and breaks off below about 35%. A crash that changes the craft's velocity by more than ~30 m/s in a fraction of a second makes it explode (reinforcement raises that a little). Use "reinforce" 1-2 on wing roots, gear and the fuselage of rugged or combat designs, and only where it's worth the weight; most parts need none.

## Before you write the JSON, work out (in your head)
1. Total mass and the CoM (mass-weighted part positions, fuel included).
2. Airplanes: wing area, the centre of lift z, the static margin in mean chords (target 0.1-0.3), wing loading, T/W, stall speed ≈ sqrt(2·W / (1.225 · area · 1.3)).
3. Gear: main wheels 0.3-0.8 m behind the CoM, the nose wheel well ahead, every collider at least 0.2 m above the lowest wheel point, prop tips clear of the ground.
4. Control signs: elevator behind the CoM gain -1, left aileron +1, right aileron -1, fin (rotated [0,0,90]) rudder +1.
5. Rotorcraft: total static thrust 1.8-2.6 × weight, CoM under the rotor(s), tip speed under 220 m/s.

## The automated flight test (pick the vehicle type that fits the request)
- Airplane: rest on the runway, take off, climb to 140 m, turn 90°, fly hands-off.
- Rotorcraft (has rotors + flight controller): lift off, hover 10 m, climb to 50 m, fly forward 150 m, yaw 90°, land softly.
- Lighter-than-air (gas lifts >70% of the weight): rest, climb to 60 m under power, turn 90° with the rudder, fly hands-off.

## Reference designs (each flies well and scores 100/100 on its test card)
Airplane: ${JSON.stringify(TEST_PLANE)}

Light twin: ${JSON.stringify(TWIN_PLANE)}

Jet trainer: ${JSON.stringify(JET)}

Spaceplane (rocket + RCS, reaches orbit): ${JSON.stringify(ORBITER)}

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
  /** Automatic corrections applied before the flight test. */
  fixes?: string[];
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
  /** Sequential rounds: the first draft, then repairs (default 3). */
  maxIterations?: number;
  /** Independent designer drafts in round 1, tested in parallel; the best goes on (default 1). */
  drafts?: number;
  onEvent?: (e: DesignEvent) => void;
  /** How to flight-test a candidate (the browser passes a Web Worker runner). */
  tester?: (craft: CraftDef) => Promise<FlightReport>;
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

/** What came of one model reply. */
type Outcome =
  | { kind: 'error'; api: boolean; message: string }
  | { kind: 'invalid'; reply: string; errors: string[] }
  | { kind: 'simError'; reply: string; message: string }
  | { kind: 'tested'; reply: string; craft: CraftDef; report: FlightReport; fixes: string[]; name?: string; notes?: string };

/**
 * Generate (or refine) a craft. Round 1 asks the designer for `drafts` independent drafts in
 * parallel and keeps the best; each draft is validated, auto-fixed (control signs, wheel
 * springs) and flight-tested. Later rounds hand the test report to the engineer until it passes
 * or the budget runs out. Returns the best design seen.
 */
export async function designCraft(client: OpenRouter, req: DesignRequest): Promise<DesignResult> {
  const emit = req.onEvent ?? (() => {});
  const maxIterations = req.maxIterations ?? 3;
  const drafts = Math.max(1, Math.min(4, Math.round(req.drafts ?? 1)));
  const messages: ChatMessage[] = [{ role: 'system', content: DESIGNER_SYSTEM_PROMPT }];

  let userMsg = req.base
    ? `Modify this existing craft:\n${JSON.stringify(req.base)}\n\nRequested change: ${req.prompt}`
    : `Design this craft: ${req.prompt}`;
  if (req.feedback) userMsg += `\n\nFeedback from the last test flight:\n${req.feedback}`;
  messages.push({ role: 'user', content: userMsg });

  const attempts: DesignAttempt[] = [];
  let best: DesignResult | null = null;
  let totalCost = 0;

  /** One model call → parsed, validated, auto-fixed, flight-tested. */
  const attemptOnce = async (i: number, role: 'designer' | 'engineer', temperature: number, label: string): Promise<{ attempt: DesignAttempt; outcome: Outcome }> => {
    const model = role === 'designer' ? req.model : (req.engineerModel ?? req.model);
    const fallbacks = role === 'designer' ? req.designerFallbacks : req.engineerFallbacks;
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
        temperature,
        // Room for a 200-part craft (~250 tokens a part); clamped to each model's own limit.
        maxTokens: 64000,
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
      if (req.signal?.aborted) throw e;
      return { attempt, outcome: { kind: 'error', api: true, message: attempt.error } };
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
    } catch (e) {
      attempt.error = `Could not parse JSON${reply ? '' : reasoning ? ' (answer was only in its reasoning, and malformed)' : ' (empty reply)'}: ${e instanceof Error ? e.message : e}`;
      emit({ type: 'attempt', attempt });
      return { attempt, outcome: { kind: 'error', api: false, message: attempt.error } };
    }
    const errors = validateCraft(parsed.craft);
    if (errors.length) {
      attempt.validationErrors = errors;
      emit({ type: 'attempt', attempt });
      return { attempt, outcome: { kind: 'invalid', reply, errors } };
    }
    const { craft, fixes } = autoFix(parsed.craft as CraftDef);
    attempt.craft = craft;
    attempt.fixes = fixes;
    emit({ type: 'status', message: `Flight-testing "${craft.name}"${label}…` });
    try {
      const report = await (req.tester ? req.tester(craft) : flightTest(craft, { yieldEvery: 1500 }));
      attempt.report = report;
      emit({ type: 'attempt', attempt });
      return { attempt, outcome: { kind: 'tested', reply, craft, report, fixes, name: parsed.name, notes: parsed.notes } };
    } catch (e) {
      attempt.error = `Simulation error: ${e instanceof Error ? e.message : e}`;
      emit({ type: 'attempt', attempt });
      return { attempt, outcome: { kind: 'simError', reply, message: attempt.error } };
    }
  };

  const rank = (o: Outcome) => (o.kind === 'tested' ? 1000 + o.report.score : o.kind === 'simError' ? 2 : o.kind === 'invalid' ? 1 : 0);

  let engineerStuck = false;
  for (let i = 1; i <= maxIterations; i++) {
    // Round 1 is the designer's draft(s); later rounds are the engineer fixing reported problems.
    // If the engineer couldn't produce usable JSON, the designer takes the next round back.
    const role = i === 1 || engineerStuck ? 'designer' : 'engineer';
    const model = role === 'designer' ? req.model : (req.engineerModel ?? req.model);
    const n = i === 1 ? drafts : 1;
    emit({ type: 'status', message: `${role === 'designer' ? 'Designer' : 'Engineer'} (${model}) working, round ${i}/${maxIterations}${n > 1 ? `, ${n} drafts in parallel` : ''}…` });
    // Parallel drafts vary the temperature so they explore different layouts.
    const results = await Promise.all(Array.from({ length: n }, (_, k) =>
      attemptOnce(i, role, n > 1 ? 0.35 + 0.25 * k : 0.4, n > 1 ? ` (draft ${k + 1}/${n})` : '')));
    const pick = results.reduce((a, b) => (rank(b.outcome) > rank(a.outcome) ? b : a));
    const o = pick.outcome;
    if (o.kind === 'error') {
      if (o.api) {
        // The API failed (every draft, since any other outcome ranks higher): keep what we have.
        if (best) break;
        throw new Error(o.message);
      }
      // Don't leave an empty assistant turn in the thread; hand the next round to the designer.
      if (role === 'engineer') engineerStuck = true;
      continue;
    }
    engineerStuck = false;
    messages.push({ role: 'assistant', content: o.reply });
    if (o.kind === 'invalid') {
      messages.push({ role: 'user', content: `The craft failed validation:\n${o.errors.slice(0, 30).join('\n')}\nFix these and reply with the complete corrected JSON.` });
      continue;
    }
    if (o.kind === 'simError') {
      messages.push({ role: 'user', content: `${o.message}. Fix the design and reply with the complete JSON.` });
      continue;
    }
    if (!best || o.report.score > best.report.score) {
      best = { craft: o.craft, name: o.name ?? o.craft.name, notes: o.notes ?? '', report: o.report, attempts, model: req.model, prompt: req.prompt, cost: totalCost };
    }
    if (o.report.passed) break;
    const fixNote = o.fixes.length
      ? `\n\nBefore testing, these automatic corrections were applied (keep them in your next version):\n${o.fixes.map((f) => `- ${f}`).join('\n')}`
      : '';
    messages.push({
      role: 'user',
      content: `Automated flight test results:\n${formatReport(o.report)}${fixNote}\n\nFix the issues while keeping the requested concept. Reply with the complete corrected JSON.`,
    });
  }

  if (!best) throw new Error('The model never produced a valid craft. Try another model or a simpler request.');
  best.cost = totalCost;
  best.attempts = attempts;
  // Credit everyone who worked on it, in order (designer first, then engineers/fallbacks).
  best.model = [...new Set(attempts.map((a) => a.model).filter((m): m is string => !!m))].join(' + ') || req.model;
  return best;
}
