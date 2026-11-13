import type { ActivityState, LightRole, Pattern, Surface } from './palette.ts';

/**
 * Data model of the procedural architecture. Pure data (no three.js), shared by generation,
 * validation, physics (colliders) and rendering (meshes).
 *
 * Hierarchy: World → Region → District → Structure → Component.
 */

/** The five architectural families. */
export type ArchetypeId = 'circuit' | 'tower' | 'industrial' | 'cavern' | 'radial';

/**
 * Geometric hierarchy: 1 = primary masses (the recognisable silhouette, 2–5 of them),
 * 2 = secondary (platforms, columns, supports, recesses, connecting volumes),
 * 3 = tertiary (panel seams, circuitry, illuminated channels, small mechanical detail).
 */
export type Tier = 1 | 2 | 3;

/**
 * Allowed primitives (the grammar's alphabet). All dimensions in metres, base at local y = 0.
 * - box: rectangular prism; `taper` < 1 shrinks the top (1 = prism, 0 = pyramid).
 * - prism: n-sided extrusion from radius r0 (base) to r1 (top): cylinders (n ≥ 16), polygonal
 *   cores (n = 3–12), cones and truncated cones (r1 < r0), flared bases (r1 > r0).
 * - lathe: a (radius, height) profile revolved: trumpet flares, stepped radial platforms.
 * - ring: an annulus (inner r0, outer r1, height h), optionally an arc section.
 * - torus: a toroidal ring (major R, tube radius r).
 * - extrude: a custom polygon outline (CCW in x/z) extruded up h, optionally tapered.
 * - sweep: a closed cross-section (x across, y up) swept along a polyline path (local x/y/z,
 *   optional 4th value: section scale at that point, for tapered hulls).
 * - frustum: rectangular frustum, base w × d to top wt × dt (battered landform walls).
 * - dome: a smooth elliptical cap (radii rx, rz, height h): the Sea of Simulation's swells.
 * - sphere: a floating orb (radius r, base at the bottom of the sphere).
 */
export type Primitive =
  | { kind: 'box'; w: number; h: number; d: number; taper?: number }
  | { kind: 'prism'; sides: number; r0: number; r1: number; h: number; phase?: number }
  | { kind: 'lathe'; profile: ReadonlyArray<readonly [number, number]>; sides: number }
  | { kind: 'ring'; r0: number; r1: number; h: number; sides: number; arc?: number; arcStart?: number }
  | { kind: 'torus'; R: number; r: number; sides: number; tube: number }
  | { kind: 'extrude'; outline: ReadonlyArray<readonly [number, number]>; h: number; taper?: number }
  | { kind: 'sweep'; section: ReadonlyArray<readonly [number, number]>; path: ReadonlyArray<readonly [number, number, number] | readonly [number, number, number, number]> }
  | { kind: 'frustum'; w: number; d: number; wt: number; dt: number; h: number }
  | { kind: 'dome'; rx: number; rz: number; h: number }
  | { kind: 'sphere'; r: number };

export type PrimitiveKind = Primitive['kind'];

/**
 * Which edges of a component glow (selective illumination: most edges stay dark).
 * - none: unlit mass;
 * - top: the top rim only;  base: the footing rim only;  rims: top and base;
 * - silhouette: top rim plus vertical corners;
 * - horizontal: every horizontal edge (bands, platform lips, lathe profile breaks);
 * - all: every hard edge (small lit elements only).
 */
export type EdgeMode = 'none' | 'top' | 'base' | 'rims' | 'silhouette' | 'horizontal' | 'all';

export interface Component {
  prim: Primitive;
  /** Base centre in structure-local metres (y up). */
  x: number;
  y: number;
  z: number;
  /** Rotation about local +Y (rad), then optional tilts about X and Z (rad). */
  ry?: number;
  rx?: number;
  rz?: number;
  tier: Tier;
  surface: Surface;
  edges: EdgeMode;
  /** Colour role of the glowing edges (or of the whole face for surface 'glow'). */
  light?: LightRole;
  /** Glow intensity multiplier (1 = standard). */
  glow?: number;
  /** Semantic role: 'core', 'foundation', 'platform', 'column', 'seam', 'channel', 'portal'... */
  role: string;
  /** Interior element: only drawn at full detail (LOD 0). */
  interior?: boolean;
  /** Primary mass id (tier 1): components sharing an id read as one dominant mass. */
  mass?: number;
  /** Shader surface pattern (default: 'panels' on tiers 1–2, none on tier 3). */
  pattern?: Pattern;
}

