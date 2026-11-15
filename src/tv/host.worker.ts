/// <reference lib="webworker" />
/**
 * The game off the page's main thread, so drawing and simulating use two cores (a Chromecast
 * has four slow ones). Two jobs:
 *
 * - 'host': run the game (TvHost) at real time, post a frame every tick, the pad context five
 *   times a second, and the architecture as it is planned (packed, moved without copying).
 * - 'plan': plan the architecture only (the phone runs the game; the TV still draws the city):
 *   the centre, then each planet chunk the phone's frames say is registered.
 *
 * Both start by sending the road lattice summary, so the page never builds it again.
 */
import { TEST_PLANE } from '../craft/testPlane.ts';
import { initPhysics, Simulation } from '../sim/Simulation.ts';
import { blockSummary } from '../world/planetCity.ts';
import { RemoteDevice } from '../input/RemoteDevice.ts';
import { TvHost, type HostOptions } from './host.ts';
import { parsePadMessage } from './protocol.ts';
import { StructurePlan } from './plan.ts';
import { packStructures, type StructurePack } from './structures.ts';

export type WorkerIn =
  | { t: 'start'; job: 'host' | 'plan'; opts?: HostOptions; structures?: boolean; bitLight?: string }
  /** Controls: from the phone's pad, or from this page's own keyboard / gamepad ('local'). */
  | { t: 'in'; msg: unknown; src?: 'pad' | 'local' }
  | { t: 'resync' }
  /** The page drew a frame and wants the next: frames follow the screen, never pile up. */
  | { t: 'want' }
  | { t: 'chunks'; list: number[] };

export type WorkerOut =
  | { t: 'progress'; text: string }
  | { t: 'summary'; data: Uint8Array }
  | { t: 'structs'; pack: StructurePack }
  | { t: 'ready' }
  | { t: 'frame'; f: ReturnType<TvHost['frame']> }
  | { t: 'ctx'; ctx: ReturnType<TvHost['context']> }
  | { t: 'rumble'; s: number; ms: number }
  /** Once a second: simulated seconds per real second, and the game's share of the worker's time. */
  | { t: 'stats'; realtime: number; busy: number }
  | { t: 'error'; text: string };

const scope = self as unknown as DedicatedWorkerGlobalScope;
const post = (m: WorkerOut, transfer: Transferable[] = []) => scope.postMessage(m, transfer);
const postPack = (pack: StructurePack) => post({ t: 'structs', pack }, [pack.data.buffer]);

let host: TvHost | null = null;
/** Frames the page may still take (it asks for each as it draws). */
let credit = 2;
const local = new RemoteDevice();
let bitLight = '#3d7cff';
// Plan job: the host's structure list, rebuilt from its chunk list.
let plan: StructurePlan | null = null;

scope.onmessage = (e: MessageEvent<WorkerIn>) => {
  const m = e.data;
  if (m.t === 'start') void start(m.job, m.opts ?? {}, m.structures !== false, m.bitLight);
  else if (m.t === 'in') {
    const msg = parsePadMessage(m.msg);
    if (msg?.t === 'in') (m.src === 'local' ? local : host?.remote)?.apply(msg);
  } else if (m.t === 'resync') host?.resync();
  else if (m.t === 'want') credit = Math.min(2, credit + 1);
  else if (m.t === 'chunks') planChunks(m.list);
};

async function start(job: 'host' | 'plan', opts: HostOptions, structures: boolean, light?: string): Promise<void> {
  try {
    if (light) bitLight = light;
    post({ t: 'progress', text: 'Laying out the Grid…' });
    if (structures) post({ t: 'summary', data: blockSummary().slice() });
    if (job === 'plan') {
      post({ t: 'progress', text: 'Planning the city…' });
      plan = new StructurePlan();
      postPack(packStructures(plan.list, 0));
      post({ t: 'ready' });
      return;
    }
    await initPhysics();
    post({ t: 'progress', text: 'Building the world…' });
    const sim = new Simulation(TEST_PLANE);
    host = new TvHost(sim, [local], opts);
    host.remote.onRumble = (s, ms) => post({ t: 'rumble', s, ms });
    let sent = 0;
    const sendStructs = () => {
      const list = sim.staticWorld.structures.list;
      if (!structures || list.length === sent) return;
      postPack(packStructures(list, sent));
      sent = list.length;
    };
    sendStructs();
    post({ t: 'ready' });
    let last = performance.now();
    let ctxAt = 0;
    let statsAt = performance.now(), statsSim = sim.time, busy = 0;
    // Its own clock, not the page's frames: a slow screen must not slow the game.
    const loop = () => {
      const now = performance.now();
      const dt = Math.min(0.25, (now - last) / 1000);
      last = now;
      host!.tick(dt);
      sendStructs();
      if (credit > 0) {
        credit--;
        post({ t: 'frame', f: host!.frame(bitLight) });
      }
      if (now - ctxAt > 200) {
        ctxAt = now;
        post({ t: 'ctx', ctx: host!.context() });
      }
      busy += performance.now() - now;
      if (now - statsAt > 1000) {
        post({ t: 'stats', realtime: (sim.time - statsSim) / ((now - statsAt) / 1000), busy: busy / (now - statsAt) });
        statsAt = now;
        statsSim = sim.time;
        busy = 0;
      }
      setTimeout(loop, Math.max(1, 16 - (performance.now() - now)));
    };
    loop();
  } catch (err) {
    post({ t: 'error', text: err instanceof Error ? err.message : String(err) });
  }
}

/** Plan job: the chunks the host registered since the last list. */
function planChunks(list: number[]): void {
  if (!plan) return; // the centre is not planned yet; the next list carries these too
  const start = plan.addChunks(list);
  if (plan.list.length > start) postPack(packStructures(plan.list, start));
}
