// Full screen on the mock harness: the offer after opening puts the card itself into full screen with its overlay
// layer inside; the button to leave appears only after panning / zooming and fades out again. Where the browser
// refuses element full screen, the kiosk mode hides Home Assistant's sidebar and header (a small stand-in of HA's DOM).
//   node tools/build.mjs && sh tools/heavy.sh browser node tools/tests/fullscreen.mjs
import { openMock, demoHome, demoStates, demoEntities } from './mock.mjs';

let fails = 0;
const ok = (c, m, extra) => {
  if (!c) fails++;
  console.log(c ? '• ok:' : '• FAIL:', m, !c && extra !== undefined ? JSON.stringify(extra) : '');
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const cfg = { ...demoHome(), view_mode: '2d' };
const OFFER = 'floorplan-card .fs-offer';
const EXIT = `(() => { const b = window.__fpCard.shadowRoot.querySelector('.fs-btn'); return b ? (b.classList.contains('shown') ? 'shown' : 'hidden') : 'none'; })()`;
// 2D/3D toggle and compass: 'plain' outside full screen, else hidden / shown like the exit button
const CTRL = `(() => { const r = window.__fpCard.shadowRoot; return ['.vm-btn', '.compass'].map((s) => { const b = r.querySelector(s); return !b ? 'none' : !b.classList.contains('fs-reveal') ? 'plain' : b.classList.contains('shown') ? 'shown' : 'hidden'; }).join(','); })()`;

// ---------- real full screen
{
  const m = await openMock({ config: { ...cfg, view_mode: 'auto' }, states: demoStates(), entities: demoEntities, size: '1024x768' });
  const { page } = m;
  ok((await page.evaluate(EXIT)) === 'none', 'kein dauerhafter Vollbild-Knopf');
  ok((await page.evaluate(CTRL)) === 'plain,plain', '2D/3D und Kompass außerhalb des Vollbilds wie immer', await page.evaluate(CTRL));
  ok((await page.textContent(OFFER))?.trim() === 'Vollbild', 'Angebot „Vollbild“ nach dem Öffnen');
  // a layer that exists already (a toast) moves along into the full screen element
  await m.card('(card.ensureLayer().toast("Test"), true)');
  await page.click(OFFER);
  await wait(500);
  const s = await m.card('({ fs: document.fullscreenElement === card, layerInside: !!card.shadowRoot.querySelector("floorplan-card-layer"), inBody: !!document.querySelector("body > floorplan-card-layer"), h: Math.round(card.shadowRoot.querySelector("ha-card").getBoundingClientRect().height), vh: innerHeight })');
  ok(s.fs, 'die Karte selbst ist im Vollbild (nicht die ganze Seite)', s);
  ok(s.layerInside && !s.inBody, 'Overlay-Ebene (Popups, Toasts, Editor) liegt im Vollbild-Element', s);
  ok(Math.abs(s.h - s.vh) <= 2, 'Karte füllt den ganzen Bildschirm', s);
  ok((await page.evaluate(EXIT)) === 'hidden', 'im Vollbild: Knopf zum Verlassen erst unsichtbar');
  ok((await page.evaluate(CTRL)) === 'hidden,hidden', 'im Vollbild: 2D/3D und Kompass erst unsichtbar', await page.evaluate(CTRL));
  await wait(500);
  ok((await m.card('getComputedStyle(card.shadowRoot.querySelector(".compass")).opacity')) === '0' && (await m.card('getComputedStyle(card.shadowRoot.querySelector(".vm-btn")).pointerEvents')) === 'none', 'unsichtbar heißt: durchsichtig und nicht antippbar');
  // a tap is no pan
  await page.mouse.click(300, 400);
  await wait(200);
  ok((await page.evaluate(EXIT)) === 'hidden' && (await page.evaluate(CTRL)) === 'hidden,hidden', 'Tippen zeigt die Knöpfe nicht');
  await page.mouse.move(500, 400);
  await page.mouse.wheel(0, -120);
  await wait(300);
  ok((await page.evaluate(EXIT)) === 'shown' && (await page.evaluate(CTRL)) === 'shown,shown', 'Zoomen (Mausrad) zeigt Verlassen, 2D/3D und Kompass', await page.evaluate(CTRL));
  ok((await page.getAttribute('floorplan-card .fs-btn', 'aria-label')) === 'Vollbild beenden', 'Knopf „Vollbild beenden“');
  await wait(3600);
  ok((await page.evaluate(EXIT)) === 'hidden' && (await page.evaluate(CTRL)) === 'hidden,hidden', 'nach ein paar Sekunden ohne Bewegung blenden sie aus', await page.evaluate(CTRL));
  // holding the compass (performance overlay) keeps working while it is shown, and it stays while held
  await page.mouse.move(500, 400);
  await page.mouse.wheel(0, -120);
  await wait(2000);
  const stats0 = await m.card('card.localStats');
  const c = await m.card('(() => { const r = card.shadowRoot.querySelector(".compass").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()');
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await wait(2600);
  ok((await m.card('card.localStats')) === !stats0, 'Kompass halten schaltet die Leistungsanzeige (sichtbarer Kompass)');
  ok((await page.evaluate(CTRL)).endsWith('shown'), 'gehalten: Kompass bleibt sichtbar, auch nach mehr als 3 s', await page.evaluate(CTRL));
  await page.mouse.up();
  await wait(3800);
  ok((await page.evaluate(CTRL)) === 'hidden,hidden', 'losgelassen: blendet aus', await page.evaluate(CTRL));
  await m.card('(card.toggleLocalStats(), card.statsToggled = false, true)');
  await page.mouse.move(400, 400);
  await page.mouse.down();
  await page.mouse.move(460, 430, { steps: 5 });
  await page.mouse.up();
  await wait(300);
  ok((await page.evaluate(EXIT)) === 'shown' && (await page.evaluate(CTRL)) === 'shown,shown', 'Verschieben/Drehen (Ziehen) zeigt die Knöpfe');
  await page.click('floorplan-card .fs-btn');
  await wait(400);
  const e = await m.card('({ fs: !!document.fullscreenElement, inBody: !!document.querySelector("body > floorplan-card-layer") })');
  ok(!e.fs && e.inBody && (await page.evaluate(EXIT)) === 'none', 'der Knopf beendet das Vollbild, Ebene zurück in body', e);
  ok((await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('fp-fs-')).length)) === 0, 'mit dem Knopf beendet: nicht mehr gemerkt');
  ok((await page.evaluate(CTRL)) === 'plain,plain', 'nach dem Vollbild: 2D/3D und Kompass wieder wie immer', await page.evaluate(CTRL));
  // ended by the browser (Escape / gesture): state follows
  await m.card('(card._fsOffer = true, true)');
  await wait(200);
  await page.click(OFFER);
  await wait(400);
  await page.evaluate(() => document.exitFullscreen());
  await wait(400);
  const b = await m.card('({ inBody: !!document.querySelector("body > floorplan-card-layer") })');
  ok(b.inBody && (await page.evaluate(EXIT)) === 'none', 'vom Browser beendet (Escape/Geste): Knopf und Ebene folgen', b);
  // the software GPU of the headless browser reports driver stalls in 3D: no error of the card
  const errs = m.errors.filter((x) => !/GL Driver Message/.test(x));
  ok(!errs.length, "keine Fehler in der Konsole", errs);
  await m.browser.close();
}