/** Collider approximation (axis-aligned; matches CityPiece / Structure shapes). Centre + full size. */
export interface ColliderPiece {
  shape: 'box' | 'oct' | 'cyl' | 'cone';
  x: number;
  y: number;
  z: number;
  sx: number;
  sy: number;
  sz: number;
  taper?: number;
}

/** Where infrastructure plugs into a structure (local coordinates, outward direction). */
export interface ConnectionPoint {
  x: number;
  y: number;
  z: number;
  /** Outward heading in quarter turns: 0 +x, 1 +z, 2 -x, 3 -z (-1 = up). */
  dir: number;
  kind: 'data' | 'energy' | 'transport' | 'bridge';
}

export interface Entrance {
  /** Side of the shell: 0 +x, 1 +z, 2 -x, 3 -z. */
  side: number;
  /** Offset along that side from its centre (m), opening width and height (m). */
  offset: number;
  width: number;
  height: number;
}

/** Accessible interior: the hollow shell an InteriorGenerator fills. */
export interface InteriorConfig {
  accessible: boolean;
  /** Inner volume (local, axis-aligned). */
  x0: number; x1: number; z0: number; z1: number; y0: number; y1: number;
  wall: number;
  entrances: Entrance[];
  /**
   * Interior programme: 'hall' (bays, nave, walkways), 'chamber' (machinery), 'shaft' (vertical),
   * 'commons' (a room at the scale of the people: terminal banks, memory columns, a meeting ring).
   */
  program: 'hall' | 'chamber' | 'shaft' | 'commons';
}

export interface Illumination {
  /** Light roles used, primary first. */
  roles: LightRole[];
  /** Overall glow intensity (multiplies every component's glow). */
  intensity: number;
  /** Pulse rate of active illumination (Hz). */
  pulse: number;
  /** Fraction of components allowed to carry lit edges (validation keeps it purposeful). */
  edgeDensity: number;
}

export interface Palette {
  primary: Surface;
  secondary: Surface;
  accent: LightRole;
  secondaryLight: LightRole;
}

export interface ValidationCheck {
  id: number;
  name: string;
  pass: boolean;
  detail: string;
}

export interface ValidationReport {
  pass: boolean;
  checks: ValidationCheck[];
  attempts: number;
}

/** A generated structure: everything needed to validate, collide with and draw it. */
export interface StructureSpec {
  /** Globally unique, stable id (from its lot origin). */
  id: string;
  archetype: ArchetypeId;
  /** Computational function (from the archetype's list). */
  function: string;
  /** Silhouette variant within the archetype ('trumpet', 'hall', 'memory'...). */
  variant: string;
  seed: number;
  /** World position of the lot centre (m) and base elevation. */
  x: number;
  y: number;
  z: number;
  /** Orientation: quarter turns about +Y (keeps colliders axis-aligned). */
  rotation: 0 | 1 | 2 | 3;
  /** Lot footprint (m, before rotation) and overall height (m). */
  w: number;
  d: number;
  height: number;
  params: Record<string, number>;
  palette: Palette;
  illumination: Illumination;
  connections: ConnectionPoint[];
  interior: InteriorConfig | null;
  activity: ActivityState;
  /** Structure-local components (rotation applied at build time). */
  components: Component[];
  /** World-space, axis-aligned collider pieces. */
  colliders: ColliderPiece[];
  /** Landmark (seen from far away; named). */
  landmark?: string;
  /** Flat roof suitable for a helipad: world centre, height, half-size. */
  roof?: { x: number; y: number; z: number; r: number };
  validation?: ValidationReport;
}

/** Inputs a generator receives. */
export interface GenRequest {
  archetype: ArchetypeId;
  seed: number;
  /** Lot centre (world) and size (m). */
  x: number;
  z: number;
  w: number;
  d: number;
  /** Height limits for this lot (zoning, region scale). */
  minHeight: number;
  maxHeight: number;
  /** 0..1 monumentality from the region (hub cores → 1). */
  intensity: number;
  /** Region identity (affects proportions and light). */
  region: string;
  /** Forced function / variant (debug lab), otherwise chosen. */
  func?: string;
  variant?: string;
  /** Parameter overrides (debug lab). */
  params?: Record<string, number>;
  /** Make a named landmark. */
  landmark?: string;
  rotation?: 0 | 1 | 2 | 3;
}

/** A tunable generation parameter (debug UI sliders). */
export interface ParamDef {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  /** Default (when not chosen randomly by the generator). */
  def: number;
}
