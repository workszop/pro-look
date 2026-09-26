import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url);
const Readability = require('../content/Readability.js');
const { extract, runsText } = require('../content/extract.js');

const FIX = new URL('./fixtures/', import.meta.url);

function load(name, url = `http://localhost/fixtures/${name}`, withReadability = true) {
  const html = readFileSync(new URL(name, FIX), 'utf8');
  const dom = new JSDOM(html, { url });
  const model = extract(dom.window.document, { Readability: withReadability ? Readability : null, DOMParser: dom.window.DOMParser, url });
  return { model, dom };
}

const blocks = (m, type) => m.sections.flatMap((s) => s.blocks).filter((b) => !type || b.type === type);

test('article: uses Readability and keeps structure', () => {
  const { model, dom } = load('article.html');
  assert.equal(model.extractor, 'readability');
  assert.equal(model.title, 'Why Otters Hold Hands While Sleeping');
  assert.equal(model.site, 'localhost');
  const headings = model.sections.map((s) => s.heading);
  assert.ok(headings.includes('The science of rafting'), headings.join('|'));
  assert.ok(headings.includes('Key facts'));
  assert.ok(blocks(model, 'note').length >= 3, 'long paragraphs become notes');
  assert.equal(blocks(model, 'list')[0].items.length, 3);
  const table = blocks(model, 'table')[0];
  assert.deepEqual(table.head, ['Region', 'Estimate', 'Trend']);
  assert.equal(table.rows.length, 3);
  assert.equal(table.caption, 'Population by region');
  assert.equal(blocks(model, 'image').length, 1);
  assert.match(blocks(model, 'image')[0].src, /^http:\/\/localhost\/fixtures\/img\/otter\.svg$/);
  // label split from <strong>
  const author = blocks(model, 'field').find((b) => b.label === 'Author');
  assert.ok(author, 'Author field');
  assert.equal(runsText(author.runs), 'Jane Riverbank');
  // links stay clickable and absolute
  const linked = blocks(model).flatMap((b) => b.runs || []).filter((r) => r.href);
  assert.ok(linked.some((r) => r.href === 'http://localhost/fixtures/page2.html'));
  // nav collected for the More menu
  assert.ok(model.nav.some((n) => n.t === 'Animals'));
  // the live document is untouched
  assert.ok(dom.window.document.querySelector('header nav'));
});

test('article: text coverage invariant (≥ 90% of Readability text)', () => {
  const { model } = load('article.html');
  assert.ok(model.sourceChars > 0);
  const ratio = model.modelChars / model.sourceChars;
  assert.ok(ratio >= 0.9, `coverage ${ratio.toFixed(2)}`);
});

test('listing: outer layout table is walked, inner story table becomes a data grid', () => {
  const { model } = load('listing.html');
  assert.equal(model.extractor, 'fallback');
  const cellRuns = blocks(model, 'table').flatMap((t) => t.rows.flat());
  const allRuns = blocks(model).flatMap((b) => b.runs || []).concat(cellRuns.flat());
  const text = allRuns.map((r) => r.t).join(' ');
  assert.match(text, /Rust 2\.0 released/);
  assert.match(text, /412 points by alice/);
  assert.equal(blocks(model, 'table').length, 1, 'only the inner data table is a grid');
  assert.ok(allRuns.some((r) => r.href === 'https://example.com/a'));
});

test('gallery: images kept, tracking pixels dropped', () => {
  const { model } = load('gallery.html');
  const imgs = blocks(model, 'image');
  assert.equal(imgs.length, 3);
  assert.deepEqual(imgs.map((i) => i.alt), ['Beach sunset', 'Mountain lake', 'City at night']);
});

test('empty: no sections, no crash', () => {
  const { model } = load('empty.html');
  assert.equal(model.extractor, 'fallback');
  assert.equal(model.sections.length, 0);
  assert.equal(model.title, 'Loading');
});

