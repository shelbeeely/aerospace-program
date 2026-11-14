/**
 * Tiny neural networks for the game's NPC policies: a few dozen weights each, plain TypeScript,
 * no dependencies, deterministic (seeded streams only), so the browser, the headless checks and
 * the relay all run the same thing.
 *
 * A network maps a handful of normalised inputs to one score per action: tanh hidden layers,
 * raw outputs (softmax for probabilities). It is trained by imitation (stochastic gradient
 * descent on cross-entropy against a teacher's choices, classes weighted so rare actions still
 * count) and can then be refined by evolution, the approach of trekhleb's
 * self-parking-car-evolution (MIT): a population of variants, the fittest kept unchanged
 * ("long-living champions"), children by uniform crossover and mutation.
 */
export interface Net {
  /** Layer sizes, inputs first: [inputs, hidden..., outputs]. */
  sizes: number[];
  /** Per layer: weights (out × in, row-major) then biases (out). */
  w: Float32Array;
}

export interface NetJSON {
  sizes: number[];
  w: number[];
}

/** How many numbers a network of these sizes holds. */
export function netLength(sizes: readonly number[]): number {
  let n = 0;
  for (let l = 1; l < sizes.length; l++) n += sizes[l] * sizes[l - 1] + sizes[l];
  return n;
}

/** A fresh network, weights drawn from `rand` (scaled to the layer's fan-in). */
export function createNet(sizes: readonly number[], rand: () => number): Net {
  const w = new Float32Array(netLength(sizes));
  let o = 0;
  for (let l = 1; l < sizes.length; l++) {
    const fanIn = sizes[l - 1], k = Math.sqrt(1 / fanIn);
    for (let i = 0; i < sizes[l] * fanIn; i++) w[o++] = (rand() * 2 - 1) * k;
    o += sizes[l]; // biases start at zero
  }
  return { sizes: [...sizes], w };
}

export function cloneNet(n: Net): Net {
  return { sizes: [...n.sizes], w: new Float32Array(n.w) };
}

/** Every layer's activations for `input` (the last is the raw output scores). */
function activations(net: Net, input: ArrayLike<number>): Float32Array[] {
  const acts: Float32Array[] = [Float32Array.from(input as ArrayLike<number>)];
  let o = 0;
  for (let l = 1; l < net.sizes.length; l++) {
    const nIn = net.sizes[l - 1], nOut = net.sizes[l];
    const x = acts[l - 1], y = new Float32Array(nOut);
    const bo = o + nOut * nIn;
    for (let j = 0; j < nOut; j++) {
      let s = net.w[bo + j];
      const row = o + j * nIn;
      for (let i = 0; i < nIn; i++) s += net.w[row + i] * x[i];
      y[j] = l < net.sizes.length - 1 ? Math.tanh(s) : s;
    }
    acts.push(y);
    o = bo + nOut;
  }
  return acts;
}

/** The network's scores for `input` (one per action). */
export function forward(net: Net, input: ArrayLike<number>): Float32Array {
  const a = activations(net, input);
  return a[a.length - 1];
}

export function softmax(xs: ArrayLike<number>): number[] {
  let m = -Infinity;
  for (let i = 0; i < xs.length; i++) m = Math.max(m, xs[i]);
  const e = Array.from(xs, (x) => Math.exp(x - m));
  const s = e.reduce((a, b) => a + b, 0);
  return e.map((x) => x / s);
}

export function argmax(xs: ArrayLike<number>): number {
  let best = 0;
  for (let i = 1; i < xs.length; i++) if (xs[i] > xs[best]) best = i;
  return best;
}

export interface Example {
  x: number[];
  /** The teacher's action (index). */
  y: number;
}

/**
 * Imitation: stochastic gradient descent on softmax cross-entropy, examples shuffled each epoch
 * from `rand`, each class weighted by the inverse of how often it appears (so a policy that
 * mostly "follows" still learns when to yield). Returns the final loss and accuracy.
 */
