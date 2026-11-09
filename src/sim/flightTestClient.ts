import type { CraftDef } from '../craft/types.ts';
import type { WeatherSettings } from './atmosphere.ts';
import { flightTest, gustyWeather, withGusty, type FlightReport } from './flightTest.ts';

type Pending = { resolve: (r: FlightReport) => void; reject: (e: Error) => void };
interface PoolWorker {
  worker: Worker;
  pending: Map<number, Pending>;
}

/** Two workers: the calm and the gusty flight of one test run side by side. */
const POOL_SIZE = 2;
let pool: PoolWorker[] | null = null;
let workerFailed = false;
let nextId = 1;

function failPool() {
  workerFailed = true;
  for (const pw of pool ?? []) {
    for (const p of pw.pending.values()) p.reject(new Error('worker unavailable'));
    pw.pending.clear();
    pw.worker.terminate();
  }
  pool = null;
}

function getPool(): PoolWorker[] | null {
  if (workerFailed || typeof Worker === 'undefined') return null;
  if (!pool) {
    try {
      pool = [];
      for (let i = 0; i < POOL_SIZE; i++) {
        const worker = new Worker(new URL('./flightTest.worker.ts', import.meta.url), { type: 'module' });
        const pw: PoolWorker = { worker, pending: new Map() };
        worker.onmessage = (e: MessageEvent<{ id: number; report?: FlightReport; error?: string }>) => {
          const p = pw.pending.get(e.data.id);
          if (!p) return;
          pw.pending.delete(e.data.id);
          if (e.data.report) p.resolve(e.data.report);
          else p.reject(new Error(e.data.error ?? 'flight test failed'));
        };
        // Fall back to the main thread if a worker can't start (old browser, CSP...).
        worker.onerror = () => failPool();
        pool.push(pw);
      }
    } catch {
      failPool();
      return null;
    }
  }
  return pool;
}

/** One flight in the least-busy worker, or on the main thread (chunked) without workers. */
async function flyOne(craft: CraftDef, weather?: WeatherSettings): Promise<FlightReport> {
  const workers = getPool();
  if (workers) {
    const pw = workers.reduce((a, b) => (b.pending.size < a.pending.size ? b : a));
    try {
      return await new Promise<FlightReport>((resolve, reject) => {
        const id = nextId++;
        pw.pending.set(id, { resolve, reject });
        pw.worker.postMessage({ id, craft, weather });
      });
    } catch (e) {
      if (!workerFailed) throw e;
    }
  }
  return flightTest(craft, { yieldEvery: 1500, weather });
}

/**
 * Flight-test a craft in Web Workers (keeps the game smooth while the Studio iterates),
 * falling back to the main thread, chunked with scheduler.yield/setTimeout. By default the
 * card is also flown in a gusty crosswind in parallel and attached as advisory `report.gusty`;
 * the headline score and pass stay the calm ones.
 */
export async function runFlightTest(craft: CraftDef, opts: { gusty?: boolean } = {}): Promise<FlightReport> {
  if (opts.gusty === false) return flyOne(craft);
  // The gusty flight is advisory: if it errors, return the calm report without it.
  const [calm, gusty] = await Promise.all([flyOne(craft), flyOne(craft, gustyWeather()).catch(() => null)]);
  return gusty ? withGusty(calm, gusty) : calm;
}
