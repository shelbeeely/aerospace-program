import type { CraftDef } from '../craft/types.ts';
import { flightTest, type FlightReport } from './flightTest.ts';

type Pending = { resolve: (r: FlightReport) => void; reject: (e: Error) => void };

let worker: Worker | null = null;
let workerFailed = false;
let nextId = 1;
const pending = new Map<number, Pending>();

function getWorker(): Worker | null {
  if (workerFailed || typeof Worker === 'undefined') return null;
  if (!worker) {
    try {
      worker = new Worker(new URL('./flightTest.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (e: MessageEvent<{ id: number; report?: FlightReport; error?: string }>) => {
        const p = pending.get(e.data.id);
        if (!p) return;
        pending.delete(e.data.id);
        if (e.data.report) p.resolve(e.data.report);
        else p.reject(new Error(e.data.error ?? 'flight test failed'));
      };
      worker.onerror = () => {
        // Fall back to the main thread if the worker can't start (old browser, CSP...).
        workerFailed = true;
        worker = null;
        for (const p of pending.values()) p.reject(new Error('worker unavailable'));
        pending.clear();
      };
    } catch {
      workerFailed = true;
      return null;
    }
  }
  return worker;
}

/**
 * Flight-test a craft in a Web Worker (keeps the game smooth while the Studio iterates),
 * falling back to the main thread, chunked with scheduler.yield/setTimeout.
 */
export async function runFlightTest(craft: CraftDef): Promise<FlightReport> {
  const w = getWorker();
  if (w) {
    try {
      return await new Promise<FlightReport>((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        w.postMessage({ id, craft });
      });
    } catch (e) {
      if (!workerFailed) throw e;
    }
  }
  return flightTest(craft, { yieldEvery: 1500 });
}
