// Unit test of src/client-info.ts (what the card reports for the anonymous diagnostics): browser families from
// user agents, performance tiers. Runs in Node (no browser). Usage: node tools/tests/client-info.mjs
import { build } from 'esbuild';

const out = await build({ entryPoints: [new URL('../../src/client-info.ts', import.meta.url).pathname], bundle: true, format: 'esm', write: false, platform: 'neutral' });
const m = await import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'));
let fails = 0;
const eq = (got, want, what) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(ok ? '  ok:' : '• FAIL:', what, ok ? '' : `${JSON.stringify(got)} ≠ ${JSON.stringify(want)}`);
};
const UA = {
  chrome: 'Mozilla/5.0 (Linux; Android 12; SM-T500) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  samsung: 'Mozilla/5.0 (Linux; Android 12; SM-T500) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Safari/537.36',
  fully: 'Mozilla/5.0 (Linux; Android 11; Lenovo TB-X606F) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/118.0.0.0 Safari/537.36 Fully Kiosk Browser',
  edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
  firefox: 'Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0',
  safari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
  iosChrome: 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0 Mobile/15E148 Safari/604.1',
  haApp: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Home Assistant/2024.10.0',
};
eq(m.browserOf(UA.chrome), { browser: 'chrome', engine: 'blink', engine_version: 130 }, 'Chrome auf Android');
eq(m.browserOf(UA.samsung).browser, 'samsung', 'Samsung Internet');
eq(m.browserOf(UA.fully), { browser: 'fully', engine: 'blink', engine_version: 118 }, 'Fully Kiosk');
eq(m.browserOf(UA.edge).browser, 'edge', 'Edge');
eq(m.browserOf(UA.firefox), { browser: 'firefox', engine: 'gecko', engine_version: 133 }, 'Firefox');
eq(m.browserOf(UA.safari), { browser: 'safari', engine: 'webkit', engine_version: 18 }, 'Safari');
eq(m.browserOf(UA.iosChrome), { browser: 'chrome', engine: 'webkit', engine_version: 17 }, 'Chrome auf iPad ist WebKit');
eq(m.browserOf(UA.haApp), { browser: 'ha_app', engine: 'webkit', engine_version: 18 }, 'Home-Assistant-App');
eq(m.browserOf('curl/8'), { browser: 'other', engine: 'other', engine_version: 0 }, 'Unbekanntes');
eq(m.tierOf([5, 6, 7], '3d'), 'fast', 'Stufe schnell');
eq(m.tierOf([12, 40, 14], '3d'), 'ok', 'Stufe ok (Median)');
eq(m.tierOf([20, 25], '3d'), 'slow', 'Stufe langsam');
eq(m.tierOf([50], '3d'), 'very_slow', 'Stufe sehr langsam');
eq(m.tierOf([], '3d'), '2d', 'ohne 3D-Bilder');
eq(m.tierOf([5], '2d'), '2d', '2D-Ansicht');
console.log(fails ? `\n${fails} FAILED` : '\nall ok');
process.exit(fails ? 1 : 0);
