// Screenshots in tablet resolutions (landscape + portrait), light + dark: overview, a popup, the editor.
import { openHA, tapAt, piecePoint } from '../pw.mjs';
const out = process.argv[2] ?? '/tmp';
const sizes = (process.argv[3] ?? '1280x800,1920x1200,800x1280,1200x1920').split(',');
const schemes = (process.argv[4] ?? 'light,dark').split(',');
const BLOCK = ['light', 'climate', 'vacuum', 'cover', 'todo', 'media_player', 'fan', 'switch', 'homeassistant'];
for (const size of sizes)
  for (const scheme of schemes) {
    const { browser, page, errors } = await openHA({ size, scheme, block: BLOCK, kiosk: true });
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${out}/res-${size}-${scheme}-overview.png` });
    const pt = await piecePoint(page, 'light.');
    if (pt) await tapAt(page, pt[0], pt[1], 700);
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${out}/res-${size}-${scheme}-popup.png` });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    await page.locator('floorplan-card .chrome.top .icon-btn[aria-label="Grundriss bearbeiten"]').click();
    await page.waitForTimeout(800);
    const label = await page.locator('floorplan-card-editor-ui fp-plan path.room').first().boundingBox();
    await page.mouse.click(label.x + label.width * 0.3, label.y + label.height * 0.6);
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${out}/res-${size}-${scheme}-editor.png` });
    console.log(size, scheme, errors.length ? errors.join(' | ') : 'console ok');
    await browser.close();
  }