test('app: fallback skips nav chrome and hidden nodes', () => {
  const { model } = load('app.html');
  assert.equal(model.extractor, 'fallback');
  const text = blocks(model).map((b) => runsText(b.runs || [])).join(' | ');
  assert.match(text, /first marathon/);
  assert.doesNotMatch(text, /hidden draft/);
  assert.doesNotMatch(text, /Explore/);
  assert.ok(model.nav.some((n) => n.t === 'Messages'));
  assert.equal(model.title, 'Feed');
});

test('home: index page becomes list items with summary, image, time and group', () => {
  const { model } = load('home.html');
  assert.equal(model.kind, 'index');
  assert.equal(model.items.length, 10, model.items.map((i) => i.title).join(' | '));
  const first = model.items[0];
  assert.equal(first.title, 'Why otters hold hands while sleeping in the kelp');
  assert.equal(first.href, 'http://localhost/fixtures/article.html');
  assert.match(first.summary, /rafting behaviour/);
  assert.match(first.image, /otter\.svg$/);
  assert.equal(first.time, '1 hours ago');
  assert.equal(first.group, 'World');
  assert.equal(model.items[5].group, 'Technology');
  assert.ok(!model.items.some((i) => /Terms of use/.test(i.title)), 'footer links excluded');
  assert.equal(model.meta.siteName, 'Daily Planet');
});

test('article: kind, metadata and tag link-list moved to related', () => {
  const { model } = load('article.html');
  assert.equal(model.kind, 'article');
  assert.match(model.meta.byline, /Jane Riverbank/);
  assert.equal(model.meta.siteName, 'Nature Weekly');
  assert.equal(model.meta.published, '2026-09-20T08:30:00.000Z');
});

test('walker: short bare-link lists leave the reading flow for Related Links', () => {
  const { model } = load('article.html', undefined, false);
  assert.equal(model.extractor, 'fallback');
  const inFlow = blocks(model, 'list').flatMap((b) => b.items.map(runsText));
  assert.ok(!inFlow.includes('Oceans'), 'tag list not in reading flow');
  assert.deepEqual(model.related.map((r) => r.t), ['Otters', 'Oceans', 'Wildlife']);
  assert.equal(blocks(model, 'list')[0].items.length, 3, 'real content list (Key facts) kept');
});

test('site root with a few headlines is an index', () => {
  const { model } = load('listing.html', 'http://localhost/');
  assert.equal(model.kind, 'index');
  assert.equal(model.items.length, 3);
  assert.match(model.items[0].summary, /412 points by alice/, 'table-layout byline row used as summary');
});

test('mega-menus and account links (multi-link items) leave the reading flow', () => {
  const { model } = load('megamenu.html', 'http://localhost/tech/2026/rogue-ai-agents-attack', false);
  const flow = blocks(model).map((b) => (b.items || [b.runs || []]).map(runsText).join(' ')).join(' | ');
  assert.doesNotMatch(flow, /Sign Up|See all tech|Movies/);
  assert.match(flow, /Six hours of exposure/, 'content list with a link stays');
  const rel = model.related.map((r) => r.t);
  for (const t of ['Login', 'Sign Up', 'Amazon', 'See all science', 'Movies']) assert.ok(rel.includes(t), t);
});

test('tidy: drops duplicated dek, byline line, bare date and one-word chrome', () => {
  const { model } = load('megamenu.html', 'http://localhost/tech/2026/rogue-ai-agents-attack', false);
  const texts = blocks(model).filter((b) => b.runs).map((b) => runsText(b.runs));
  assert.equal(texts.filter((t) => t.startsWith('Mistakes at a startup')).length, 1, 'dek kept once');
  assert.ok(!texts.includes('Comments'));
  assert.ok(!texts.some((t) => /^Skip to/i.test(t)), 'combined skip links dropped');
  assert.ok(!texts.some((t) => /^by Robert Hart$/i.test(t)));
  assert.ok(!texts.some((t) => /^Sep 25, 2026/.test(t)));
  assert.ok(texts.includes('Founded in 1999') && texts.includes('Chapter 2026'), 'year-bearing sentences are not dates');
  assert.equal(model.meta.byline, 'Robert Hart');
});

