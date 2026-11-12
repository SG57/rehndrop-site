// Fails if the formulas or tokens in src/lib/essence.ts drift from the contract.
// Expected values are hard-coded; they were computed independently (separate Python
// implementation of the contract formulas), not by calling essence.ts. Run: node scripts/check_essence.mjs
// ESSENCE_FILE=<path> checks another copy (used to prove the check fails on drift).
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const file = resolve(process.env.ESSENCE_FILE ?? new URL('../src/lib/essence.ts', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const E = await import(pathToFileURL(file).href);

let fails = 0;
let n = 0;
const near = (got, want, label, tol = 1e-9) => {
  n++;
  const ok = Array.isArray(want) ? want.length === got.length && want.every((v, i) => Math.abs(got[i] - v) <= tol) : Math.abs(got - want) <= tol;
  if (!ok) {
    fails++;
    console.error(`FAIL ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
  }
};
const same = (got, want, label) => {
  n++;
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    fails++;
    console.error(`FAIL ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
  }
};

// constants
same(E.ESSENCES, ['candle', 'chrome', 'dawn'], 'ESSENCES');
near(E.PERIOD_S, 300, 'PERIOD_S');
near(E.SOFTNESS, 1.6, 'SOFTNESS');
near(E.SWELL_CYCLE_S, 180, 'SWELL_CYCLE_S');
near(E.SWELL_GAIN, 3.0, 'SWELL_GAIN');
near([E.centre(0), E.centre(1), E.centre(2)], [0, 2.0943951023931953, 4.1887902047863905], 'centres');

// weights(angle, swell)
near(E.weights(0), [0.8464276347, 0.0767861826, 0.0767861826], 'weights(0)', 1e-9);
near(E.weights(1.0), [0.5095171983, 0.4470696828, 0.0434131189], 'weights(1)', 1e-9);
near(E.weights(2.5, [0.5, 0, 1]), [0.0830215175, 0.5205162438, 0.3964622387], 'weights(2.5,swell)', 1e-9);
near(E.weights(5.5, [0, 1, 0.25]), [0.4708556934, 0.1293359411, 0.3998083654], 'weights(5.5,swell)', 1e-9);
near(E.weights(3.3).reduce((s, v) => s + v, 0), 1, 'weights sum');

// angleAt(x, y, vw, vh, t)
near(E.angleAt(960, 540, 1920, 1080, 0), 0, 'angleAt centre');
near(E.angleAt(100, 900, 1920, 1080, 37.5), -1.9597532069739034, 'angleAt lower-left');
near(E.angleAt(1500, 100, 800, 1200, 300), 6.709812800306462, 'angleAt portrait, one period');
near(E.angleAt(0, 0, 1000, 1000, 123.4), 4.940678046545548, 'angleAt top-left');

// timeCycleSwell
for (const [t, e, b] of [[0, 0, 0], [45, 0, 0.5], [90, 0, 1], [135, 0, 0.5], [180, 1, 0], [270, 1, 1], [450, 2, 1], [540, 0, 0], [600, 0, 0.75]]) {
  const want = [0, 0, 0];
  want[e] = b;
  near(E.timeCycleSwell(t), want, `timeCycleSwell(${t})`, 1e-9);
}

// dayFactor
for (const [h, d] of [[0, 0], [4, 0], [5, 0], [6.5, 0.5], [8, 1], [12, 1], [17, 1], [18.5, 0.5], [20, 0], [23, 0]]) near(E.dayFactor(h), d, `dayFactor(${h})`, 1e-9);

// tokens (hex from the contract, as numbers)
same(E.ESSENCE_TOKENS, {
  candle: { a: [216, 154, 79], g: [40, 8, 14, 0.58], e: [185, 138, 62], r: 12, glow: 0.5 },
  chrome: { a: [141, 177, 220], g: [6, 10, 16, 0.62], e: [143, 163, 184], r: 3, glow: 0.35 },
  dawn: { a: [231, 183, 166], g: [70, 46, 52, 0.42], e: [233, 214, 168], r: 26, glow: 0.8 },
}, 'ESSENCE_TOKENS');

// skinVars: pure essences at night, a blend (edge painted at .8; glow is the plain weighted mix, as in the prototype)
same(E.skinVars([1, 0, 0]), { a: 'rgb(216,154,79)', g: 'rgba(40,8,14,0.58)', e: 'rgba(185,138,62,0.8)', r: '12.0px', glow: '0.50' }, 'skinVars candle');
same(E.skinVars([0, 1, 0]), { a: 'rgb(141,177,220)', g: 'rgba(6,10,16,0.62)', e: 'rgba(143,163,184,0.8)', r: '3.0px', glow: '0.35' }, 'skinVars chrome');
same(E.skinVars([0, 0, 1]), { a: 'rgb(231,183,166)', g: 'rgba(70,46,52,0.42)', e: 'rgba(233,214,168,0.8)', r: '26.0px', glow: '0.80' }, 'skinVars dawn');
same(E.skinVars([0.25, 0.4, 0.35]), { a: 'rgb(191,173,166)', g: 'rgba(37,22,28,0.54)', e: 'rgba(185,175,148,0.8)', r: '13.3px', glow: '0.54' }, 'skinVars blend');

if (fails) {
  console.error(`check_essence: ${fails} of ${n} checks failed`);
  process.exit(1);
}
console.log(`check_essence: ${n} checks ok`);
