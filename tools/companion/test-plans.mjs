// Shared floor plans and trace images of the companion integration against the isolated test Home Assistant (never a real
// one): save / list / get, revisions and conflicts, size and frame checks, live push to subscribers, delete, admin-only
// writes (a non-admin user may read), images with their limits. Run inside the test HA lock:
//   sh tools/heavy.sh testha sh -c 'sh hausregeln/tools/testha/start.sh && node tools/tests/testha-setup.mjs && node tools/companion/test-plans.mjs'
import { token, wsConnect, userToken, rest, ok, failures, until } from '../../hausregeln/tools/testha/lib.mjs';

const tok = await token();
const api = rest(tok);
const ws = await wsConnect(tok);
// the companion is set up once (one click, nothing to fill in)
let info = await ws.call({ type: 'floorplan_card/info' }).catch(() => undefined);
if (!info?.loaded) {
  const flow = await api('POST', '/api/config/config_entries/flow', { handler: 'floorplan_card' });
  if (flow.body?.type === 'form') await api('POST', `/api/config/config_entries/flow/${flow.body.flow_id}`, {});
  info = await until(() => ws.call({ type: 'floorplan_card/info' }).then((i) => (i.loaded ? i : undefined)).catch(() => undefined), 15000);
}
ok(info?.loaded && info.features?.includes('plans') && info.features?.includes('images'), 'companion loaded, offers plans and images', info);

const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const plan = { floors: [{ id: 'f1', name: 'Wohnung', rooms: [{ id: 'r1', name: 'Wohnen', points: rect(0, 0, 400, 300) }], devices: [] }], north: 15, title: 'nicht Teil des Plans' };

// save a new plan; only the plan's own keys are kept
const s1 = await ws.call({ type: 'floorplan_card/plans/save', name: 'Testhaus', plan });
ok(/^plan_[0-9a-f]{8}$/.test(s1.id) && s1.rev === 1 && s1.rooms === 1, 'new plan saved (revision 1)', s1);
const got = await ws.call({ type: 'floorplan_card/plans/get', plan_id: s1.id });
ok(got.plan.north === 15 && got.plan.floors[0].rooms[0].name === 'Wohnen' && !('title' in got.plan), 'get: content, only plan keys', got.plan);
const list = await ws.call({ type: 'floorplan_card/plans/list' });
ok(list.plans.some((p) => p.id === s1.id && p.name === 'Testhaus' && p.floors === 1), 'listed');

// live: a subscriber gets the plan now and after each save
const pushed = [];
await ws.sub({ type: 'floorplan_card/plans/subscribe', plan_id: s1.id }, (e) => pushed.push(e));
await until(() => pushed.length >= 1);
ok(pushed[0]?.rev === 1, 'subscribe: current plan pushed at once');
const s2 = await ws.call({ type: 'floorplan_card/plans/save', plan_id: s1.id, name: 'Testhaus', plan: { ...plan, north: 30 }, rev: 1 });
await until(() => pushed.length >= 2);
ok(s2.rev === 2 && pushed[1]?.rev === 2 && pushed[1].plan.north === 30, 'new revision pushed to the subscriber');

// conflict: saving on top of an old revision is refused unless forced
const conflict = await ws.call({ type: 'floorplan_card/plans/save', plan_id: s1.id, name: 'Testhaus', plan, rev: 1 }).catch((e) => e.message);
ok(String(conflict).startsWith('conflict'), `old revision: conflict (${conflict})`);
const forced = await ws.call({ type: 'floorplan_card/plans/save', plan_id: s1.id, name: 'Testhaus', plan, rev: 1, force: true });
ok(forced.rev === 3, 'forced: revision 3');

// frame and size checks
const noFloors = await ws.call({ type: 'floorplan_card/plans/save', name: 'x', plan: { floors: [] } }).catch((e) => e.message);
ok(String(noFloors).startsWith('invalid'), `no floor: refused (${noFloors})`);
const huge = { floors: [{ id: 'f', name: 'x', rooms: [{ id: 'r', name: 'x'.repeat(1_600_000), points: rect(0, 0, 1, 1) }] }] };
const tooBig = await ws.call({ type: 'floorplan_card/plans/save', name: 'x', plan: huge }).catch((e) => e.message);
ok(String(tooBig).startsWith('too_large'), `too large: refused (${String(tooBig).slice(0, 60)})`);
const badId = await ws.call({ type: 'floorplan_card/plans/get', plan_id: '../etc' }).catch((e) => e.message);
ok(/invalid_format|not_found/.test(String(badId)), `bad id refused (${String(badId).slice(0, 50)})`);

// trace images: data URLs only, with a size limit
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const img = await ws.call({ type: 'floorplan_card/images/save', data: png, width: 1, height: 1 });
ok(/^img_[0-9a-f]{8}$/.test(img.id), 'image stored');
ok((await ws.call({ type: 'floorplan_card/images/get', image_id: img.id })).data === png, 'image read back');
const notImg = await ws.call({ type: 'floorplan_card/images/save', data: 'data:text/html;base64,PGI+' }).catch((e) => e.message);
ok(String(notImg).startsWith('invalid'), `not a picture: refused (${notImg})`);
const bigImg = await ws.call({ type: 'floorplan_card/images/save', data: 'data:image/jpeg;base64,' + 'A'.repeat(1_600_000) }).catch((e) => e.message);
ok(String(bigImg).startsWith('too_large'), 'picture too large: refused');

// a non-admin user may read and follow, never write
const user = await userToken(tok, 'tablet', false);
const uws = await wsConnect(user);
ok((await uws.call({ type: 'floorplan_card/plans/get', plan_id: s1.id })).rev === 3, 'non-admin: can read the plan');
ok((await uws.call({ type: 'floorplan_card/images/get', image_id: img.id })).data === png, 'non-admin: can read the image');
for (const msg of [
  { type: 'floorplan_card/plans/save', name: 'x', plan },
  { type: 'floorplan_card/plans/delete', plan_id: s1.id },
  { type: 'floorplan_card/images/save', data: png },
  { type: 'floorplan_card/images/delete', image_id: img.id },
]) {
  const r = await uws.call(msg).catch((e) => e.message);
  ok(String(r).startsWith('unauthorized'), `non-admin: ${msg.type} refused`);
}
uws.close();

// diagnostics only count plans and images
const entry = (await api('GET', '/api/config/config_entries/entry')).body.find((e) => e.domain === 'floorplan_card');
const diag = await api('GET', `/api/diagnostics/config_entry/${entry.entry_id}`);
const d = JSON.stringify(diag.body);
ok(diag.status === 200 && !d.includes('Testhaus') && !d.includes('Wohnen') && !d.includes('base64'), 'diagnostics: no plan names, rooms or pictures');

// delete: subscribers learn it is gone
ok((await ws.call({ type: 'floorplan_card/plans/delete', plan_id: s1.id })).deleted, 'plan deleted');
await until(() => pushed.some((p) => p.deleted));
ok(pushed.at(-1)?.deleted === true, 'subscriber told: deleted');
ok((await ws.call({ type: 'floorplan_card/images/delete', image_id: img.id })).deleted, 'image deleted');
ws.close();
console.log(failures() ? `\n${failures()} FAILED` : '\nall ok');
process.exit(failures() ? 1 : 0);
