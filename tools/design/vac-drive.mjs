// Feeds simulated positions into the plan's live vacuum (nothing reaches HA) and checks that its front points
// where it drives. Screenshots along the way.
import { openHA } from '../pw.mjs';
import { cardFn } from './fake.mjs';
const out = process.argv[2] ?? '/tmp';
const { browser, page, errors } = await openHA({ size: '1280x800', kiosk: true, companion: true, block: ['light', 'climate', 'vacuum', 'cover', 'media_player', 'fan', 'switch', 'tts', 'notify'] });
const card = cardFn(page);
await page.waitForTimeout(3000);
const ok = (c, m) => console.log(c ? '• ok:' : '• FAIL:', m);
const info = await card(`(() => { const gl = plan.gl; const [id, v] = [...gl.vacs][0] ?? []; if (!v) return null; return { id, tf: v.tf, mode: v.f.vacuum?.mode ?? 'delayed' }; })()`);
if (!info) { console.log('no live vacuum on the plan'); await browser.close(); process.exit(1); }
console.log('vacuum', info.id, JSON.stringify(info.tf), info.mode);
// a route in robot mm around the middle of the kitchen: robot centre from the plan centre of the kitchen
const start = await card(`(() => { const v = [...plan.gl.vacs][0][1]; const r = card.rawConfig.floors[0].rooms.find((x) => x.name === 'Küche'); const xs = r.points.map((p) => p[0]), ys = r.points.map((p) => p[1]); return v.m.toRobot((Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2); })()`);
const route = [];
for (let i = 0; i <= 10; i++) route.push([start[0] - 600 + i * 120, start[1]]); // straight
for (let i = 1; i <= 8; i++) route.push([start[0] + 600, start[1] + i * 100]); // turn 90°
for (let i = 1; i <= 10; i++) route.push([start[0] + 600 - i * 120, start[1] + 800]); // back
let seq = 1e9;
const checks = [];
for (let k = 0; k < route.length; k++) {
  await card(`(plan.gl.feedVacuum(${JSON.stringify(info.id)}, ${route[k][0]}, ${route[k][1]}, ${seq++}), true)`);
  await page.waitForTimeout(600);
  // front of the model (local +y) in plan coordinates vs. the last motion
  const st = await card(`(() => { const v = [...plan.gl.vacs][0][1]; const g = v.group; const a = g.rotation.z; return { p: [g.position.x, g.position.y], front: [-Math.sin(a), Math.cos(a)], vis: g.visible }; })()`);
  checks.push(st);
  if (k === 6 || k === 14 || k === 26) await page.screenshot({ path: `${out}/drive-${k}.png` });
}
let worst = 0;
let n = 0;
const angles = [];
for (let i = 4; i < checks.length; i++) {
  const a = checks[i - 2].p, b = checks[i].p;
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len < 10) continue;
  const cos = (dx * checks[i].front[0] + dy * checks[i].front[1]) / len;
  const ang = (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
  angles.push(Math.round(ang));
  // the two corners: turning there is fine
  if (!(i >= 10 && i <= 13) && !(i >= 18 && i <= 21)) worst = Math.max(worst, ang);
  n++;
}
console.log('  angles', angles.join(' '));
ok(n > 10 && worst < 20, `front points along the way (${n} checks, worst ${worst.toFixed(0)}° outside the corners)`);
console.log(errors.length ? errors.join('\n') : 'console: ok');
await browser.close();
