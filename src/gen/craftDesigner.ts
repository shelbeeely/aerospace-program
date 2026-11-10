import { BLIMP, HELICOPTER, QUADCOPTER } from '../craft/builtins.ts';
import { LIGHT_CYCLE } from '../craft/lightCycle.ts';
import { LIGHT_CAR } from '../craft/lightCar.ts';
import { TANK } from '../craft/tank.ts';
import { BODY_COOL, BODY_WARM, LIGHTS } from '../craft/style1982.ts';
import { JET } from '../craft/jet.ts';
import { ORBITER } from '../craft/orbiter.ts';
import { TEST_PLANE } from '../craft/testPlane.ts';
import { TWIN_PLANE } from '../craft/twinPlane.ts';
import type { CraftDef } from '../craft/types.ts';
import { validateCraft } from '../craft/validate.ts';
import { connectivityErrors } from '../craft/connectivity.ts';
import { autoFix } from './autofix.ts';
import { TUNING } from '../tuning.ts';
import { PLANET } from '../sim/layout.ts';
import { flightTest, formatReport, type FlightReport } from '../sim/flightTest.ts';
import { extractJson, type ChatMessage, type OpenRouter } from './openrouter.ts';
import { detailCraft } from './detailer.ts';
import { assertNotAgenticOnly, isAgenticOnly } from './catalog.ts';

/**
 * The spec a designer model gets. It documents the craft format and the physics conventions
 * the sim actually uses, so a model can reason about where to put things.
 */
