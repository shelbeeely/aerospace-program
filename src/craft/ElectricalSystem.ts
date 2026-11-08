import { TUNING } from '../tuning.ts';
import { Avionics } from '../modules/Avionics.ts';
import { Battery } from '../modules/Battery.ts';
import { FlightController } from '../modules/FlightController.ts';
import type { ForceModule } from '../modules/ForceModule.ts';
import { Generator } from '../modules/Generator.ts';
import { Motor } from '../modules/Motor.ts';

/** JSON snapshot of the electrical system for telemetry / HUD. */
export interface ElectricalTelemetry {
  /** Bus voltage (V). */
  busVolts: number;
  /** Bus is live (above the avionics drop-out voltage). */
  powered: boolean;
  /** Flight instruments / flight computer have power (essential avionics working). */
  avionics: boolean;
  /** Mean battery state of charge 0..1, or null without a battery. */
  battery: number | null;
  /** Battery terminal voltage (V), current out of the batteries (A, negative = charging). */
  batteryVolts: number | null;
  batteryAmps: number;
  /** Hottest battery (°C), or null. */
  batteryTempC: number | null;
  /** Why a battery is off the bus ('' when all connected). */
  batteryCutoff: '' | 'undervoltage' | 'overheat';
  /** Generator output (A) and whether any generator is producing. */
  generatorAmps: number;
  generatorOnline: boolean;
  /** Total electrical load (W), motors included. */
  loadW: number;
  /** Part ids of burnt-out avionics. */
  failed: string[];
}

/**
 * One DC bus per craft, solved every physics step before the force modules run.
 *
 * Sources: batteries (open-circuit voltage Voc behind internal resistance R, in parallel) and
 * generators (a regulator holding V_reg through a small source resistance, up to the rated
 * current; they never sink current). Loads: constant-power avionics and motors (the motors'
 * power from their last operating point), plus an optional resistive test load. KCL on the bus,
 *   Σ(Voc−V)/R + I_gen(V) = P/V + V/R_load,
 * is a quadratic in V for each generator regime (regulating / current-limited / off); the upper
 * root is the stable operating point. If the sources cannot deliver the load at all, the bus
 * sits at the maximum-power point and the loads are scaled back (brownout).
 *
 * Results: bus voltage, battery currents (SoC, heat, cutoff), which loads have power, and
 * whether the flight controller is powered (an unpowered one commands nothing).
 */
export class ElectricalSystem {
  batteries: Battery[] = [];
  motors: Motor[] = [];
  generators: Generator[] = [];
  avionics: Avionics[] = [];
  flightControllers: FlightController[] = [];

  busVoltage = 0;
  powered = false;
  /** Essential avionics working (or no avionics fitted and the bus is live). */
  avionicsPowered = false;
  loadW = 0;
  generatorCurrent = 0;
  /** Extra resistive load on the bus (Ω, Infinity = none). Test hook. */
  testLoadOhms = Infinity;

  constructor(modules: readonly ForceModule[]) {
    this.link(modules);
  }

  /** True if a craft with these modules needs an electrical system at all. */
  static needed(modules: readonly ForceModule[]): boolean {
    return modules.some((m) => m instanceof Battery || m instanceof Motor || m instanceof Generator || m instanceof Avionics);
  }

  /** Re-collect the modules (after parts break off). State lives in the modules themselves. */
  link(modules: readonly ForceModule[]): void {
    this.batteries = modules.filter((m): m is Battery => m instanceof Battery);
    this.motors = modules.filter((m): m is Motor => m instanceof Motor);
    this.generators = modules.filter((m): m is Generator => m instanceof Generator);
    this.avionics = modules.filter((m): m is Avionics => m instanceof Avionics);
    this.flightControllers = modules.filter((m): m is FlightController => m instanceof FlightController);
  }

  /** Battery full voltage (the system's nominal reference), or the regulator's if there is none. */
  private get referenceVoltage(): number {
    let v = 0;
    for (const b of this.batteries) v = Math.max(v, b.fullVoltage);
    return v > 0 ? v : 28;
  }

  /** Lowest bus voltage the avionics run on (V). */
  get minimumVoltage(): number {
    return TUNING.avionicsMinVoltage * this.referenceVoltage;
  }

