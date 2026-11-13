import data from './bitShapes.json' with { type: 'json' };

/**
 * The Bit: the people of the digital world. A hovering polyhedron with no legs or wheels to
 * animate: it has four figures, one per state, and says everything by which one it shows:
 *
 * - **idle 1**: blue compound of the icosahedron and dodecahedron
 * - **idle 2**: blue small triambic icosahedron (idling, it pulses between the two)
 * - **yes**: yellow octahedron
 * - **no**: red stellated icosahedron
 *
 * The meshes are imported from "BIT" by Fernando Jerez (CC-BY 4.0) with `npm run import-bit`.
 * Nothing here touches three.js: the figure is drawn by render/BitFigure.ts.
 */
export type BitState = 'idle1' | 'idle2' | 'yes' | 'no';
export type BitAnswer = 'yes' | 'no';

export interface BitShape {
  /** Vertex positions (x, y, z), Y up, centred, circumradius 1. */
  positions: number[];
  /** Triangles, three vertex indices each. */
  indices: number[];
}

export const BIT_CREDIT: string = data.credit;
export const BIT_SHAPES: Record<BitState, BitShape> = data.shapes;

/** The figure's look per state: light colour and circumradius (m). */
export const BIT_LOOK: Record<BitState, { color: string; radius: number }> = {
  idle1: { color: '#3d7cff', radius: 0.62 },
  idle2: { color: '#3d7cff', radius: 0.7 },
  yes: { color: '#ffd21a', radius: 0.8 },
  no: { color: '#ff2a12', radius: 0.95 },
};

export const BIT = {
  /** Height of the figure's centre over the ground at rest (m). */
  hover: 1.35,
  /** Seconds each idle figure is held before it snaps to the other. */
  idleBeat: 0.55,
  /** Seconds an answer is shown before the Bit goes back to idling. */
  answerTime: 0.9,
  /** Turns per second: idling, and while answering. */
  spin: 0.18,
  answerSpin: 0.9,
} as const;

/**
 * Which figure shows at `time`: the answer while it lasts (`answeredAt` is when it was given),
 * otherwise the two idle figures in alternation. Pure, so every view of the same Bit agrees.
 */
export function bitState(time: number, answer: BitAnswer | null = null, answeredAt = -Infinity): BitState {
  if (answer && time >= answeredAt && time - answeredAt < BIT.answerTime) return answer;
  return Math.floor(time / BIT.idleBeat) % 2 === 0 ? 'idle1' : 'idle2';
}