export const DESIGNER_SYSTEM_PROMPT = `You are a vehicle designer for a physics sandbox game set inside a 1982-style digital world. You design craft (airplanes, jets, spaceplanes, multirotor drones, helicopters, blimps, and ground vehicles: light cycles, cars, tanks, crawlers, walkers-on-wheels, anything that drives) as JSON part graphs. The game simulates them with real rigid-body physics, per-surface aerodynamics, blade-element rotors, buoyancy, wind, fuel burn and structural failure, so a badly balanced design really flies badly. Nothing is scripted.

## Coordinates and units
SI units: metres, kilograms, newtons, degrees. Craft-local axes: +X = right, +Y = up, -Z = FORWARD (the nose points toward -Z, the tail is at +Z). The origin is arbitrary; the ground is flat.

## Format
{ "name": string, "formatVersion": 1, "parts": Part[] }
Part = {
  "id": unique string, "kind": free-text label, "mass": kg (>0),
  "position": [x,y,z] (centre of the part), "rotationDeg"?: [x,y,z] Euler XYZ degrees,
  "shape": {"type":"box","size":[x,y,z]} | {"type":"cylinder","radius":r,"length":l,"axis":"x"|"y"|"z"} | {"type":"sphere","radius":r} | {"type":"cone","radius":r,"length":l,"axis":"x"|"y"|"z","tip"?:-1|1} | {"type":"capsule","radius":r,"length":l,"axis":"x"|"y"|"z"},
    (cone: base radius r, tip at the axis's negative end by default, so a "z" cone is a forward-pointing nose; "tip":1 flips it (a rear nozzle or tail cone). capsule: a cylinder with rounded ends, length is overall, at least 2r: smooth fuselages, pods, tanks. All shapes collide, take damage and render.)
  "collider"?: boolean (default true; set false for thin landing-gear legs),
  "color": CSS hex colour,
  "modules"?: Module[],
  "strength"?: N (load before the part breaks off; omit for a sensible default; 0 = unbreakable),
  "hp"?: J (impact energy the part absorbs before breaking off in a collision; omit for a default from mass and size; 0 = indestructible),
  "reinforce"?: 0-3 (structural reinforcement level; each level adds 15% to the part's mass, 60% to its strength and 80% to its impact HP)
}
Mass and inertia come ONLY from part masses and shapes. Modules are massless and attach to their part, so a part's mass must cover what it carries. The game enforces floors and raises a part that is too light: jets weigh at least thrust/(8g), propeller engines thrust/(4g), rockets thrust/(100g), ramjets thrust/(15g), scramjets thrust/(10g); a solid booster holds its propellant (thrust × burnTime / (isp × g), +15% casing); batteries at most 250 Wh/kg; airbrakes ~4 kg/m² of panel; weapons and their rounds (see Weapon). Each module "offset" is relative to the part origin, in the part's rotated frame.

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
   - Turbojet ("kind":"turbojet"): a turbofan with no bypass: keeps thrust to ~Mach 3-4 (afterburner allowed), thirstier. The fast jet engine.
   - Ramjet ("kind":"ramjet"): NO static thrust. Works from ~Mach 0.5, full thrust at Mach 2.5-4 (maxThrust is that thrust at sea-level density; it scales with air density), gone by Mach 6. Needs a booster or a jet to get it going. ~2× a turbofan's fuel per newton.
   - Scramjet ("kind":"scramjet"): nothing below ~Mach 3.5, full at Mach 6-9, gone by Mach 12; thrust scales with √(density), so it works high up. Needs a rocket or ramjet stage first.
   - Solid booster ("kind":"solid","burnTime":s): lights when the throttle passes half and then burns at full thrust for burnTime (default 20 s) whatever the throttle; it cannot be shut down. Its propellant is in the part's mass (isp default 250 s). Use it to kick a ramjet up to speed, for a take-off boost, or for a sounding rocket.
   - Thrust vectoring ("gimbalDeg": 0-20, any engine): the nozzle swivels with the pitch and yaw stick (the game picks the direction from the engine's place about the CoM). Gives control with no airflow: rockets, VTOL, very high or very slow flight.
   - Omitting both kind and propMaxSpeed gives a simple jet with flat thrust (density scaling only).
   If the craft has fuel tanks, engines burn fuel and stop when it runs out. Without tanks they run forever.
3. Wheel (raycast suspension): {"type":"wheel","offset"?:[x,y,z],"radius":m,"restLength":m,"stiffness":N/m,"damping":N·s/m,"maxSteerDeg"?:deg,"brakes"?:boolean}
   The offset is the suspension mount. A ray goes straight down (the part's -Y) for restLength+radius, so the lowest wheel point is mount.y - restLength - radius.
   Every collider must stay at least 0.2 m above that lowest point, or the airframe scrapes the ground.
   stiffness ≈ (weight on that wheel in N) / (0.3 × restLength); damping ≈ 0.11 × stiffness.
   Tricycle gear: a steerable nose wheel well ahead of the CoM, and two braked main wheels 0.3-0.8 m BEHIND the CoM, spread laterally (at least 2 m apart for a 10 m span).
   Ground vehicles: "drive":N makes the wheel driven (the throttle pushes it along the ground with up to N newtons; reverse is automatic). "skid":1|-1 (the wheel's side, +1 right) gives tank-style skid steering: the yaw channel drives the two sides in opposite directions, so it turns on the spot.
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

13. Stabilizer: {"type":"stabilizer","offset"?:[x,y,z],"strength":N·m/rad}. A gyro that keeps a two-wheeler upright and leaning into turns. REQUIRED on light cycles and any two-wheel vehicle; strength ≈ 10 × the craft mass.
14. Light trail: {"type":"trail","offset"?:[x,y,z],"kind":"wall"|"contrail","height":m,"color":hex}. "wall": a jetwall of solid light laid from the ground up to height (cycles, cars, tanks: offset at the rear, low). "contrail": a thin energy path (aircraft wingtips). Its colour is the vehicle's circuit colour.

15. Airbrake: {"type":"airbrake","offset"?:[x,y,z],"area":m²,"cd"?:1.2}. Panels that open into the airflow with the brake input (in the air or on the runway): drag = ½ρv²·cd·area. Fast jets need them to slow down and land.
16. Drag chute: {"type":"chute","offset"?:[x,y,z],"cdA":m²,"deploySpeed"?:15,"maxSpeed"?:120,"cutSpeed"?:8}. Packed at the tail; streams out when the brake is pulled between deploySpeed and maxSpeed, cut away below cutSpeed. One use per flight. cdA ~10-40 for a jet, 2-6 for a ground racer.
17. Weapon: {"type":"weapon","offset"?:[x,y,z],"kind":"gun"|"cannon"|"missile"|"bomb"|"laser"|"disc"|"pulse","ammo"?:n}. A weapon fitted to its part, drawn on the craft and fired from where it sits. The offset is the weapon's base; it points along the part's -Z (bomb bays drop straight down) and its barrel reaches forward of the offset (gun 1.1 m, cannon 2.5 m, missile rail 1 m either side, laser 0.5 m, pulse 0.85 m), so keep the barrel clear of the hull. Fit as many as you like: each one adds its own rate of fire (paired guns, two cannons, a missile rail under each wing, two bomb bays). Primary trigger: gun (600 rounds, fast, light), cannon (40 heavy shells), laser (an instant beam of light out to 1.5 km), disc (identity discs that ricochet off structures up to 3 times), pulse (tank bolts that bounce once). Secondary trigger: missile (6 per rail, rocket-boosted), bomb (8 per bay, front-heavy, they pitch nose-down as they fall). Weight per weapon (the part must carry it): gun 40 kg + 0.05 kg/round; cannon 150 + 12/round; missile rail 30 + 60/missile; bomb bay 60 + 250/bomb; laser 60; disc 25 + 4/disc; pulse 80 + 1/bolt. Fighters, gunships and tanks carry weapons; racers and transports usually don't.

## Going fast
- Nothing in the world caps speed below ~4 km/s; drag and engines decide. Wave drag rises steeply from each surface's criticalMach to a peak just past Mach 1, then falls supersonically; bodies roughly double their nose-on drag through Mach 1.
- Thin wings: set "criticalMach" 0.85-0.95 on supersonic surfaces (less wave drag), small span and low aspect ratio (2-3), sharp cone noses and capsule fuselages with "body" cdFront 0.06-0.1.
- Pick the engine for the speed: props to ~150 m/s, turbofans to ~Mach 1, turbojets with afterburner to Mach 2-3, ramjets Mach 2-5 (boosted), scramjets Mach 5-10 high up, rockets anywhere (thirsty). Combined cycles work: a turbojet or solid booster to get a ramjet lit, then a scramjet.
- Carry fuel for it, add airbrakes and a drag chute to get back down, and remember the landing speed: high wing loading means long, fast landings.
- Ground vehicles: top speed comes from drive force against drag; a jet or rocket on a ground racer works too (with a stabilizer and a chute to stop).

## Visual language (enforced by the game)
The world is the original 1982 TRON digital world: monumental, geometric, electronic. Not synthwave, not realistic paint. Vehicles look like programs made of light:
- Bodies are large dark surfaces: near-black, navy, deep blue or desaturated metallic blue (${BODY_COOL.join(', ')}); red-team vehicles use warm near-blacks (${BODY_WARM.join(', ')}).
- Light is selective and means something. Add a few thin accent parts (collider false, a few cm thick, kind "accent light") along edges, canopies, wing leading edges, wheel rims, intakes and nozzles, in ONE circuit colour plus at most one second accent: ${LIGHTS.join(', ')} (cyan, blue, red, orange, amber, white). Never make the whole vehicle glow: lit parts cover under a quarter of its surface.
- The game snaps every colour to this palette and draws dark bodies with dim seams and only light parts glowing, so off-palette colours are wasted.
- Form: strong geometric primitives and clean silhouettes (wedges, slabs, cylinders, spheres, rings of boxes, arches, fins, pods). No stickers, liveries or realistic detailing.

## Structure (enforced by the game)
- The craft is ONE connected piece: every part's shape must overlap or touch another part, and all parts together must form a single connected structure. Nothing floats. Join landing gear, skids, engine pods, rotors and tails to the body with struts, legs, pylons, booms or fairings (they can be light, collider false).
- Every module sits on or within its own part (offsets inside the part's shape, or within a few cm of its surface).
- A design with floating parts is rejected before it is tested.

## Detail (three tiers, as the world's architecture)
Real vehicles in this world read at three scales, so build them that way:
- Primary geometry (2-5 masses): the silhouette. Hull, wings, cabin, tracks, booms.
- Secondary geometry: what makes it a machine. Fairings, intake scoops, nacelle cowls, armour plates layered over the hull, canopy frames, fender arcs over wheels, wheel hubs, struts and braces, fin caps, sensor pods, antenna masts, nozzles and exhaust rings, steps and ledges, chamfers (angled boxes via rotationDeg).
- Tertiary geometry: thin panel seams and light lines (a few cm thick) along edges, around canopies, intakes, nozzles and wheel rims.
Secondary and tertiary parts are usually visual: "collider": false, small mass (0.01-2 kg), no modules, touching the part they decorate. Aim for 30-90 parts on a finished vehicle; the physics parts can stay few. Detail never covers everything: keep large calm surfaces between the details.

## Be inventive
Players want vehicles they have never seen: asymmetric racers, ring-winged fliers, canard deltas, flying wings, tandem-rotor lifters, six-wheeled crawlers, armoured skid-steer haulers, long-wheelbase cycles, hover-style sleds on low wheels. Take the request's concept seriously and give it a distinctive geometric identity, while the physics still works. Do not copy any vehicle from a film or game: invent your own.

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
Ground vehicles:
- Driven wheels with "drive" totalling about 0.3-0.6 × the weight in newtons (more for tanks and climbers); brakes on all wheels.
- Steering: front wheels with maxSteerDeg 25-35 (cars, crawlers), a steered front wheel plus a stabilizer (cycles), or "skid" on every wheel (tanks, haulers: no steered wheels).
- Low centre of mass: track width at least 1.4 × the CoM height, or the vehicle rolls in turns. Two-wheelers need the stabilizer instead.
- Wheels: radius 0.3-0.6 m (bigger for rough ground), restLength 0.15-0.4 m, stiffness ≈ wheel load / (0.3 × restLength), damping ≈ 0.11 × stiffness. Body colliders stay 0.2 m above the lowest wheel point.
- Give every ground vehicle a "trail" module of kind "wall" at the rear (height 1-2.5 m) in its circuit colour, plus a "drag" module (cdA 0.4-3).
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
- Ground vehicle (has driven wheels): rest upright, accelerate to 25 m/s, turn to heading 090, brake to a stop, never tipping over.

## Reference designs (each flies well and scores 100/100 on its test card)
Airplane: ${JSON.stringify(TEST_PLANE)}

Light twin: ${JSON.stringify(TWIN_PLANE)}

Jet trainer: ${JSON.stringify(JET)}

Spaceplane (rocket + RCS, reaches orbit): ${JSON.stringify(ORBITER)}

Quadcopter: ${JSON.stringify(QUADCOPTER)}

Helicopter: ${JSON.stringify(HELICOPTER)}

Blimp: ${JSON.stringify(BLIMP)}

Light cycle (two wheels, stabilizer, jetwall): ${JSON.stringify(LIGHT_CYCLE)}

Light car (front steering, rear drive): ${JSON.stringify(LIGHT_CAR)}

Tank (skid steering, heavy, armoured): ${JSON.stringify(TANK)}

## Your output
Reply with ONLY a JSON object: {"name": string, "notes": "one or two sentences on the design intent and balance", "craft": <the full craft object>}.
Every reply must contain the COMPLETE craft, not a diff.`;