// ---------- kiosk fallback (element full screen refused, e.g. by a kiosk browser's setting)
{
  const m = await openMock({ config: cfg, states: demoStates(), entities: demoEntities, size: '1024x768' });
  const { page } = m;
  await page.evaluate(() => {
    HTMLElement.prototype.requestFullscreen = () => Promise.reject(new Error('refused'));
    // a small stand-in of Home Assistant's frame: home-assistant › home-assistant-main › ha-drawer (sidebar) › hui-root (header, view)
    const shadow = (tag, html) => {
      const el = document.createElement(tag);
      el.attachShadow({ mode: 'open' }).innerHTML = html;
      return el;
    };
    const ha = shadow('home-assistant', '');
    const main = shadow('home-assistant-main', '');
    const drawer = shadow('ha-drawer', '<aside class="mdc-drawer" style="width:256px">menu</aside><div class="mdc-drawer-app-content" style="margin-left:256px"><slot></slot></div>');
    drawer.appendChild(document.createElement('ha-sidebar')).textContent = 'Sidebar';
    const root = shadow('hui-root', '<div class="header" style="height:56px">Header</div><div id="view"></div>');
    drawer.appendChild(root);
    main.shadowRoot.appendChild(drawer);
    ha.shadowRoot.appendChild(main);
    document.body.appendChild(ha);
    root.shadowRoot.querySelector('#view').appendChild(window.__fpCard);
  });
  await wait(600);
  const q = `(() => { const main = document.querySelector('home-assistant').shadowRoot.querySelector('home-assistant-main'); const drawer = main.shadowRoot.querySelector('ha-drawer'); const root = drawer.querySelector('hui-root');
    return { sidebar: getComputedStyle(drawer.querySelector('ha-sidebar')).display, aside: getComputedStyle(drawer.shadowRoot.querySelector('.mdc-drawer')).display, margin: drawer.shadowRoot.querySelector('.mdc-drawer-app-content').style.marginLeft, header: getComputedStyle(root.shadowRoot.querySelector('.header')).display, kiosk: window.__fpCard.hasAttribute('kiosk') }; })()`;
  const before = await page.evaluate(q);
  ok(before.sidebar !== 'none' && before.header !== 'none' && before.margin === '256px', 'vorher: Seitenleiste und Kopfzeile sichtbar', before);
  await page.click(OFFER);
  await wait(300);
  ok((await page.evaluate(() => Object.keys(localStorage).some((k) => k.startsWith('fp-fs-') && localStorage.getItem(k) === '1'))), 'eingeschaltet: auf dem Gerät gemerkt');
  const on = await page.evaluate(q);
  ok(on.sidebar === 'none' && on.aside === 'none' && on.margin === '0px' && on.header === 'none', 'Kiosk: Seitenleiste und Kopfzeile von HA ausgeblendet', on);
  ok(on.kiosk && !(await page.evaluate(() => document.fullscreenElement)) && (await page.evaluate(EXIT)) === 'hidden', 'Kiosk statt Vollbild-API, Knopf zum Verlassen erst unsichtbar', on);
  await page.keyboard.press('Escape');
  await wait(300);
  const off = await page.evaluate(q);
  ok(off.sidebar !== 'none' && off.header !== 'none' && off.margin === '256px' && !off.kiosk, 'Escape: alles wie vorher', off);
  await m.card('(card._fsOffer = true, true)');
  await wait(200);
  await page.click(OFFER);
  await wait(300);
  ok((await page.evaluate(q)).header === 'none', 'wieder Kiosk');
  // the card goes away (navigation): HA's frame comes back
  const gone = await page.evaluate(`(() => { const c = window.__fpCard; const p = c.parentNode; c.remove(); const r = ${q}; p.appendChild(c); return r; })()`);
  ok(gone.sidebar !== 'none' && gone.header !== 'none' && gone.margin === '256px', 'Karte entfernt: Seitenleiste und Kopfzeile zurück', gone);
  // back on the page (reload, restart of HA, the view rebuilt): it comes back by itself
  await wait(700);
  ok((await page.evaluate(q)).header === 'none' && (await page.evaluate(q)).kiosk, 'Karte wieder da: Vollbild kommt von selbst zurück (gemerkt)', await page.evaluate(q));
  ok((await page.evaluate(() => document.querySelector('floorplan-card')?.shadowRoot?.querySelector('.fs-offer') ?? window.__fpCard.shadowRoot.querySelector('.fs-offer'))) === null, 'dabei kein Angebot „Vollbild“');
  // the next tap turns the kiosk mode into real full screen (here the browser's answer is faked)
  await page.evaluate(() => (HTMLElement.prototype.requestFullscreen = () => Promise.resolve()));
  await page.mouse.click(500, 400);
  await wait(300);
  const up = await page.evaluate(q);
  ok(!up.kiosk && up.header !== 'none' && (await m.card('card.fs.mode')) === 'fullscreen', 'erster Tipp danach: echtes Vollbild statt Kiosk', up);
  await page.evaluate(() => (HTMLElement.prototype.requestFullscreen = () => Promise.reject(new Error('refused'))));
  // the browser ends it by itself: stays on (kiosk) – only the button turns it off
  await page.evaluate(() => document.dispatchEvent(new Event('fullscreenchange')));
  await wait(300);
  ok((await page.evaluate(q)).header === 'none' && (await m.card('card.fs.mode')) === 'kiosk', 'vom Browser beendet: bleibt an (als Kiosk)');
  await page.keyboard.press('Escape');
  await wait(300);
  await page.evaluate(`(() => { const c = window.__fpCard; const p = c.parentNode; c.remove(); p.appendChild(c); })()`);
  await wait(700);
  ok((await page.evaluate(q)).header !== 'none' && !(await page.evaluate(q)).kiosk, 'nach dem Beenden (Escape/Knopf) kommt es nicht wieder', await page.evaluate(q));
  ok(!m.errors.length, 'keine Fehler in der Konsole', m.errors);
  await m.browser.close();
}

// ---------- English
{
  const m = await openMock({ config: cfg, states: demoStates(), entities: demoEntities, size: '1024x768', language: 'en' });
  await wait(500); // English comes on demand (not in the start bundle)
  ok((await m.page.textContent(OFFER))?.trim() === 'Full screen', 'englisch: „Full screen“');
  await m.page.click(OFFER);
  await m.page.mouse.move(500, 400);
  await m.page.mouse.wheel(0, -120);
  await wait(300);
  ok((await m.page.getAttribute('floorplan-card .fs-btn', 'aria-label')) === 'Exit full screen', 'englisch: „Exit full screen“');
  await m.browser.close();
}

console.log(fails ? `\n${fails} FAIL` : '\nall ok');
process.exit(fails ? 1 : 0);
