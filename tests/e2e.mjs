// Pro Look – end-to-end probe: real Chromium (Chrome for Testing) with the unpacked extension.
// Reads the data-pl-* DOM contract on #pro-look-root instead of scraping pixels.
// Usage: node tests/e2e.mjs   (env: PW_MODULE, CHROME_BIN, SHOTS_DIR, HEADED=1)
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── Constants ───
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PW_MODULE = process.env.PW_MODULE || join(homedir(), '.hermes/hermes-agent/node_modules/playwright/index.mjs');
// Branded Chrome ≥137 ignores --load-extension; Chrome for Testing does not.
const CHROME_BIN = process.env.CHROME_BIN || join(homedir(), '.cache/ms-playwright/chromium-1234/chrome-linux64/chrome');
const SHOTS_DIR = process.env.SHOTS_DIR || join(ROOT, 'shots');
const STEP_MS = 10000;
const FAKE_TITLE = 'Opportunity | Workspace';

const { chromium } = await import(PW_MODULE);

// ─── Helpers ───
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  – ' + detail : ''}`);
}

function withTimeout(p, ms, label) {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`timeout: ${label}`)), ms); })]).finally(() => clearTimeout(t));
}

function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
    s.on('error', rej);
  });
}

async function waitHttp(url) {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(url)).ok) return; } catch (e) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('http server did not start');
}

const contract = (page) => page.evaluate(() => {
  const h = document.getElementById('pro-look-root');
  if (!h) return null;
  return Object.fromEntries([...h.attributes].filter((a) => a.name.startsWith('data-pl-')).map((a) => [a.name.slice(8), a.value]));
});

const waitOn = (page) => page.waitForFunction(() => document.getElementById('pro-look-root')?.getAttribute('data-pl-state') === 'on', null, { timeout: STEP_MS });
const waitOff = (page) => page.waitForFunction(() => !document.getElementById('pro-look-root'), null, { timeout: STEP_MS });

// ─── Run ───
const port = await freePort();
const base = `http://127.0.0.1:${port}/fixtures/`;
const server = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'], { cwd: join(ROOT, 'tests'), stdio: 'ignore' });
const profile = mkdtempSync(join(tmpdir(), 'pro-look-e2e-'));
mkdirSync(SHOTS_DIR, { recursive: true });
let context;