export interface DesignAttempt {
  iteration: number;
  /** Which job did this round, and which model actually answered (may be a fallback). */
  role: 'designer' | 'engineer' | 'detailer';
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
  /**
   * After a design passes: a detail round where the designer adds visual secondary/tertiary
   * geometry (physics kept exactly as tested, re-flown, kept only if it still passes). Default true.
   */
  detail?: boolean;
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
  assertNotAgenticOnly(req.model, 'the fixed design rounds');
  if (req.engineerModel) assertNotAgenticOnly(req.engineerModel, 'the Engineer');
  const emit = req.onEvent ?? (() => {});
  const maxIterations = req.maxIterations ?? 3;
  const drafts = Math.max(1, Math.min(4, Math.round(req.drafts ?? 1)));
  // Agentic-only endpoints never ride along as backups for one-shot calls.
  const clean = (l?: string[]) => l?.filter((m) => !isAgenticOnly(m));
  req = { ...req, designerFallbacks: clean(req.designerFallbacks), engineerFallbacks: clean(req.engineerFallbacks) };
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
    // One connected piece: no floating parts, every module on its own part.
    if (!errors.length) errors.push(...connectivityErrors(parsed.craft as CraftDef));
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
      // The designer gets room to be inventive; engineers stay precise.
      attemptOnce(i, role, n > 1 ? 0.45 + 0.25 * k : role === 'designer' ? 0.7 : 0.35, n > 1 ? ` (draft ${k + 1}/${n})` : '')));
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
  if (req.detail !== false && best.report.passed) {
    emit({ type: 'status', message: `Detailing "${best.name}"…` });
    const attempt: DesignAttempt = { iteration: attempts.length + 1, role: 'detailer', cost: 0 };
    attempts.push(attempt);
    try {
      const d = await detailCraft(client, {
        model: req.model, fallbacks: req.designerFallbacks, craft: best.craft, concept: req.prompt,
        tester: req.tester, baseReport: best.report, signal: req.signal,
      });
      attempt.model = d.model;
      attempt.cost = d.cost;
      totalCost += d.cost;
      attempt.craft = d.craft;
      attempt.fixes = [`${d.accepted ? `added ${d.added} detail parts` : 'no detail added'}${d.notes.length ? `: ${d.notes.join('; ')}` : ''}`];
      if (d.report) attempt.report = d.report;
      if (d.accepted && d.report) best = { ...best, craft: d.craft, report: d.report };
    } catch (e) {
      if (req.signal?.aborted) throw e;
      attempt.error = `Detail round failed (kept the plain design): ${e instanceof Error ? e.message : e}`;
    }
    emit({ type: 'attempt', attempt });
  }
  best.cost = totalCost;
  best.attempts = attempts;
  // Credit everyone who worked on it, in order (designer first, then engineers/fallbacks).
  best.model = [...new Set(attempts.map((a) => a.model).filter((m): m is string => !!m))].join(' + ') || req.model;
  return best;
}
