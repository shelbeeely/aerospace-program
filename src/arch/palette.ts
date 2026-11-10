/**
 * The 1982 digital-world palette: one restrained set of surfaces and light roles shared by the
 * generators (which only name classes and roles), the validator (which checks them) and the
 * renderer (which turns the indices into colours). Nothing outside these lists may appear.
 *
 * Surfaces are smooth: deep blue, dark navy, near-black, muted cyan, desaturated metallic blue
 * and pale blue-grey (the Triple-I solids of the book's pp. 36–40 and 53–54 are pale cyan with
 * red or orange edge lines, so pale and muted cyan are used for whole families, not only accents). Light is the secondary layer: electric cyan,
 * bright blue, white, and the warm accents red, orange and amber, used where they mean
 * something (see LIGHT_MEANING).
 */
export const SURFACES = ['hull', 'hullDark', 'void', 'panel', 'metal', 'pale', 'substrate', 'glow', 'translucent', 'circuit'] as const;
export type Surface = (typeof SURFACES)[number];

export const SURFACE_COLORS: Record<Surface, string> = {
  hull: '#0d2257',      // deep blue
  hullDark: '#071433',  // dark navy
  void: '#02050d',      // near-black
  panel: '#1f5470',     // muted cyan
  metal: '#2f4a6b',     // desaturated metallic blue
  pale: '#7f9dbb',      // pale blue-grey (sparingly)
  substrate: '#06102a', // the electronic ground plates
  glow: '#000000',      // emissive face: colour comes from its light role
  translucent: '#2a7fff', // energy columns, beams (additive)
  circuit: '#081634',   // dark plate whose up-facing faces carry circuit traces (book p. 12)
};

export const LIGHT_ROLES = ['structure', 'data', 'energy', 'entrance', 'process', 'warning'] as const;
export type LightRole = (typeof LIGHT_ROLES)[number];

export const LIGHT_COLORS: Record<LightRole, string> = {
  structure: '#36e2ff', // electric cyan: structural boundaries
  data: '#2f74ff',      // bright blue: data transport
  energy: '#eaf6ff',    // white: energy distribution
  entrance: '#ffb347',  // amber: entrances and connections
  process: '#ff7a1a',   // orange: active computation
  warning: '#ff2a1a',   // red: hazards, boundaries, damage
};

/** What each light role communicates (debug UI, docs). */
export const LIGHT_MEANING: Record<LightRole, string> = {
  structure: 'structural boundaries and silhouettes',
  data: 'data transport: channels, pathways, links',
  energy: 'energy distribution: conduits, cores, beams',
  entrance: 'entrances, docks and connection points',
  process: 'active computational processes',
  warning: 'boundaries, hazards and damage',
};

export const ACTIVITY_STATES = ['active', 'idle', 'damaged', 'inactive'] as const;
export type ActivityState = (typeof ACTIVITY_STATES)[number];

/** Surfaces that count as the dark, unlit mass of a building (validation: they must dominate). */
export const DARK_SURFACES: ReadonlySet<Surface> = new Set(['hull', 'hullDark', 'void', 'panel', 'metal', 'substrate', 'circuit', 'pale']);

/**
 * Surface patterns drawn by the shader in face metres (the `uvm` attribute), never as geometry:
 * - panels: large geometric panel seams (scale and perspective on broad surfaces);
 * - grid: thin lines wrapping a form (the gridded trumpet towers, book p. 13);
 * - flutes: vertical slat shading (the fluted control cylinder and hangar walls, pp. 53, 60);
 * - circuit: traces and pads on up-facing faces (circuit-board tops and plates, pp. 12, 35);
 * - skylight: a grid of glowing translucent panes (hangar roofs, p. 53; floor panes, p. 10).
 */
export const PATTERNS = ['none', 'panels', 'grid', 'flutes', 'circuit', 'skylight'] as const;
export type Pattern = (typeof PATTERNS)[number];

/** Physics/fracture block colours handed to StructureGroup (hex, from the light roles). */
export const BLOCK_COLORS = [LIGHT_COLORS.structure, LIGHT_COLORS.data, LIGHT_COLORS.structure, LIGHT_COLORS.process, LIGHT_COLORS.energy, LIGHT_COLORS.entrance] as const;