try {
  await waitHttp(base + 'article.html');
  context = await withTimeout(chromium.launchPersistentContext(profile, {
    executablePath: CHROME_BIN,
    headless: !process.env.HEADED,
    viewport: { width: 1440, height: 900 },
    args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`, '--no-first-run', '--no-default-browser-check'],
  }), 30000, 'launch');

  let [sw] = context.serviceWorkers();
  if (!sw) sw = await withTimeout(context.waitForEvent('serviceworker'), STEP_MS, 'service worker');
  check('extension service worker running', !!sw);

  const page = context.pages()[0] || await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const toggle = () => withTimeout(sw.evaluate(async () => {
    const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return globalThis.toggleTab(t);
  }), STEP_MS, 'toggle');

  // 1. Article: toggle on, contract + invariants
  await page.goto(base + 'article.html');
  const origTitle = await page.title();
  check('page loads undisguised by default', (await contract(page)) === null);
  await toggle();
  await waitOn(page);
  let c = await contract(page);
  check('article: contract published', c && c.state === 'on' && c.version === '0.1.0', JSON.stringify(c));
  check('article: readability extractor', c.extractor === 'readability');
  check('article: ≥3 sections', Number(c.sections) >= 3, c.sections);
  check('article: coverage ≥ 0.90', Number(c.coverage) >= 0.9, c.coverage);
  check('article: 1 image thumbnail', c.images === '1');
  check('tab title disguised', (await page.title()) === FAKE_TITLE);
  check('favicon swapped', await page.evaluate(() => !!document.querySelector('link[data-pro-look][rel=icon]') && !document.querySelector('link[rel=icon]:not([data-pro-look])')));
  const thumbs = await page.evaluate(() => {
    const host = document.getElementById('pro-look-root');
    const max = parseFloat(getComputedStyle(host).getPropertyValue('--pl-thumb'));
    return [...host.shadowRoot.querySelectorAll('img')].filter((i) => i.offsetParent).map((i) => {
      const r = i.getBoundingClientRect(); return r.width <= max + 0.5 && r.height <= max + 0.5;
    });
  });
  check('invariant: every visible image ≤ --pl-thumb', thumbs.length > 0 && thumbs.every(Boolean), JSON.stringify(thumbs));
  await page.screenshot({ animations: 'disabled', path: join(SHOTS_DIR, 'article.png') });

  await page.evaluate(() => { const m = document.getElementById('pro-look-root').shadowRoot.querySelector('.main'); m.scrollTop = m.scrollHeight; });
  await page.waitForFunction(() => document.getElementById('pro-look-root').getAttribute('data-pl-progress') === '100', null, { timeout: STEP_MS }).catch(() => {});
  const stage = await page.evaluate(() => document.getElementById('pro-look-root').shadowRoot.querySelector('.path li[data-state=current]')?.textContent);
  check('stage path tracks reading progress', stage === 'Close', stage);
  await page.evaluate(() => { document.getElementById('pro-look-root').shadowRoot.querySelector('.main').scrollTop = 0; });

  // 2. Search filter via keyboard
  await page.keyboard.press('/');
  await page.keyboard.type('Alaska');
  await page.waitForFunction(() => document.getElementById('pro-look-root').getAttribute('data-pl-matches') !== '', null, { timeout: STEP_MS });
  c = await contract(page);
  check('search "/" filters to matches', c.matches === '1', c.matches);
  await page.keyboard.press('Escape');
  check('Esc clears search', (await contract(page)).matches === '');

  // 3. Navigation keeps the disguise
  await page.locator('#pro-look-root a', { hasText: 'follow-up story' }).click();
  await page.waitForURL(/page2\.html$/, { timeout: STEP_MS });
  await waitOn(page);
  c = await contract(page);
  check('disguise survives link navigation', c.state === 'on' && (await page.title()) === FAKE_TITLE);

  // 4. Toggle off restores the page
  await toggle();
  await waitOff(page);
  check('toggle off removes overlay', (await contract(page)) === null);
  check('title restored', (await page.title()) === 'Otters and Tools | Nature Weekly', await page.title());
  check('scroll lock + visibility restored', await page.evaluate(() => !document.documentElement.style.overflow && !document.documentElement.style.visibility));

  // 5. Remaining fixtures
  for (const name of ['listing', 'gallery', 'empty']) {
    await page.goto(base + name + '.html');
    await toggle();
    await waitOn(page);
    c = await contract(page);
    check(`${name}: mounts`, c.state === 'on', JSON.stringify(c));
    if (name === 'gallery') check('gallery: 3 thumbnails, pixel dropped', c.images === '3', c.images);
    if (name === 'empty') check('empty: 0 sections, empty state shown', c.sections === '0');
    await page.screenshot({ animations: 'disabled', path: join(SHOTS_DIR, name + '.png') });
    await toggle();
    await waitOff(page);
  }

  // 5b. Page CSS must not leak into (or hide) the overlay
  await page.goto(base + 'hostile.html');
  await toggle();
  await waitOn(page);
  const leak = await page.evaluate(() => {
    const host = document.getElementById('pro-look-root');
    const cs = getComputedStyle(host);
    const tk = getComputedStyle(host.shadowRoot.querySelector('.tk-t'));
    return { display: cs.display, position: cs.position, opacity: cs.opacity, font: tk.fontFamily, size: tk.fontSize, ls: tk.letterSpacing };
  });
  check('hostile CSS: overlay stays visible and fixed', leak.display === 'block' && leak.position === 'fixed' && leak.opacity === '1', JSON.stringify(leak));
  check('hostile CSS: overlay typography from tokens', leak.font.includes('Segoe UI') && leak.size !== '30px' && leak.ls !== '4px', JSON.stringify(leak));
  await page.screenshot({ animations: 'disabled', path: join(SHOTS_DIR, 'hostile.png') });
  await toggle();
  await waitOff(page);

  // 6. SPA late content is picked up by the re-extract observer
  await page.goto(base + 'app.html');
  await toggle();
  await waitOn(page);
  const late = await page.waitForFunction(() => document.getElementById('pro-look-root').shadowRoot.textContent.includes('Late loaded post'), null, { timeout: 12000 }).then(() => true, () => false);
  check('SPA: late content re-extracted', late);
  const spaName = await page.evaluate(() => document.getElementById('pro-look-root').shadowRoot.querySelector('.rec-name').textContent);
  check('re-extract keeps the real page title, not the fake one', spaName === 'Feed', spaName);
  await page.screenshot({ animations: 'disabled', path: join(SHOTS_DIR, 'app.png') });
  await toggle();
  await waitOff(page);

  // 7. Always-on site list auto-disguises on load
  await sw.evaluate(() => chrome.storage.sync.set({ alwaysOn: ['127.0.0.1'] }));
  const p2 = await context.newPage();
  await p2.goto(base + 'page2.html');
  const auto = await waitOn(p2).then(() => true, () => false);
  check('always-on host opens disguised', auto);
  await sw.evaluate(() => chrome.storage.sync.set({ alwaysOn: [] }));
  await p2.close();

  // 7b. Index page → list view → keyboard to an article → timeline → back to list
  await page.goto(base + 'home.html');
  await toggle();
  await waitOn(page);
  c = await contract(page);
  check('home: index kind, list view with 10 items', c.kind === 'index' && c.items === '10', JSON.stringify(c));
  check('home: tab title is list view', (await page.title()) === 'Opportunities | Workspace');
  await page.screenshot({ animations: 'disabled', path: join(SHOTS_DIR, 'home.png') });
  await page.keyboard.press('j');
  const focused = await page.evaluate(() => document.getElementById('pro-look-root').shadowRoot.activeElement?.textContent);
  check('j focuses the first list row', focused === 'Why otters hold hands while sleeping in the kelp', focused);
  await page.keyboard.press('Enter');
  await page.waitForURL(/article\.html$/, { timeout: STEP_MS });
  await waitOn(page);
  c = await contract(page);
  check('article opened from list is a timeline record', c.kind === 'article' && Number(c.entries) >= 5, JSON.stringify(c));
  const tl = await page.evaluate(() => {
    const r = document.getElementById('pro-look-root').shadowRoot;
    const hl = Object.fromEntries([...r.querySelectorAll('.highlights > div')].map((d) => [d.firstChild.textContent, d.lastChild.textContent]));
    const bodies = [...r.querySelectorAll('.tl-b')].map((b) => b.textContent);
    return { hl, first: bodies[0], order: bodies.findIndex((t) => t.startsWith('Rafts can contain')) < bodies.findIndex((t) => t.startsWith('Otters also wrap')) };
  });
  check('record header shows real byline + site', tl.hl['Primary Contact'] === 'Jane Riverbank' && tl.hl['Account Name'] === 'Nature Weekly', JSON.stringify(tl.hl));
  check('timeline keeps reading order', tl.order && /^Sea otters are among/.test(tl.first), tl.first);
  await page.screenshot({ animations: 'disabled', path: join(SHOTS_DIR, 'article-timeline.png') });
  await page.goBack();
  await waitOn(page);
  check('back returns to the disguised list view', (await contract(page)).kind === 'index');
  await toggle();
  await waitOff(page);

  // 7c. Ctrl+Shift+X works from the page even when Chrome has not bound the command
  await page.goto(base + 'page2.html');
  await page.keyboard.press('Control+Shift+X');
  const hkOn = await waitOn(page).then(() => true, () => false);
  check('Ctrl+Shift+X toggles on (in-page fallback)', hkOn);
  await page.keyboard.press('Control+Shift+X');
  const hkOff = await waitOff(page).then(() => true, () => false);
  check('Ctrl+Shift+X toggles off', hkOff);

  // 7d. X-like virtualized feed: posts accumulate past the 10-post DOM window; a post opens as a case
  await page.goto(base + 'xfeed.html');
  await toggle();
  await waitOn(page);
  const items = () => page.evaluate(() => Number(document.getElementById('pro-look-root').getAttribute('data-pl-items')));
  await page.waitForFunction(() => document.getElementById('pro-look-root').getAttribute('data-pl-items') === '10', null, { timeout: STEP_MS }).catch(() => {});
  c = await contract(page);
  check('x feed: late SPA posts render as a case list', c.kind === 'feed' && c.items === '10', JSON.stringify(c));
  check('x feed: tab title is Cases', (await page.title()) === 'Cases | Workspace');
  const listName = await page.evaluate(() => document.getElementById('pro-look-root').shadowRoot.querySelector('.rec-name').textContent);
  check('x feed: list named after the real page title', listName === 'Home ▾', listName);
  for (let i = 0; i < 8 && (await items()) < 25; i++) {
    await page.evaluate(() => { const m = document.getElementById('pro-look-root').shadowRoot.querySelector('.main'); m.scrollTop = m.scrollHeight; m.dispatchEvent(new Event('scroll')); });
    await page.waitForTimeout(1200);
  }
  const acc = await page.evaluate(() => ({
    rows: document.getElementById('pro-look-root').shadowRoot.querySelectorAll('.lv-t tbody tr').length,
    domPosts: document.querySelectorAll('article').length,
    firstStillListed: document.getElementById('pro-look-root').shadowRoot.querySelector('.lv-t tbody tr .post-b').textContent.startsWith('Post number 0'),
    firstInDom: !!document.querySelector('article a[href="xstatus.html"]'),
  }));
  check('x feed: load-more accumulates beyond the DOM window', acc.rows >= 25 && acc.domPosts === 10 && acc.firstStillListed && !acc.firstInDom, JSON.stringify(acc));
  await page.evaluate(() => { document.getElementById('pro-look-root').shadowRoot.querySelector('.main').scrollTop = 0; });
  await page.screenshot({ animations: 'disabled', path: join(SHOTS_DIR, 'xfeed.png') });
  await page.locator('#pro-look-root a.lv-link', { hasText: 'Dana Lee' }).first().click();
  await page.waitForURL(/xstatus\.html$/, { timeout: STEP_MS });
  await waitOn(page);
  await page.waitForFunction(() => document.getElementById('pro-look-root').getAttribute('data-pl-comments') === '3', null, { timeout: STEP_MS }).catch(() => {});
  c = await contract(page);
  const rec = await page.evaluate(() => {
    const r = document.getElementById('pro-look-root').shadowRoot;
    return { name: r.querySelector('.rec-name')?.textContent, desc: r.querySelector('.field.wide .f-v')?.textContent, first: r.querySelector('.tl-e .tl-m')?.textContent };
  });
  check('x status: focal post is a Case with 3 comments', c.kind === 'feed' && c.comments === '3' && (await page.title()) === 'Case | Workspace', JSON.stringify(c));
  check('x status: description has the full post, comments show real authors', /Second paragraph/.test(rec.desc) && /Comment · \S+/.test(rec.first) && /^Post number 0/.test(rec.name), JSON.stringify(rec));
  await page.screenshot({ animations: 'disabled', path: join(SHOTS_DIR, 'xstatus.png') });
  await toggle();
  await waitOff(page);

  // 8. Mobile width: single column
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto(base + 'article.html');
  await toggle();
  await waitOn(page);
  const cols = await page.evaluate(() => getComputedStyle(document.getElementById('pro-look-root').shadowRoot.querySelector('.body')).gridTemplateColumns.split(' ').length);
  check('≤768px: single-column layout', cols === 1, String(cols));
  const hscroll = await page.evaluate(() => { const b = document.getElementById('pro-look-root').shadowRoot.querySelector('.body'); return b.scrollWidth > b.clientWidth + 1; });
  check('≤768px: no horizontal page scroll', !hscroll);
  const stacked = await page.evaluate(() => {
    const r = document.getElementById('pro-look-root').shadowRoot;
    return r.querySelector('.main').lastElementChild.getBoundingClientRect().bottom <= r.querySelector('.rail').getBoundingClientRect().top + 1;
  });
  check('≤768px: record and rail stack without overlap', stacked);
  await page.screenshot({ animations: 'disabled', path: join(SHOTS_DIR, 'article-mobile.png') });

  check('no page errors', errors.length === 0, errors.join(' | '));
  check('original title was captured', origTitle === 'Why Otters Hold Hands While Sleeping | Nature Weekly');
} catch (e) {
  check('run completed', false, e.message);
} finally {
  if (context) await context.close().catch(() => {});
  server.kill();
  rmSync(profile, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed. Screenshots: ${SHOTS_DIR}`);
process.exit(failed ? 1 : 0);
