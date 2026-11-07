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
    errors.push(...validateShape(p.shape, at));
    (p.modules ?? []).forEach((m, j) => errors.push(...validateModule(m, `${at}.modules[${j}]`)));
  });
  return errors;

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
        if (m.control) {
          if (!['pitch', 'roll', 'yaw'].includes(m.control.channel)) e.push(`${at}: bad control channel`);
          if (!isNum(m.control.maxDeflectionDeg, 0, 60)) e.push(`${at}: maxDeflectionDeg 0..60`);
          if (!isNum(m.control.gain, -1, 1)) e.push(`${at}: control gain -1..1`);
        }
        break;
      case 'engine':
        if (!isNum(m.maxThrust, 0, 5e6)) e.push(`${at}: maxThrust invalid`);
        break;
      case 'wheel':
        if (!isNum(m.radius, 0.01, 10) || !isNum(m.restLength, 0, 10)) e.push(`${at}: wheel dims invalid`);
        if (!isNum(m.stiffness, 0, 1e8) || !isNum(m.damping, 0, 1e7)) e.push(`${at}: spring invalid`);
        break;
      case 'drag':
        if (!isNum(m.cdA, 0, 1000)) e.push(`${at}: cdA invalid`);
        break;
      default:
        e.push(`${at}: unknown module type`);
    }
    return e;
  }
}
