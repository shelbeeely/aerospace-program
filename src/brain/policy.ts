import { argmax, forward, softmax, type Net } from './net.ts';

/**
 * The contract every NPC policy keeps: a small, named set of inputs, a small set of actions,
 * and a scripted rule that does the same job (the baseline it is compared with, and the
 * teacher it learns from). The network decides; the game engine carries the decision out
 * (physics, routing, signals, rules), so a policy can ask for something unsafe and simply not
 * get it.
 *
 * One policy serves a whole role ("hive mind"): every truck driver shares the driving policy,
 * and what makes each one different (its urgency, its cargo, its profile) is in its inputs. An
 * agent switches policy when its job changes. Every decision comes back with its scores, so
 * the event log can say why.
 */
export interface Feature {
  name: string;
  /** Raw value / scale is what the network sees (clipped to ±3). */
  scale: number;
}

export type PolicyMode = 'scripted' | 'net';

export interface Decision<A extends string> {
  action: A;
  /** The network's probabilities per action (null for the scripted rule). */
  probs: number[] | null;
  mode: PolicyMode;
}

export class Policy<O, A extends string> {
  net: Net | null = null;

  constructor(
    readonly id: string,
    readonly inputs: readonly Feature[],
    readonly actions: readonly A[],
    private readonly features: (o: O) => number[],
    readonly scripted: (o: O) => A,
    readonly hidden: readonly number[] = [12],
  ) {}

  /** The network's layer sizes. */
  get sizes(): number[] {
    return [this.inputs.length, ...this.hidden, this.actions.length];
  }

  /** The inputs as the network sees them. */
  encode(o: O): number[] {
    const raw = this.features(o);
    return raw.map((v, i) => Math.max(-3, Math.min(3, v / this.inputs[i].scale)));
  }

  /** Decide: by the network when asked and one is loaded, else by the scripted rule. */
  decide(o: O, mode: PolicyMode): Decision<A> {
    if (mode === 'net' && this.net) {
      const out = forward(this.net, this.encode(o));
      return { action: this.actions[argmax(out)], probs: softmax(out), mode };
    }
    return { action: this.scripted(o), probs: null, mode: 'scripted' };
  }

  /** Does a network fit this policy (its inputs and actions)? */
  fits(net: Net): boolean {
    const s = this.sizes;
    return net.sizes[0] === s[0] && net.sizes[net.sizes.length - 1] === s[s.length - 1];
  }
}
