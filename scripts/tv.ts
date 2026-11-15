/**
 * The TV view and the phone as its gamepad (tv.html, pad.html). Run with `npm run tv`.
 *
 * 1. The pad protocol: messages are checked (numbers clamped, unknown actions dropped), the
 *    packer keeps one-shots (lever, flaps, button presses) until they are sent, and a remote pad
 *    that goes quiet leaves the controls hands-off.
 * 2. The game as the TV runs it: the phone's controls drive the vehicle (a light cycle rides
 *    off along the street it starts on: ground vehicles start on a road), pad actions switch
 *    vehicles, and the frames are small enough to send (controls ride the relay; frames ride
 *    the cast channel) and survive the network check unchanged.
 * 3. The architecture the TV draws matches the game's: rebuilt from the chunk list (when the
 *    phone runs the game) it has the same pieces and group ids as the game's StaticWorld, so a
 *    fractured structure is hidden on the TV too.
 * 4. The Canvas 2D renderer draws a frame through a stand-in canvas: the craft lands on screen,
 *    view actions apply once per frame, nothing throws.
 */
import { LIGHT_CYCLE } from '../src/craft/lightCycle.ts';
import { RemoteDevice } from '../src/input/RemoteDevice.ts';
import { PlayerInput } from '../src/input/PlayerInput.ts';
import { initPhysics, Simulation } from '../src/sim/Simulation.ts';
import { nearestRoadPoint } from '../src/world/spawnSites.ts';
import { worldStructures } from '../src/world/structures.ts';
import { StructurePlan } from '../src/tv/plan.ts';
import { craftShape, sanitizeFrame } from '../src/tv/frame.ts';
import { TvHost } from '../src/tv/host.ts';
import { isPairCode, PAD_STALE, PadInputPacker, pairCode, parsePadMessage, parseTvMessage, type PadInputMsg } from '../src/tv/protocol.ts';
import { packStructures, PIECE, StructureStore } from '../src/tv/structures.ts';
import { TvRenderer } from '../src/tv/TvRenderer.ts';