// X-like fixtures build their DOM from script after load, like the real SPA
async function loadLive(name) {
  const file = new URL(name, FIX);
  const dom = new JSDOM(readFileSync(file, 'utf8'), { url: file.href, runScripts: 'dangerously', resources: 'usable' });
  await new Promise((r) => setTimeout(r, 700));
  const model = extract(dom.window.document, { Readability, DOMParser: dom.window.DOMParser, url: file.href });
  dom.window.close();
  return model;
}

test('x feed: posts become feed items with author, text, links, media, quote, context, stats', async () => {
  const model = await loadLive('xfeed.html');
  assert.equal(model.kind, 'feed');
  assert.equal(model.items.length, 10);
  const [p0, p1, p2, p3] = model.items;
  assert.equal(p0.author, 'Dana Lee');
  assert.equal(p0.handle, '@dana_l');
  assert.match(p0.href, /fixtures\/xstatus\.html$/);
  assert.match(runsText(p0.runs), /^Post number 0: shipping/);
  assert.ok(p0.runs.some((r) => r.href === 'https://example.com/p0' && r.t === 'caching'), 'inline link kept');
  assert.equal(p0.time, '1h');
  assert.match(p0.stats, /0 replies/);
  assert.equal(p0.image, '', 'avatar is not a post image');
  assert.match(p1.image, /otter\.svg$/, 'tweetPhoto image');
  assert.equal(p2.quote.author, 'Quoted Person');
  assert.match(runsText(p2.quote.runs), /original quoted post/);
  assert.doesNotMatch(runsText(p2.runs), /original quoted post/, 'quote not merged into main text');
  assert.equal(p3.context, 'Some Friend reposted');
  assert.ok(!model.items.some((i) => /Otters|trending/i.test(runsText(i.runs))), 'sidebar trends excluded');
  assert.ok(model.nav.some((n) => n.t === 'Explore'));
  assert.equal(model.title, 'Home', '"Home / X" splits on the slash');
});

test('x status page: focal post is marked and titles the record, replies follow', async () => {
  const model = await loadLive('xstatus.html');
  assert.equal(model.kind, 'feed');
  assert.equal(model.items.length, 4);
  assert.ok(model.items[0].focal);
  assert.ok(model.items.slice(1).every((i) => !i.focal));
  assert.match(model.title, /^Post number 0: shipping a small feature today\./);
  assert.match(runsText(model.items[0].runs), /Second paragraph/);
  assert.match(model.items[0].runs.map((r) => r.t).join(''), /today\.\n\nSecond paragraph/, 'post line breaks kept');
});

test('news cards with <article> and headline links stay in index mode', () => {
  const { model } = load('home.html');
  assert.equal(model.kind, 'index');
});

test('guardian-style cards: overlay aria-label links, kicker labels, pictures outside the link', () => {
  const { model } = load('guardian-home.html', 'https://www.example-news.test/international');
  assert.equal(model.kind, 'index');
  const byTitle = Object.fromEntries(model.items.map((i) => [i.title, i]));
  const flood = byTitle['Floods force thousands from homes along the river delta'];
  assert.ok(flood, 'overlay-link card found: ' + model.items.map((i) => i.title).join(' | '));
  assert.equal(flood.kicker, 'Floods');
  assert.match(flood.image, /otter\.svg$/, 'picture next to the overlay link');
  assert.equal(flood.group, 'News');
  const sub = byTitle['Maps show how far the flood water has spread'];
  assert.ok(sub, 'sublink title without its kicker glued on');
  assert.equal(sub.kicker, 'Explainer');
  assert.ok(!model.items.some((i) => /^FloodsFloods|^ExplainerMaps/.test(i.title)));
  assert.equal(byTitle['City verdict: what happens next for the club'].group, 'Sport');
  assert.ok(!model.items.some((i) => /Terms and conditions/.test(i.title)));
});
