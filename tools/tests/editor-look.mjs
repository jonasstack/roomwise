// Opens the editor and screenshots its main states. Does not save.
import { openHA, center, tapAt } from '../pw.mjs';
const out = process.argv[2] ?? '/tmp';
const scheme = process.argv[3] ?? 'light';
const size = process.argv[4] ?? '1280x800';
const { browser, page, errors } = await openHA({ scheme, size, block: ['light', 'climate', 'vacuum', 'cover', 'todo', 'media_player', 'fan', 'switch'] });
const shot = (n) => page.screenshot({ path: `${out}/ed-${n}-${scheme}-${size}.png` });
await page.locator('floorplan-card .chrome.top .icon-btn[aria-label="Grundriss bearbeiten"]').click();
await page.waitForTimeout(700);
await shot('open');
// select living room by tapping its label area
const label = await center(page, 'floorplan-card-editor-ui fp-plan .label >> nth=0');
await tapAt(page, label.x + 60, label.y + 60);
await page.waitForTimeout(500);
await shot('room');
await page.locator('floorplan-card-editor-ui .tool[data-panel="furniture"]').click();
await page.waitForTimeout(500);
await shot('furniture');
// "Other" at the top of the library: any entity as a device marker (formerly the devices panel)
await page.locator('floorplan-card-editor-ui .furn-other').first().click();
await page.waitForTimeout(500);
await shot('devices');
await page.locator('floorplan-card-editor-ui .tool[data-panel="settings"]').click();
await page.waitForTimeout(500);
await shot('settings');
await page.locator('floorplan-card-editor-ui .tool[data-tool="draw"]').click();
await page.waitForTimeout(300);
await shot('draw');
console.log(errors.length ? errors.join('\n') : 'console: keine Fehler/Warnungen');
await browser.close();