let failures = 0;
const check = (ok: boolean, label: string, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? `: ${detail}` : ''}`);
  if (!ok) failures++;
};

console.log('--- the pad protocol');
{
  const m = parsePadMessage({ t: 'in', s: 3, ax: [5, -9, 0.5, 0, 2, 0, 0, 0], b: 99, th: 7, a: ['nextVehicle', 'studio', 'debug', 'camera'] }) as PadInputMsg;
  check(!!m && m.ax[0] === 1 && m.ax[1] === -1 && m.ax[4] === 1, 'axes are clamped to their range', JSON.stringify(m?.ax));
  check(m.b === 7 && m.th === 1, 'buttons and the lever are kept in range', `b=${m.b} th=${m.th}`);
  check(JSON.stringify(m.a) === '["nextVehicle","camera"]', 'only the actions the TV carries out pass', JSON.stringify(m.a));
  check(parsePadMessage('{"t":"in","s":1') === null && parsePadMessage({ t: 'nope' }) === null, 'malformed messages are dropped');
  check(parseTvMessage({ t: 'ctx', profile: 'warp', thr: 3, lines: ['a', 4] })?.t === 'ctx', 'a TV context is read leniently');
  const pk = new PadInputPacker();
  const raw = PlayerInput.emptyRaw();
  pk.add({ ...raw, throttleSet: 0.4 }, ['camera']);
  pk.add({ ...raw, flapSteps: 1 }, []);
  pk.add({ ...raw, pitch: 0.3 }, ['nextVehicle']);
  check(pk.urgent, 'one-shots ask to be sent at once');
  const out = pk.take();
  check(out.th === 0.4 && out.fs === 1 && out.ax[0] === 0.3 && out.a?.length === 2, 'the packer keeps every one-shot between sends', JSON.stringify(out));
  check(pk.take().a === undefined && !pk.urgent, 'and sends each only once');
  let now = 0;
  const dev = new RemoteDevice(() => now);
  dev.apply({ t: 'in', s: 1, ax: [0.8, 0, 0, 0, 0, 0, 0, 0], b: 1 });
  const r1 = PlayerInput.emptyRaw();
  dev.read(r1, { profile: 'airplane', throttle: 0, settings: { invertPitch: false, touchControls: 'auto', expo: 0, haptics: false } });
  now = PAD_STALE + 0.1;
  const r2 = PlayerInput.emptyRaw();
  dev.read(r2, { profile: 'airplane', throttle: 0, settings: { invertPitch: false, touchControls: 'auto', expo: 0, haptics: false } });
  check(r1.pitch === 0.8 && r1.fire && r2.pitch === 0 && !r2.fire, 'a pad that goes quiet leaves the controls hands-off');
  // The same message over two links counts once; a pad that reconnects (counting from 1 again) is heard.
  for (let s = 2; s < 900; s++) dev.apply({ t: 'in', s, ax: [0, 0, 0, 0, 0, 0, 0, 0], b: 0 });
  dev.apply({ t: 'in', s: 900, ax: [0, 0, 0, 0, 0, 0, 0, 0], b: 0, a: ['camera'] });
  dev.apply({ t: 'in', s: 900, ax: [0, 0, 0, 0, 0, 0, 0, 0], b: 0, a: ['camera'] });
  dev.apply({ t: 'in', s: 1, ax: [0, 0.5, 0, 0, 0, 0, 0, 0], b: 0 });
  const acts: string[] = [];
  dev.drainActions(acts as never[]);
  const r3 = PlayerInput.emptyRaw();
  dev.read(r3, { profile: 'airplane', throttle: 0, settings: { invertPitch: false, touchControls: 'auto', expo: 0, haptics: false } });
  check(acts.length === 1 && r3.roll === 0.5, 'a message heard twice counts once; a reconnected pad is heard at once', `${acts.length} action(s), roll ${r3.roll}`);
  const codes = new Set(Array.from({ length: 200 }, (_, i) => pairCode(() => ((i * 7919) % 1000) / 1000)));
  check([...codes].every(isPairCode) && !isPairCode('HOST') && !isPairCode('ab1'), 'pairing codes use only unambiguous letters');
}

console.log('--- the game as the TV runs it');
await initPhysics();
{
  let clock = 0;
  const host = new TvHost(new Simulation(LIGHT_CYCLE), [], { craft: 'cycle', lite: true }, () => clock);
  const sim = host.sim;
  const start = sim.position.clone();
  const road = nearestRoadPoint(start.x, start.z);
  check(!!road && Math.hypot(road.x - start.x, road.z - start.z) < 4, 'the light cycle starts on a road', road ? `${Math.hypot(road.x - start.x, road.z - start.z).toFixed(1)} m from the road point` : 'no road');
  let seq = 1;
  const send = (m: Partial<PadInputMsg>) => host.remote.apply({ t: 'in', s: seq++, ax: [0, 0, 0, 0, 0, 0, 0, 0], b: 0, ...m });
  // Stick forward (pitch -1 is "push up": go) for six seconds.
  for (let i = 0; i < 360; i++) {
    clock += 1 / 60;
    send({ ax: [-1, 0, 0, 0, 0, 0, 0, 0] });
    host.tick(1 / 60);
  }
  const moved = Math.hypot(sim.position.x - start.x, sim.position.z - start.z);
  check(moved > 25, 'the phone\'s stick drives the vehicle', `${moved.toFixed(0)} m in 6 s`);
  let f = host.frame();
  check(!!f.craft && f.craft.parts.length === sim.craft.def.parts.length, 'the first frame carries the craft');
  const bytes = JSON.stringify(f).length;
  const f2 = host.frame();
  const bytes2 = JSON.stringify(f2).length;
  check(!f2.craft && bytes2 < 16000, 'frames stay small enough for the cast channel (64 KB a message)', `${bytes} bytes with the craft, ${bytes2} without`);
  const back = sanitizeFrame(JSON.parse(JSON.stringify(f)));
  check(!!back && JSON.stringify(back.riders) === JSON.stringify(f.riders) && back.me.p.join() === f.me.p.join() && back.craft?.parts.length === f.craft?.parts.length,
    'a frame survives the network check unchanged');
  check(sanitizeFrame({ ...f, me: { ...f.me, p: [NaN, 0, 0] } }) === null && sanitizeFrame({ v: 99 }) === null, 'a broken frame is refused');
  const ctx = host.context();
  check(ctx.profile === 'ground' && !ctx.foot && ctx.lines.length >= 2, 'the pad hears the vehicle\'s control profile and readouts', JSON.stringify(ctx));
  const name0 = sim.craft.def.name;
  send({ a: ['nextVehicle'] });
  clock += 1 / 60;
  host.tick(1 / 60);
  f = host.frame();
  check(sim.craft.def.name !== name0 && f.notes.length > 0, 'pad actions switch vehicles and say so', `${name0} → ${sim.craft.def.name}`);
  send({ a: ['camera', 'help'] });
  clock += 1 / 60;
  host.tick(1 / 60);
  check(host.frame().ui.join() === 'camera,help', 'view actions go to the screen, not the game');
}

console.log('--- the architecture the TV draws');
{
  // The game registers planet chunks as the player travels; the TV rebuilds the same list.
  const sim = new Simulation(LIGHT_CYCLE);
  const w = worldStructures();
  for (const [x, z] of [[9000, 0], [9000, 1500], [-9000, -2500], [24000, 3000]]) sim.staticWorld.stream(x, z, true);
  const flat: number[] = [];
  for (const c of sim.staticWorld.outerChunks.values()) flat.push(c.ci, c.cj, c.ox, c.oz);
  const plan = new StructurePlan();
  plan.addChunks(flat.slice(0, 8));
  plan.addChunks(flat); // lists arrive whole, again and again: only the new tail is added
  const host = sim.staticWorld.structures.list;
  const a = packStructures(host, w.list.length), b = packStructures(plan.list, w.list.length);
  const wrapped = [...sim.staticWorld.outerChunks.values()].filter((c) => c.ox !== 0 || c.oz !== 0).length;
  const back = JSON.parse(JSON.stringify(flat)) as number[]; // as the frames carry it
  const replan = new StructurePlan();
  replan.addChunks(back);
  const c2 = packStructures(replan.list, w.list.length);
  check(sim.staticWorld.outerChunks.size >= 3 && wrapped > 0 && a.data.length === b.data.length && a.data.every((v, i) => v === b.data[i] && v === c2.data[i]),
    'the chunk list rebuilds the game\'s pieces and group ids, across the wrap too', `${sim.staticWorld.outerChunks.size} chunks (${wrapped} across the seam), ${a.data.length / PIECE} pieces`);
  const store = new StructureStore();
  check(store.add(packStructures(plan.list, 0)) && !store.add(packStructures(plan.list, 5)), 'packs must arrive in order');
  let longest = 0;
  for (let i = 0; i < store.count; i++) if (store.data[i * PIECE] === 0) longest = Math.max(longest, store.data[i * PIECE + 4], store.data[i * PIECE + 6]);
  check(store.count > plan.list.length && longest <= 70, 'long boxes are cut for the painter\'s sort', `${store.count} pieces from ${plan.list.length} structures, longest ${longest.toFixed(0)} m`);
  const near: number[] = [];
  store.near(0, 0, 400, near);
  check(near.length > 0, 'the grid index finds the centre\'s structures', `${near.length} near the origin`);
}

console.log('--- the Canvas 2D renderer');
{
  const fills: number[][] = [];
  let cur: number[] = [];
  const g: Record<string, unknown> = new Proxy({}, {
    get(_t, k) {
      if (k === 'beginPath') return () => { cur = []; };
      if (k === 'moveTo' || k === 'lineTo') return (x: number, y: number) => { cur.push(x, y); };
      if (k === 'fill') return () => { fills.push(cur); };
      if (k === 'measureText') return () => ({ width: 40 });
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => ({ addColorStop() {} });
      return () => {};
    },
    set() { return true; },
  });
  const canvas = { getContext: () => g, width: 0, height: 0 } as unknown as HTMLCanvasElement;
  const store = new StructureStore();
  store.add(packStructures(worldStructures().list, 0));
  const r = new TvRenderer(canvas, store);
  r.resize(1280, 720);
  const sim = new Simulation(LIGHT_CYCLE);
  const host = new TvHost(sim, [], { lite: true });
  host.tick(0.1);
  const f = host.frame();
  f.craft = craftShape(sim.craft.def, f.me.craft, sim.craft.boundingRadius());
  f.ui = ['camera'];
  let threw = '';
  try {
    for (let i = 0; i < 20; i++) { fills.length = 0; r.draw(f, 0.1); }
  } catch (e) { threw = String(e); }
  check(!threw, 'a frame draws without an error', threw);
  const onScreen = fills.filter((p) => p.length >= 6 && p.every((v, i) => (i % 2 ? v > 0 && v < 720 : v > 0 && v < 1280))).length;
  check(onScreen > 20, 'faces land on screen', `${onScreen} filled faces`);
  check(r.mode === 'far', 'a view action applies once, however often its frame is drawn', r.mode);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll TV checks passed');
if (failures) process.exit(1);
