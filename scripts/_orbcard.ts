import { ORBITER } from '../src/craft/orbiter.ts';
import { initPhysics } from '../src/sim/Simulation.ts';
import { flightTest, formatReport } from '../src/sim/flightTest.ts';
import { calmWeather, WEATHER_PRESETS } from '../src/sim/atmosphere.ts';
await initPhysics();
for (const w of [calmWeather(), { ...calmWeather(), ...WEATHER_PRESETS.moderate.settings }]) {
  const r = await flightTest(ORBITER, { weather: w });
  console.log(formatReport(r));
}
