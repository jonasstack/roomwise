// Screenshots of doors/windows on the current plan: 3D, 2D, 2D zoomed. Nothing is saved or switched.
import { openHA } from '../pw.mjs';
const out = process.argv[2] ?? '/tmp';
const scheme = process.argv[3] ?? 'light';
const { browser, page, errors } = await openHA({ size: '1280x800', scheme, kiosk: true, block: ['light', 'climate', 'vacuum', 'cover', 'todo', 'media_player', 'fan', 'switch'] });
await page.waitForTimeout(1200);
await page.screenshot({ path: `${out}/op-3d-${scheme}.png` });
await page.locator('floorplan-card .chrome .icon-btn[aria-label="2D"]').click();
await page.waitForTimeout(900);
await page.screenshot({ path: `${out}/op-2d-${scheme}.png` });
// zoom on the middle (doors cluster)
const box = await page.locator('floorplan-card fp-plan').boundingBox();
await page.mouse.move(box.x + box.width * 0.62, box.y + box.height * 0.5);
await page.mouse.wheel(0, -380);
await page.waitForTimeout(600);
await page.screenshot({ path: `${out}/op-2d-zoom-${scheme}.png` });
console.log(errors.length ? errors.join('\n') : 'console: keine Fehler/Warnungen');
await browser.close();