  /** Advance one step: solve the bus, then update batteries, loads and the flight controller. */
  step(dt: number, ambientC: number = TUNING.batteryAmbientC): void {
    // --- Sources.
    const genAvail = this.generators.map((g) => g.available);
    const genMax = genAvail.reduce((a, x) => a + x, 0);
    const genOnline = genMax > 0;
    const vReg = TUNING.generatorRegulation * this.referenceVoltage;
    let gBatt = 0;
    let jBatt = 0;
    for (const b of this.batteries) {
      if (!b.connected) continue;
      gBatt += 1 / b.resistance;
      jBatt += b.openCircuitVoltage / b.resistance;
    }

    // --- Loads. Non-essential avionics are shed while a generator-equipped craft runs on battery.
    const shedding = this.generators.length > 0 && !genOnline;
    let load = 0;
    for (const a of this.avionics) {
      a.shed = shedding && !a.essential;
      load += a.demand;
    }
    for (const m of this.motors) load += m.power;
    const gLoad = Number.isFinite(this.testLoadOhms) && this.testLoadOhms > 0 ? 1 / this.testLoadOhms : 0;

    // --- Solve G·V² − J·V + P = 0 for the generator regime that is self-consistent.
    const solve = (g: number, j: number): { v: number; supply: number } => {
      if (g <= 1e-12) {
        if (j <= 1e-12) return { v: 0, supply: 0 };
        // Pure current source into a constant-power load.
        return load > 0 ? { v: Math.min(vReg, load / j), supply: 1 } : { v: vReg, supply: 1 };
      }
      const disc = j * j - 4 * g * load;
      if (disc >= 0) return { v: (j + Math.sqrt(disc)) / (2 * g), supply: 1 };
      // Brownout: max-power point, loads get what can be delivered.
      const v = j / (2 * g);
      return { v, supply: Math.max(0, (j * v - g * v * v) / load) };
    };
    let res: { v: number; supply: number };
    let iGen = 0;
    if (genOnline) {
      const gg = 1 / TUNING.generatorResistance;
      res = solve(gBatt + gLoad + gg, jBatt + vReg * gg);
      iGen = (vReg - res.v) * gg;
      if (iGen > genMax) {
        res = solve(gBatt + gLoad, jBatt + genMax);
        iGen = genMax;
      } else if (iGen < 0) {
        res = solve(gBatt + gLoad, jBatt);
        iGen = 0;
      }
    } else res = solve(gBatt + gLoad, jBatt);
    const v = Math.max(0, res.v);
    this.busVoltage = v;
    this.loadW = load * res.supply;
    this.generatorCurrent = iGen;
    this.powered = v >= this.minimumVoltage;

    // --- Batteries.
    for (const b of this.batteries) {
      if (b.connected) b.applyCurrent((b.openCircuitVoltage - v) / b.resistance, v, dt, ambientC);
      else b.idle(dt, ambientC);
    }
    this.generators.forEach((g, i) => (g.current = genMax > 0 ? (iGen * genAvail[i]) / genMax : 0));

    // --- Loads.
    for (const m of this.motors) {
      m.busVoltage = v;
      m.supply = res.supply;
    }
    let essentialFitted = false;
    let essentialOn = false;
    for (const a of this.avionics) {
      a.powered = this.powered && a.demand > 0;
      if (a.essential) {
        essentialFitted = true;
        if (a.powered) essentialOn = true;
      }
    }
    this.avionicsPowered = this.powered && (!essentialFitted || essentialOn);
    for (const fc of this.flightControllers) fc.powered = this.avionicsPowered;
  }

  /** Mean battery state of charge 0..1, or null without batteries. */
  get stateOfCharge(): number | null {
    if (!this.batteries.length) return null;
    return this.batteries.reduce((a, b) => a + b.soc, 0) / this.batteries.length;
  }

  /** Current out of all batteries (A, negative = charging). */
  get batteryCurrent(): number {
    return this.batteries.reduce((a, b) => a + b.current, 0);
  }

  /** Essential avionics load (W). */
  get essentialLoadW(): number {
    return this.avionics.filter((a) => a.essential && !a.failed).reduce((s, a) => s + a.def.loadW, 0);
  }

  /**
   * Designed battery-only endurance of the essential bus (min): usable battery energy over the
   * essential load. Infinity if there is no essential load.
   */
  essentialEnduranceMin(): number {
    const wh = this.batteries.reduce((s, b) => s + (b.connected ? b.energyWh : 0), 0);
    const w = this.essentialLoadW;
    return w > 0 ? (wh / w) * 60 : Infinity;
  }

  /**
   * An electrical surge (lightning, short): `energyJ` of energy coupled into the bus. Every
   * avionics box sees it (essential ones are hardened 4×) and burns out past its tolerance;
   * the batteries absorb part of it as heat and lose cell condition.
   */
  spike(energyJ: number): void {
    if (!(energyJ > 0)) return;
    for (const a of this.avionics) {
      a.spikeJ += energyJ;
      if (a.spikeJ > TUNING.avionicsSpikeTolerance * (a.essential ? 4 : 1)) {
        a.failed = true;
        a.powered = false;
      }
    }
    const n = Math.max(1, this.batteries.length);
    for (const b of this.batteries) {
      b.tempC += (TUNING.batterySpikeHeatFraction * energyJ) / n / b.thermalMass;
      b.damage *= 1 + energyJ / n / TUNING.batterySpikeDamageJ;
      if (b.tempC > b.maxTempC) b.cutoff = 'overheat';
    }
  }

  reset(): void {
    this.busVoltage = 0;
    this.powered = false;
    this.avionicsPowered = false;
    this.loadW = 0;
    this.generatorCurrent = 0;
  }

  telemetry(): ElectricalTelemetry {
    const r = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
    const bats = this.batteries;
    const soc = this.stateOfCharge;
    const cut = bats.find((b) => b.cutoff)?.cutoff ?? '';
    return {
      busVolts: r(this.busVoltage, 1),
      powered: this.powered,
      avionics: this.avionicsPowered,
      battery: soc === null ? null : r(soc, 3),
      // Connected packs sit at the bus voltage; a tripped pack shows its resting voltage.
      batteryVolts: bats.length ? r(bats.some((b) => b.connected) ? this.busVoltage : Math.max(...bats.map((b) => b.voltage)), 1) : null,
      batteryAmps: r(this.batteryCurrent, 1),
      batteryTempC: bats.length ? r(Math.max(...bats.map((b) => b.tempC)), 1) : null,
      batteryCutoff: cut,
      generatorAmps: r(this.generatorCurrent, 1),
      generatorOnline: this.generators.some((g) => g.available > 0),
      loadW: Math.round(this.loadW),
      failed: [...new Set(this.avionics.filter((a) => a.failed).map((a) => a.partId))],
    };
  }
}
