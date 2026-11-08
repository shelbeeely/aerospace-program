/// <reference lib="webworker" />
/**
 * Runs automated flight tests off the main thread: ~150 simulated seconds of Rapier physics per
 * test would otherwise compete with rendering while the Studio designs craft.
 */
import type { CraftDef } from '../craft/types.ts';
import { flightTest } from './flightTest.ts';
import { initPhysics } from './Simulation.ts';

interface Request {
  id: number;
  craft: CraftDef;
}

const ready = initPhysics();

self.onmessage = async (e: MessageEvent<Request>) => {
  const { id, craft } = e.data;
  try {
    await ready;
    const report = await flightTest(craft);
    self.postMessage({ id, report });
  } catch (err) {
    self.postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
