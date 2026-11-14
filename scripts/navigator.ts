/**
 * The Navigator on foot (src/sim/footNav.ts): walks the kerb, reaches a destination by road and
 * switches itself off there, and gets back to the vehicle within boarding reach.
 * Run with `npm run navigator`.
 */
import { FootNavigator, kerbside, FOOT_NAV } from '../src/sim/footNav.ts';
import { destinations } from '../src/sim/nav.ts';
import { ON_FOOT } from '../src/sim/bits.ts';
let fails = 0;
const check = (ok: boolean, l: string, d = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${l}${d ? `: ${d}` : ''}`); if (!ok) fails++; };
// Kerb: heading north (-z), the kerb is to the east (+x).
const k = kerbside([{ x: 0, z: 0 }, { x: 0, z: -100 }]);
check(Math.abs(k[1].x - FOOT_NAV.kerb) < 1e-6 && Math.abs(k[1].z + 100) < 1e-6, 'kerbside walks the right-hand kerb', JSON.stringify(k[1]));
// Walk to the nearest destination 300 m to 3 km away, with BitWalker's kinematics.
const w = { x: 0, z: 200, yaw: 0 };
const dest = destinations().map((d) => ({ d, m: Math.hypot(d.x - w.x, d.z - w.z) })).filter((x) => x.m > 300 && x.m < 3000).sort((a, b) => a.m - b.m)[0].d;
const nav = new FootNavigator();
check(nav.engage(w, 'goto', { x: dest.x, z: dest.z, name: dest.name, id: dest.id }) === null, 'engages a walk', dest.name);
let t = 0, vx = 0, vz = 0, arrived = false;
const dt = 1 / 60;
while (t < 1800) {
  const r = nav.sample(w, 6);
  if (r === 'arrived') { arrived = true; break; }
  w.yaw -= r.turn * ON_FOOT.turn * dt;
  const f = r.forward * ON_FOOT.speed;
  vx += (-Math.sin(w.yaw) * f - vx) * Math.min(1, ON_FOOT.accel * dt);
  vz += (-Math.cos(w.yaw) * f - vz) * Math.min(1, ON_FOOT.accel * dt);
  w.x += vx * dt; w.z += vz * dt; t += dt;
}
check(arrived, 'arrives at the destination', `${t.toFixed(0)} s, ${Math.hypot(w.x - dest.x, w.z - dest.z).toFixed(1)} m off`);
check(!nav.state.engaged && nav.state.status.startsWith('Arrived'), 'switches itself off on arrival', nav.state.status);
const v = new FootNavigator();
v.engage({ x: 10, z: 10, yaw: 0 }, 'vehicle', { x: 0, z: 0, name: 'your vehicle' });
check(v.sample({ x: 10, z: 10, yaw: 0 }, 20) === 'arrived', 'back to vehicle arrives within boarding reach');
process.exit(fails ? 1 : 0);