export function train(net: Net, examples: readonly Example[], opts: { epochs: number; lr: number; rand: () => number }): { loss: number; accuracy: number } {
  const nOut = net.sizes[net.sizes.length - 1];
  const counts = new Array<number>(nOut).fill(0);
  for (const e of examples) counts[e.y]++;
  const weight = counts.map((c) => (c > 0 ? examples.length / (nOut * c) : 0));
  const order = examples.map((_, i) => i);
  let loss = 0, right = 0;
  for (let epoch = 0; epoch < opts.epochs; epoch++) {
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(opts.rand() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    loss = 0;
    right = 0;
    const lr = opts.lr * (1 - 0.7 * (epoch / Math.max(1, opts.epochs - 1)));
    for (const idx of order) {
      const ex = examples[idx];
      const acts = activations(net, ex.x);
      const out = acts[acts.length - 1];
      const p = softmax(out);
      loss -= Math.log(Math.max(1e-9, p[ex.y])) * weight[ex.y];
      if (argmax(out) === ex.y) right++;
      // Backward: delta at the output is (p - onehot), scaled by the class weight.
      let delta = Float32Array.from(p, (v, k) => (v - (k === ex.y ? 1 : 0)) * weight[ex.y]);
      let o = net.w.length;
      for (let l = net.sizes.length - 1; l >= 1; l--) {
        const nIn = net.sizes[l - 1], nOut2 = net.sizes[l];
        o -= nOut2 * nIn + nOut2;
        const x = acts[l - 1];
        const bo = o + nOut2 * nIn;
        const back = new Float32Array(nIn);
        for (let j = 0; j < nOut2; j++) {
          const d = delta[j];
          const row = o + j * nIn;
          for (let i = 0; i < nIn; i++) {
            back[i] += net.w[row + i] * d;
            net.w[row + i] -= lr * d * x[i];
          }
          net.w[bo + j] -= lr * d;
        }
        if (l > 1) for (let i = 0; i < nIn; i++) back[i] *= 1 - x[i] * x[i]; // through tanh
        delta = back;
      }
    }
  }
  return { loss: loss / Math.max(1, examples.length), accuracy: right / Math.max(1, examples.length) };
}

/** How often the network picks the teacher's action. */
export function accuracy(net: Net, examples: readonly Example[]): number {
  let right = 0;
  for (const e of examples) if (argmax(forward(net, e.x)) === e.y) right++;
  return right / Math.max(1, examples.length);
}

/** A copy with each weight nudged (chance `rate`, Gaussian step of `sigma`). */
export function mutateNet(n: Net, rate: number, sigma: number, rand: () => number): Net {
  const c = cloneNet(n);
  for (let i = 0; i < c.w.length; i++) {
    if (rand() >= rate) continue;
    const u = Math.max(1e-9, rand()), v = rand();
    c.w[i] += Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) * sigma;
  }
  return c;
}

/** A child taking each weight from one parent or the other (uniform crossover). */
export function crossNet(a: Net, b: Net, rand: () => number): Net {
  const c = cloneNet(a);
  for (let i = 0; i < c.w.length; i++) if (rand() < 0.5) c.w[i] = b.w[i];
  return c;
}

/**
 * One generation of evolution: the `elite` fittest go on unchanged, the rest are children of
 * parents picked by tournament (two drawn, the fitter wins), crossed and mutated.
 */
export function evolve(pop: readonly Net[], fitness: readonly number[], opts: { elite: number; rate: number; sigma: number; rand: () => number }): Net[] {
  const ranked = pop.map((n, i) => ({ n, f: fitness[i] })).sort((a, b) => b.f - a.f);
  const next = ranked.slice(0, opts.elite).map((r) => cloneNet(r.n));
  const pick = () => {
    const a = ranked[Math.floor(opts.rand() * ranked.length)], b = ranked[Math.floor(opts.rand() * ranked.length)];
    return (a.f >= b.f ? a : b).n;
  };
  while (next.length < pop.length) next.push(mutateNet(crossNet(pick(), pick(), opts.rand), opts.rate, opts.sigma, opts.rand));
  return next;
}

export function toJSON(n: Net): NetJSON {
  return { sizes: [...n.sizes], w: Array.from(n.w, (v) => Math.round(v * 1e5) / 1e5) };
}

/** A network read back; null if the numbers do not fit its sizes. */
export function fromJSON(j: unknown): Net | null {
  if (!j || typeof j !== 'object') return null;
  const o = j as Partial<NetJSON>;
  if (!Array.isArray(o.sizes) || !Array.isArray(o.w) || o.sizes.length < 2) return null;
  if (o.w.length !== netLength(o.sizes) || !o.w.every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
  return { sizes: [...o.sizes], w: Float32Array.from(o.w) };
}
