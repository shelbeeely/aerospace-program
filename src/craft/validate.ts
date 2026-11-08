import type { CraftDef, ModuleDef, PartDef, ShapeDef } from './types.ts';

/**
 * Validates an untrusted craft definition (from a save file, the hangar, or an LLM) before it
 * reaches the physics. Returns a list of human-readable problems; empty means OK.
 */
export function validateCraft(input: unknown): string[] {
  const errors: string[] = [];
  const isNum = (v: unknown, min = -Infinity, max = Infinity) =>
    typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
  const isVec = (v: unknown, lim = 1000) =>
    Array.isArray(v) && v.length === 3 && v.every((x) => isNum(x, -lim, lim));

  if (typeof input !== 'object' || input === null) return ['craft must be an object'];
  const c = input as Partial<CraftDef>;
  if (c.formatVersion !== 1) errors.push('formatVersion must be 1');
  if (typeof c.name !== 'string') errors.push('name must be a string');
  if (!Array.isArray(c.parts) || c.parts.length === 0) {
    errors.push('parts must be a non-empty array');
    return errors;
  }
  if (c.parts.length > 500) errors.push('too many parts (max 500)');

  const ids = new Set<string>();
  c.parts.forEach((p: Partial<PartDef>, i) => {
    const at = `parts[${i}]${p?.id ? ` (${p.id})` : ''}`;
    if (typeof p !== 'object' || p === null) return errors.push(`${at}: must be an object`);
    if (typeof p.id !== 'string' || !p.id) errors.push(`${at}: id required`);
    else if (ids.has(p.id)) errors.push(`${at}: duplicate id`);
    else ids.add(p.id);
    if (!isNum(p.mass, 0.01, 1e6)) errors.push(`${at}: mass must be 0.01..1e6 kg`);
    if (!isVec(p.position)) errors.push(`${at}: position must be [x,y,z] within 1 km`);
    if (p.rotationDeg !== undefined && !isVec(p.rotationDeg, 360))
      errors.push(`${at}: rotationDeg must be [x,y,z] degrees`);
    if (typeof p.color !== 'string') errors.push(`${at}: color must be a CSS colour string`);
    if (p.strength !== undefined && !isNum(p.strength, 0, 1e9)) errors.push(`${at}: strength must be 0..1e9 N (0 = unbreakable)`);
    if (p.hp !== undefined && !isNum(p.hp, 0, 1e12)) errors.push(`${at}: hp must be 0..1e12 J (0 = indestructible)`);
    if (p.reinforce !== undefined && !isNum(p.reinforce, 0, 3)) errors.push(`${at}: reinforce must be 0..3`);
    errors.push(...validateShape(p.shape, at));
    (p.modules ?? []).forEach((m, j) => errors.push(...validateModule(m, `${at}.modules[${j}]`)));
  });
  errors.push(...validateElectrical(c.parts));
  return errors;

  /** Cross-part rules: motors need a battery and a rotor to drive, generators an engine. */
  function validateElectrical(parts: Partial<PartDef>[]): string[] {
    const e: string[] = [];
    const all = parts.flatMap((p) => (Array.isArray(p?.modules) ? p.modules : []));
    const has = (t: ModuleDef['type']) => all.some((m) => m?.type === t);
    parts.forEach((p, i) => {
      const mods = Array.isArray(p?.modules) ? p.modules : [];
      const at = `parts[${i}]${p?.id ? ` (${p.id})` : ''}`;
      if (mods.some((m) => m?.type === 'motor')) {
        if (!has('battery')) e.push(`${at}: a motor needs a battery somewhere on the craft`);
        if (mods.filter((m) => m?.type === 'rotor').length !== 1) e.push(`${at}: a motor drives the one rotor on its own part: put exactly one rotor on this part`);
        if (mods.filter((m) => m?.type === 'motor').length > 1) e.push(`${at}: at most one motor per part`);
      }
      if (mods.some((m) => m?.type === 'generator') && !has('engine')) e.push(`${at}: a generator needs an engine on the craft to drive it`);
    });
    if (has('avionics') && !has('battery') && !has('generator')) e.push('avionics need a battery or a generator to power them');
    return e;
  }

  function validateShape(s: ShapeDef | undefined, at: string): string[] {
    if (!s) return [`${at}: shape required`];
    switch (s.type) {
      case 'box':
        return isVec(s.size, 200) && s.size.every((x) => x > 0) ? [] : [`${at}: box size invalid`];
      case 'sphere':
        return isNum(s.radius, 0.001, 200) ? [] : [`${at}: sphere radius invalid`];
      case 'cylinder':
        return isNum(s.radius, 0.001, 200) && isNum(s.length, 0.001, 200)
          ? []
          : [`${at}: cylinder dims invalid`];
      default:
        return [`${at}: unknown shape type`];
    }
  }

  function validateModule(m: ModuleDef, at: string): string[] {
    const e: string[] = [];
    if (m.offset !== undefined && !isVec(m.offset, 200)) e.push(`${at}: offset invalid`);
    switch (m.type) {
      case 'aero':
        if (!isNum(m.span, 0.01, 200) || !isNum(m.chord, 0.01, 200)) e.push(`${at}: span/chord invalid`);
        if (m.camberDeg !== undefined && !isNum(m.camberDeg, -10, 10)) e.push(`${at}: camberDeg -10..10`);
        if (m.cm0 !== undefined && !isNum(m.cm0, -0.5, 0.5)) e.push(`${at}: cm0 -0.5..0.5`);
        if (m.control) {
          if (!['pitch', 'roll', 'yaw', 'flaps'].includes(m.control.channel)) e.push(`${at}: bad control channel`);
          if (!isNum(m.control.maxDeflectionDeg, 0, 60)) e.push(`${at}: maxDeflectionDeg 0..60`);
          if (!isNum(m.control.gain, -1, 1)) e.push(`${at}: control gain -1..1`);
        }
        break;
      case 'engine':
        if (!isNum(m.maxThrust, 0, 5e6)) e.push(`${at}: maxThrust invalid`);
        if (m.propMaxSpeed !== undefined && !isNum(m.propMaxSpeed, 1, 400)) e.push(`${at}: propMaxSpeed 1..400 m/s`);
        if (m.propRadius !== undefined && !isNum(m.propRadius, 0.01, 10)) e.push(`${at}: propRadius 0.01..10 m`);
        if (m.propDirection !== undefined && ![1, -1, 0].includes(m.propDirection)) e.push(`${at}: propDirection must be 1, -1 or 0`);
        if (m.fuelFlow !== undefined && !isNum(m.fuelFlow, 0, 1000)) e.push(`${at}: fuelFlow 0..1000 kg/s`);
        if (m.spoolTime !== undefined && !isNum(m.spoolTime, 0, 30)) e.push(`${at}: spoolTime 0..30 s`);
        if (m.kind !== undefined && m.kind !== 'prop' && m.kind !== 'turbofan') e.push(`${at}: kind must be "prop" or "turbofan"`);
        if (m.kind === 'turbofan' && m.propMaxSpeed !== undefined) e.push(`${at}: a turbofan has no propeller: remove propMaxSpeed (or use kind "prop")`);
        if (m.kind === 'turbofan' && (m.propDirection || m.propRadius !== undefined))
          e.push(`${at}: a turbofan has no propeller: remove propDirection/propRadius`);
        if (m.kind === 'prop' && m.propMaxSpeed === undefined) e.push(`${at}: kind "prop" needs propMaxSpeed`);
        if (m.kind !== 'turbofan' && (m.bypassRatio !== undefined || m.afterburner !== undefined))
          e.push(`${at}: bypassRatio/afterburner only apply to kind "turbofan"`);
        if (m.bypassRatio !== undefined && !isNum(m.bypassRatio, 0, 15)) e.push(`${at}: bypassRatio 0..15`);
        if (m.afterburner !== undefined) {
          if (typeof m.afterburner !== 'object' || m.afterburner === null) e.push(`${at}: afterburner must be {thrustRatio, fuelRatio}`);
          else {
            if (!isNum(m.afterburner.thrustRatio, 1, 3)) e.push(`${at}: afterburner.thrustRatio 1..3`);
            if (!isNum(m.afterburner.fuelRatio, 1, 10)) e.push(`${at}: afterburner.fuelRatio 1..10`);
          }
        }
        break;
      case 'wheel':
        if (!isNum(m.radius, 0.01, 10) || !isNum(m.restLength, 0, 10)) e.push(`${at}: wheel dims invalid`);
        if (!isNum(m.stiffness, 0, 1e8) || !isNum(m.damping, 0, 1e7)) e.push(`${at}: spring invalid`);
        break;
      case 'drag':
        if (!isNum(m.cdA, 0, 1000)) e.push(`${at}: cdA invalid`);
        break;
      case 'body':
        if (!isNum(m.length, 0.05, 300) || !isNum(m.diameter, 0.01, 50)) e.push(`${at}: body length/diameter invalid`);
        if (m.cdFront !== undefined && !isNum(m.cdFront, 0, 2)) e.push(`${at}: cdFront 0..2`);
        break;
      case 'fuel':
        if (!isNum(m.capacity, 0, 1e5)) e.push(`${at}: fuel capacity 0..100000 kg`);
        if (m.fill !== undefined && !isNum(m.fill, 0, 1)) e.push(`${at}: fill 0..1`);
        break;
      case 'buoyancy':
        if (!isNum(m.volume, 0, 1e6)) e.push(`${at}: volume 0..1e6 m³`);
        if (m.gas !== undefined && !['helium', 'hydrogen', 'hot-air'].includes(m.gas)) e.push(`${at}: gas must be helium|hydrogen|hot-air`);
        break;
      case 'rotor':
        if (!isNum(m.radius, 0.02, 15) || !isNum(m.chord, 0.005, 2)) e.push(`${at}: rotor radius 0.02..15 m, chord 0.005..2 m`);
        if (!isNum(m.blades, 1, 12) || !Number.isInteger(m.blades)) e.push(`${at}: blades must be an integer 1..12`);
        if (!isNum(m.maxRpm, 10, 40000)) e.push(`${at}: maxRpm 10..40000`);
        if (m.mode !== 'rpm' && m.mode !== 'collective') e.push(`${at}: mode must be "rpm" or "collective"`);
        if (!isNum(m.pitchDeg, -20, 40)) e.push(`${at}: pitchDeg -20..40`);
        if (m.spin !== 1 && m.spin !== -1) e.push(`${at}: spin must be 1 or -1`);
        if (m.cyclicDeg !== undefined && !isNum(m.cyclicDeg, 0, 20)) e.push(`${at}: cyclicDeg 0..20`);
        // Tip speed above ~Mach 0.9 isn't something this model handles.
        if (isNum(m.radius) && isNum(m.maxRpm) && ((m.maxRpm * Math.PI * 2) / 60) * m.radius > 300)
          e.push(`${at}: tip speed over 300 m/s (lower maxRpm or radius)`);
        break;
      case 'battery':
        if (!isNum(m.cells, 1, 400) || !Number.isInteger(m.cells)) e.push(`${at}: battery cells must be an integer 1..400`);
        if (!isNum(m.capacityAh, 1e-3, 1e5)) e.push(`${at}: capacityAh must be 0.001..1e5 Ah`);
        if (!isNum(m.cellResistance, 1e-6, 10)) e.push(`${at}: cellResistance must be 1e-6..10 Ω per cell`);
        if (!isNum(m.cellVmax, 0.5, 10) || !isNum(m.cellVmin, 0.1, 10) || !(m.cellVmax > m.cellVmin))
          e.push(`${at}: cellVmax/cellVmin must be volts with cellVmax > cellVmin (LiPo 4.2/3.3)`);
        if (m.thermalMass !== undefined && !isNum(m.thermalMass, 1, 1e8)) e.push(`${at}: thermalMass 1..1e8 J/K`);
        if (m.maxTempC !== undefined && !isNum(m.maxTempC, 0, 200)) e.push(`${at}: maxTempC 0..200`);
        if (m.soc !== undefined && !isNum(m.soc, 0, 1)) e.push(`${at}: soc 0..1`);
        break;
      case 'motor':
        if (!isNum(m.kv, 1e-3, 1e5)) e.push(`${at}: motor kv must be 0.001..1e5 rpm/V`);
        if (!isNum(m.rWinding, 1e-6, 100)) e.push(`${at}: motor rWinding must be 1e-6..100 Ω`);
        if (!isNum(m.maxCurrent, 1e-3, 1e5)) e.push(`${at}: motor maxCurrent must be 0.001..1e5 A`);
        break;
      case 'generator':
        if (!isNum(m.ratedAmps, 1e-3, 1e5)) e.push(`${at}: generator ratedAmps must be 0.001..1e5 A`);
        if (m.minRpmFraction !== undefined && !isNum(m.minRpmFraction, 0, 0.85)) e.push(`${at}: minRpmFraction 0..0.85`);
        break;
      case 'avionics':
        if (!isNum(m.loadW, 0, 1e6)) e.push(`${at}: avionics loadW 0..1e6 W`);
        if (m.essential !== undefined && typeof m.essential !== 'boolean') e.push(`${at}: essential must be true or false`);
        break;
      case 'flightController':
        if (m.mode !== 'multirotor' && m.mode !== 'helicopter') e.push(`${at}: mode must be "multirotor" or "helicopter"`);
        break;
      default:
        e.push(`${at}: unknown module type`);
    }
    return e;
  }
}
