// "Live testen" in Alarmanlage → Ton & Sirene, in the preview (example data, nothing to hear): the first test asks
// before it plays, then a big "Stopp" with the seconds left shows; the volume stepper follows a running test; "Stopp"
// ends it; the test ends by itself after its time.
//   node tools/build.mjs && sh ../tools/heavy.sh browser node tools/test-siren-test.mjs
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';

writeFileSync('dist/preview-local.html', `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>${readFileSync('dist/preview.html', 'utf8')}</body></html>`);
let fails = 0;
const ok = (c, m, extra) => {
  if (!c) fails++;
  console.log(c ? '  ok:' : '  FAIL:', m, !c && extra !== undefined ? JSON.stringify(extra).slice(0, 300) : '');
};
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto('file://' + process.cwd() + '/dist/preview-local.html');
await page.waitForSelector('house-rules-panel');
await page.waitForTimeout(500);

/** run code with `v` = the alarm view, its "Ton & Sirene" pop-up open */
const V = (body) =>
  page.evaluate(
    new Function(`return (async () => {
      const panel = document.querySelector('house-rules-panel');
      const v = panel.shadowRoot.querySelector('hr-alarm-view') ?? [...panel.shadowRoot.querySelectorAll('*')].find((e) => e.localName.startsWith('hr-alarm'));
      const q = (sel) => v.shadowRoot.querySelector(sel);
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      ${body}
    })()`),
  );

await page.evaluate(async () => {
  const panel = document.querySelector('house-rules-panel');
  panel._setTab('alarm', '');
  await panel.updateComplete;
});
await page.waitForTimeout(500);
const tag = await V(`return v?.localName ?? null;`);
ok(!!tag, `alarm view found (${tag})`);
await V(`v._pops = ['sound']; await v.updateComplete; await wait(300); return true;`);

ok(await V(`return !!q('[data-siren-test]');`), '"Live testen" is offered');
await V(`v._sirenSec = 3; await v.updateComplete; q('[data-siren-test]').click(); await v.updateComplete; await wait(200); return true;`);
ok(await V(`return !!q('[data-siren-go]') && !v.store.alarm.siren_test;`), 'the first test asks first, nothing plays yet');
await V(`q('[data-siren-go]').click(); await wait(400); await v.updateComplete; return true;`);
const run = await V(`return { test: v.store.alarm.siren_test, stop: q('[data-siren-stop]')?.textContent.trim() };`);
ok(run.test && run.test.volume === 80 && /Stopp/.test(run.stop ?? ''), 'running at the set volume, a "Stopp" with the seconds left', run);
await page.screenshot({ path: '/tmp/siren-test-running.png' }).catch(() => {});

// the volume stepper follows the running test
await V(`v._save({ sound: { ...v.store.alarm.config.sound, volume: 50 } }); await v.store.alarmSirenTest(3, 50); await v.updateComplete; return true;`);
ok((await V(`return v.store.alarm.siren_test?.volume;`)) === 50, 'the volume follows live');

await V(`q('[data-siren-stop]').click(); await wait(300); await v.updateComplete; return true;`);
ok(await V(`return !v.store.alarm.siren_test && !!q('[data-siren-test]');`), '"Stopp" ends it at once');

// asked once per visit: the second test starts right away and ends by itself
await V(`q('[data-siren-test]').click(); await wait(300); await v.updateComplete; return true;`);
ok(await V(`return !!v.store.alarm.siren_test && !q('[data-siren-go]');`), 'the second test starts without asking again');
await page.waitForTimeout(3600);
ok(await V(`await v.updateComplete; return !v.store.alarm.siren_test;`), 'the test ends by itself after its time');

ok(!errors.length, 'no page errors', errors);
await browser.close();
console.log(fails ? `\n${fails} FAIL` : '\nalles ok');
process.exit(fails ? 1 : 0);
