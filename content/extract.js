// Pro Look – page → Model extractor. Pure: reads a Document, never mutates it.
// Loaded as a classic content script (exposes ProLookExtract) and via require() in tests.
(function (root) {
  'use strict';

  // ─── Constants ───
  const MIN_ARTICLE_CHARS = 300;
  const FIELD_MAX_CHARS = 140;
  const LABEL_MAX_CHARS = 32;
  const MAX_BLOCKS = 1500;
  const MIN_IMG_PX = 24;
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'CANVAS', 'IFRAME',
    'OBJECT', 'EMBED', 'VIDEO', 'AUDIO', 'FORM', 'INPUT', 'SELECT', 'TEXTAREA', 'BUTTON', 'DIALOG', 'HEAD', 'LINK', 'META']);
  const CHROME_TAGS = new Set(['NAV', 'HEADER', 'FOOTER', 'ASIDE']);
  const INLINE_TAGS = new Set(['A', 'ABBR', 'B', 'BDI', 'BDO', 'BR', 'CITE', 'CODE', 'DATA', 'DFN', 'EM', 'FONT', 'I',
    'KBD', 'MARK', 'Q', 'S', 'SAMP', 'SMALL', 'SPAN', 'STRONG', 'SUB', 'SUP', 'TIME', 'U', 'VAR', 'WBR', 'DEL', 'INS', 'LABEL']);
  const HEADING_RE = /^H[1-6]$/;
  const HEADLINE_MIN_CHARS = 20;
  const INDEX_MIN_HEADLINES = 8;
  const MAX_ITEMS = 300;
  const LINKLIST_MAX_CHARS = 40;
  const LINK_TEXT_RATIO = 0.9;
  const DATE_LINE_MAX = 40;
  const DATE_SHAPE_RE = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b|\b\d{1,2}\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)|\d{4}-\d{2}-\d{2}|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/i;
  const ONE_WORD_MAX = 15;
  const SLUG_RE = /[a-z0-9]+-[a-z0-9]+-[a-z0-9]+|\d{6,}|^(?=.*\d)[a-z0-9]{10,}$/i;
  const ARTICLE_LD_RE = /"@type"\s*:\s*\[?\s*"(NewsArticle|Article|BlogPosting|ReportageNewsArticle|TechArticle|ScholarlyArticle|AnalysisNewsArticle|OpinionNewsArticle)"/;
  const INDEX_LD_RE = /"@type"\s*:\s*\[?\s*"(CollectionPage|ItemList)"/;
  const SUMMARY_SEL = 'p, [class*="summary" i], [class*="description" i], [class*="excerpt" i], [class*="dek" i], [class*="standfirst" i], [class*="teaser" i]';
  const SKIP_LINK_RE = /^skip to\b/i;
  const KICKER_MAX_CHARS = 30;
  // Social feeds (X, Bluesky, Mastodon, Threads...): posts are articles whose permalink wraps a <time>
  const POST_SEL = 'article, [role="article"]';
  const PERMALINK_HINT_RE = /\/(status|statuses|post|posts|notes)\/[\w-]+/i;
  const AVATAR_RE = /profile_images|avatar|emoji/i;
  const FEED_MIN_POSTS = 3;
  const CARD_HEADLINE_CHARS = 40;
  const TITLE_SPLIT_RE = /\s+[|·•–\-:/]\s+/;

  // ─── Helpers ───
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();

  function absUrl(href, base) {
    if (!href) return '';
    try { return new URL(href, base).href; } catch (e) { return ''; }
  }

  function isHidden(el) {
    if (el.hidden || el.getAttribute('aria-hidden') === 'true') return true;
    const st = el.getAttribute('style') || '';
    if (/display\s*:\s*none|visibility\s*:\s*hidden/i.test(st)) return true;
    const view = el.ownerDocument.defaultView;
    // Live pages: trust layout. Inert (DOMParser) docs have no layout, so skip the check there.
    if (view && el.isConnected && typeof view.getComputedStyle === 'function' && el.ownerDocument.documentElement.clientHeight > 0) {
      const cs = view.getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return true;
    }
    return false;
  }

  // Inline runs keep links clickable: [{t:'text'}, {t:'label', href:'…'}]
  function runsOf(el, base, keepBreaks) {
    const runs = [];
    const push = (t, href) => {
      if (!t) return;
      const last = runs[runs.length - 1];
      if (last && !last.href && !href) last.t += t;
      else runs.push(href ? { t, href } : { t });
    };
    (function walk(node, href) {
      for (const n of node.childNodes) {
        if (n.nodeType === 3) push(keepBreaks ? n.nodeValue.replace(/[^\S\n]+/g, ' ') : n.nodeValue.replace(/\s+/g, ' '), href);
        else if (n.nodeType === 1) {
          if (SKIP_TAGS.has(n.tagName) || n.tagName === 'IMG') continue;
          if (n.tagName === 'BR') { push(keepBreaks ? '\n' : ' ', href); continue; }
          const h = n.tagName === 'A' ? absUrl(n.getAttribute('href'), base) : href;
          walk(n, h || href);
        }
      }
    })(el, '');
    // trim edges and drop empties
    if (runs.length) { runs[0].t = runs[0].t.replace(/^\s+/, ''); runs[runs.length - 1].t = runs[runs.length - 1].t.replace(/\s+$/, ''); }
    if (keepBreaks) runs.forEach((r) => { r.t = r.t.replace(/\n{3,}/g, '\n\n'); });
    return runs.filter((r) => r.t.trim() || r.t === ' ');
  }

  const runsText = (runs) => norm(runs.map((r) => r.t).join(''));

  // "Price: $10" or "<strong>Price</strong> $10" → label + value
  function splitLabel(el, runs, base) {
    const first = el.firstElementChild;
    const text = runsText(runs);
    if (first && /^(STRONG|B|DT|TH)$/.test(first.tagName) && el.firstChild === first) {
      const label = norm(first.textContent).replace(/:$/, '');
      if (label && label.length <= LABEL_MAX_CHARS && text.length > label.length + 1) {
        const clone = el.cloneNode(true);
        clone.removeChild(clone.firstElementChild);
        const rest = runsOf(clone, base);
        if (runsText(rest)) return { label, runs: rest.map((r, i) => (i === 0 ? { ...r, t: r.t.replace(/^\s*:\s*/, '') } : r)) };
      }
    }
    const m = /^([^:.!?]{2,32}):\s+\S/.exec(text);
    if (m && runs.length === 1 && !runs[0].href) {
      return { label: norm(m[1]), runs: [{ t: text.slice(m[0].length - 1) }] };
    }
    return { label: '', runs };
  }

  // jsdom / DOMParser documents have no layout; live pages do
  const hasLayout = (doc) => doc.documentElement.clientHeight > 0 && !!doc.defaultView;

  function metaContent(doc, sel) {
    const m = doc.querySelector(sel);
    return m ? norm(m.getAttribute('content')) : '';
  }

  function isInlineOnly(el) {
    for (const n of el.childNodes) {
      if (n.nodeType === 1 && !INLINE_TAGS.has(n.tagName) && n.tagName !== 'IMG') return false;
    }
    return true;
  }

  function imageBlock(img, base) {
    const src = absUrl(img.currentSrc || img.getAttribute('src') || img.getAttribute('data-src') || '', base);
    if (!src || src.startsWith('data:image/gif')) return null;
    const w = parseInt(img.getAttribute('width') || '0', 10);
    const h = parseInt(img.getAttribute('height') || '0', 10);
    if ((w && w < MIN_IMG_PX) || (h && h < MIN_IMG_PX)) return null;
    let name = norm(img.getAttribute('alt'));
    if (!name) { try { name = decodeURIComponent(new URL(src).pathname.split('/').pop() || 'image'); } catch (e) { name = 'image'; } }
    return { type: 'image', src, alt: name.slice(0, 80) };
  }

  // A <table> is data if it has ≥2 rows, no nested tables and mostly short cells.
  function isDataTable(t) {
    if (t.querySelector('table')) return false;
    const rows = t.querySelectorAll('tr');
    if (rows.length < 2) return false;
    const cells = t.querySelectorAll('td,th');
    let long = 0;
    for (const c of cells) if (norm(c.textContent).length > 200 || c.querySelector('p,div,ul,ol')) long++;
    return long / Math.max(cells.length, 1) < 0.2;
  }

  function tableBlock(t, base) {
    const rows = [];
    let head = null;
    for (const tr of t.querySelectorAll('tr')) {
      const cells = [...tr.children].filter((c) => /^T[DH]$/.test(c.tagName)).map((c) => runsOf(c, base));
      if (!cells.some((c) => runsText(c))) continue;
      const allTh = [...tr.children].every((c) => c.tagName === 'TH');
      if (!head && allTh && rows.length === 0) head = cells.map(runsText);
      else rows.push(cells);
    }
    const caption = t.querySelector('caption');
    return rows.length ? { type: 'table', head, rows, caption: caption ? norm(caption.textContent) : '' } : null;
  }

  // ─── Walker ───
  function walkInto(rootEl, ctx) {
    const { base, fallback } = ctx;

    function textBlock(el) {
      const runs = runsOf(el, base);
      const text = runsText(runs);
      if (!text) return;
      // standalone link → lookup field
      if (runs.length === 1 && runs[0].href && text.length <= FIELD_MAX_CHARS) {
        if (!SKIP_LINK_RE.test(text)) ctx.add({ type: 'link', label: '', runs });
        return;
      }
      if (text.length <= FIELD_MAX_CHARS) ctx.add({ type: 'field', ...splitLabel(el, runs, base) });
      else ctx.add({ type: 'note', label: '', runs });
    }

    function visit(el) {
      if (ctx.full) return;
      const tag = el.tagName;
      if (SKIP_TAGS.has(tag)) return;
      if (fallback && isHidden(el)) return;
      if (fallback && (CHROME_TAGS.has(tag) || el.getAttribute('role') === 'navigation')) {
        if (tag === 'NAV' || el.getAttribute('role') === 'navigation') collectNav(el, ctx);
        return;
      }
      if (HEADING_RE.test(tag)) {
        const h = norm(el.textContent);
        if (h && h !== ctx.title) ctx.section(h);
        return;
      }
      if (tag === 'IMG') { const b = imageBlock(el, base); if (b) ctx.add(b); return; }
      if (tag === 'PICTURE') { const img = el.querySelector('img'); if (img) visit(img); return; }
      if (tag === 'FIGURE') {
        el.querySelectorAll('img').forEach((img) => { const b = imageBlock(img, base); if (b) ctx.add(b); });
        const cap = el.querySelector('figcaption');
        if (cap) textBlock(cap);
        return;
      }
      if (tag === 'UL' || tag === 'OL') {
        const items = [...el.children].filter((c) => c.tagName === 'LI').map((li) => {
          // nested lists flatten into the item text
          return runsOf(li, base);
        }).filter((r) => runsText(r));
        el.querySelectorAll(':scope > li img').forEach((img) => { const b = imageBlock(img, base); if (b) ctx.add(b); });
        // a list made (almost) only of links is navigation, tags or a mega-menu: move it out of the reading flow
        const all = items.flat();
        const linkChars = all.filter((x) => x.href).reduce((n, x) => n + x.t.trim().length, 0);
        const textChars = all.reduce((n, x) => n + x.t.trim().length, 0);
        const isLinkList = items.length && linkChars / Math.max(textChars, 1) >= LINK_TEXT_RATIO &&
          (items.length >= 3 || items.every((r) => runsText(r).length <= LINKLIST_MAX_CHARS));
        if (isLinkList) all.filter((x) => x.href).forEach((x) => ctx.related(x));
        else if (items.length) ctx.add({ type: 'list', items });
        return;
      }
      if (tag === 'DL') {
        let label = '';
        for (const c of el.children) {
          if (c.tagName === 'DT') label = norm(c.textContent).slice(0, LABEL_MAX_CHARS);
          else if (c.tagName === 'DD') { const runs = runsOf(c, base); if (runsText(runs)) ctx.add({ type: runsText(runs).length > FIELD_MAX_CHARS ? 'note' : 'field', label, runs }); }
        }
        return;
      }
      if (tag === 'TABLE') {
        if (isDataTable(el)) { const b = tableBlock(el, base); if (b) ctx.add(b); }
        else el.querySelectorAll(':scope > tbody > tr > td, :scope > tr > td, :scope > thead > tr > td').forEach(visit);
        return;
      }
      if (tag === 'PRE' || tag === 'BLOCKQUOTE' && isInlineOnly(el)) { textBlock(el); return; }
      if (tag === 'A' && !el.closest('p')) {
        const img = el.querySelector('img');
        if (img && !norm(el.textContent)) { const b = imageBlock(img, base); if (b) ctx.add(b); return; }
      }
      if (isInlineOnly(el)) {
        el.querySelectorAll('img').forEach((img) => { const b = imageBlock(img, base); if (b) ctx.add(b); });
        textBlock(el);
        return;
      }
      // mixed container: text nodes between block children become their own blocks
      let pending = [];
      const flush = () => {
        if (!pending.length) return;
        const wrap = el.ownerDocument.createElement('span');
        pending.forEach((n) => wrap.appendChild(n.cloneNode(true)));
        pending = [];
        textBlock(wrap);
      };
      for (const n of el.childNodes) {
        if (n.nodeType === 3 || (n.nodeType === 1 && INLINE_TAGS.has(n.tagName))) pending.push(n);
        else if (n.nodeType === 1) { flush(); visit(n); }
      }
      flush();
    }

    visit(rootEl);
  }

  function collectNav(el, ctx) {
    for (const a of el.querySelectorAll('a[href]')) {
      if (ctx.nav.length >= 15) return;
      const t = norm(a.textContent);
      const href = absUrl(a.getAttribute('href'), ctx.base);
      if (t && t.length < 40 && href && !ctx.nav.some((n) => n.href === href)) ctx.nav.push({ t, href });
    }
  }

  function cleanTitle(doc, override) {
    const raw = norm(override || doc.title);
    const h1 = doc.querySelector('h1');
    const h1t = h1 ? norm(h1.textContent) : '';
    if (raw) {
      // "Story | Site" → Story; prefer the part that matches the h1, else the first one
      const parts = raw.split(TITLE_SPLIT_RE).filter((p) => p.length >= 3);
      if (!parts.length) return raw;
      return parts.find((p) => h1t && (h1t.includes(p) || p.includes(h1t))) || parts[0];
    }
    return h1t || 'Untitled record';
  }

  function buildModel(rootEl, doc, opts) {
    const base = opts.url || (doc.location && doc.location.href) || doc.baseURI;
    const model = {
      title: opts.title,
      site: opts.site,
      url: base,
      extractor: opts.extractor,
      kind: 'article',
      meta: {},
      sections: [],
      nav: [],
      related: [],
      items: [],
      truncated: false,
    };
    let current = null;
    let count = 0;
    const ctx = {
      base,
      title: opts.title,
      fallback: opts.extractor === 'fallback',
      nav: model.nav,
      full: false,
      section(heading) { current = { heading, blocks: [] }; model.sections.push(current); },
      related(run) {
        const t = norm(run.t);
        if (!SKIP_LINK_RE.test(t) && !model.related.some((r) => r.href === run.href)) model.related.push({ t, href: run.href });
      },
      add(block) {
        if (count >= MAX_BLOCKS) { ctx.full = true; model.truncated = true; return; }
        if (!current) ctx.section('Details');
        current.blocks.push(block);
        count++;
      },
    };
    walkInto(rootEl, ctx);
    if (!ctx.fallback) doc.querySelectorAll('nav, [role="navigation"]').forEach((n) => collectNav(n, ctx));
    model.sections = model.sections.filter((s) => s.blocks.length);
    return model;
  }

  // Text the model carries, for the coverage invariant.
  function modelText(model) {
    const out = [];
    for (const s of model.sections) {
      out.push(s.heading);
      for (const b of s.blocks) {
        if (b.label) out.push(b.label);
        if (b.runs) out.push(runsText(b.runs));
        if (b.items) b.items.forEach((r) => out.push(runsText(r)));
        if (b.head) out.push(b.head.join(' '));
        if (b.rows) b.rows.forEach((row) => row.forEach((c) => out.push(runsText(c))));
        if (b.caption) out.push(b.caption);
      }
    }
    for (const r of model.related || []) out.push(r.t);
    for (const it of model.items || []) out.push(it.title || '', it.summary || '', it.runs ? runsText(it.runs) : '');
    return norm(out.join(' '));
  }

  // ─── Feeds (social timelines, threads) ───
  const pathOf = (u) => { try { return new URL(u).pathname.replace(/\/+$/, ''); } catch (e) { return ''; } };

  function postText(el, perma) {
    // X marks the text explicitly; otherwise take the longest inline-only block that is not a link
    const marked = el.querySelectorAll('[data-testid="tweetText"]');
    if (marked.length) return { main: marked[0], quote: marked[1] || null };
    let best = null;
    let bestLen = 0;
    for (const b of el.querySelectorAll('p, div, span')) {
      if (b.contains(perma) || b.closest('a, [role="group"], button') || !isInlineOnly(b)) continue;
      const len = norm(b.textContent).length;
      if (len > bestLen) { best = b; bestLen = len; }
    }
    return { main: best, quote: null };
  }

  function postAuthor(el, base) {
    const box = el.querySelector('[data-testid="User-Name"]') || el;
    let name = '';
    let href = '';
    for (const a of box.querySelectorAll('a[href]')) {
      const path = pathOf(absUrl(a.getAttribute('href'), base));
      const t = norm(a.textContent);
      if (/^\/@?[^/]+$/.test(path) && t && !t.startsWith('@') && t.length <= 60) { name = t; href = absUrl(a.getAttribute('href'), base); break; }
    }
    let handle = '';
    for (const sp of box.querySelectorAll('span')) { const t = norm(sp.textContent); if (/^@[\w.]+$/.test(t)) { handle = t; break; } }
    return { name, handle, href };
  }

  function feedPosts(doc, base) {
    const live = hasLayout(doc);
    const self = pathOf(base);
    const byHref = new Map();
    for (const el of doc.querySelectorAll(POST_SEL)) {
      if (el.parentElement && el.parentElement.closest(POST_SEL)) continue;
      if (live && !el.getClientRects().length) continue;
      let perma = null;
      for (const t of el.querySelectorAll('time')) { const a = t.closest('a[href]'); if (a && el.contains(a)) { perma = a; break; } }
      if (!perma) perma = [...el.querySelectorAll('a[href]')].find((a) => PERMALINK_HINT_RE.test(a.getAttribute('href')));
      if (!perma) continue;
      const href = absUrl(perma.getAttribute('href'), base).split(/[?#]/)[0];
      const { main, quote } = postText(el, perma);
      const runs = main ? runsOf(main, base, true) : [];
      // news-style cards carry a long headline link: those belong to index mode, not feeds
      const headline = [...el.querySelectorAll('a[href]')].some((a) => a !== perma && (!main || !main.contains(a)) && norm(a.textContent).length >= CARD_HEADLINE_CHARS);
      if (headline && !el.querySelector('[data-testid="tweetText"]')) continue;
      const author = postAuthor(el, base);
      const timeEl = perma.querySelector('time') || el.querySelector('time');
      let image = '';
      for (const img of el.querySelectorAll('img')) {
        if (quote && quote.parentElement && quote.parentElement.contains(img) && !img.closest('[data-testid="tweetPhoto"]')) continue;
        if (img.closest('[data-testid="Tweet-User-Avatar"]') || AVATAR_RE.test(img.getAttribute('src') || '') || AVATAR_RE.test(img.className || '')) continue;
        const b = imageBlock(img, base);
        if (b) { image = b.src; break; }
      }
      const group = el.querySelector('[role="group"][aria-label]');
      const ctxEl = el.querySelector('[data-testid="socialContext"]');
      const quoteBox = quote && quote.closest('[role="link"]');
      const item = {
        href, runs,
        author: author.name, handle: author.handle, authorHref: author.href,
        time: timeEl ? norm(timeEl.textContent) : '',
        datetime: timeEl ? timeEl.getAttribute('datetime') || '' : '',
        image, video: !!el.querySelector('video, [data-testid="videoPlayer"]'),
        stats: group ? norm(group.getAttribute('aria-label')) : '',
        context: ctxEl ? norm(ctxEl.textContent) : '',
        quote: quote ? { runs: runsOf(quote, base, true), author: quoteBox ? postAuthor(quoteBox, base).name || norm((quoteBox.querySelector('[data-testid="User-Name"] span') || {}).textContent) : '' } : null,
        focal: pathOf(href) === self,
      };
      if (!byHref.has(href)) byHref.set(href, item);
      if (byHref.size >= MAX_ITEMS) break;
    }
    return [...byHref.values()];
  }

  // ─── Index pages (home, section fronts, blogs, link aggregators) ───
  function headlineLinks(doc, base) {
    const live = hasLayout(doc);
    const self = (base || '').split('#')[0];
    const out = [];
    for (const a of doc.querySelectorAll('a[href]')) {
      const href = absUrl(a.getAttribute('href'), base).split('#')[0];
      if (!/^(https?|file):/.test(href) || href === self) continue;
      if (a.closest('nav, footer, [role="navigation"], [role="contentinfo"]')) continue;
      let t = norm(a.textContent);
      // card-wide overlay links carry no text, only an aria-label (theguardian.com and many others)
      if (t.length < HEADLINE_MIN_CHARS) { const al = norm(a.getAttribute('aria-label')); if (al.length >= HEADLINE_MIN_CHARS) t = al; }
      const inHeading = !!a.closest('h1, h2, h3, h4');
      if ((t.length < HEADLINE_MIN_CHARS && !(inHeading && t.length >= 8)) || t.length > 300) continue;
      if (live && !a.getClientRects().length) continue;
      out.push({ a, href, title: t });
    }
    return out;
  }

  function pageKind(doc, url, articleText, headlines) {
    let art = 0;
    let idx = 0;
    const og = metaContent(doc, 'meta[property="og:type"]').toLowerCase();
    if (/article|blog|post/.test(og)) art += 2;
    else if (og === 'website') idx += 1;
    const ld = [...doc.querySelectorAll('script[type="application/ld+json"]')].map((s) => s.textContent).join('\n');
    if (ARTICLE_LD_RE.test(ld)) art += 2;
    if (INDEX_LD_RE.test(ld)) idx += 1;
    let segs = [];
    try { segs = new URL(url).pathname.split('/').filter(Boolean); } catch (e) { segs = []; }
    const last = (segs[segs.length - 1] || '').replace(/\.html?$/, '');
    if (segs.length === 0) idx += 2;
    else if (segs.length === 1 && last.length <= 20 && !SLUG_RE.test(last)) idx += 1;
    if (SLUG_RE.test(last)) art += 1;
    if (doc.querySelectorAll('article').length >= 3) idx += 2;
    if (headlines.length >= 15) idx += 1;
    if (articleText.length >= 1500) art += 1;
    if (idx > art) return 'index';
    if (!articleText && headlines.length >= INDEX_MIN_HEADLINES) return 'index';
    return 'article';
  }

  // "Russia" + "Russia strikes at..." rendered inline: split a short leading label off the headline
  function splitKicker(el) {
    for (const node of [el, ...el.querySelectorAll('h1, h2, h3, h4, div, span')]) {
      const kids = [...node.children];
      if (kids.length < 2) continue;
      const kicker = norm(kids[0].textContent);
      const rest = norm(kids.slice(1).map((k) => k.textContent).join(' '));
      if (kicker && kicker.length <= KICKER_MAX_CHARS && rest.length >= 15 && norm(node.textContent).startsWith(kicker)) return { kicker, title: rest };
    }
    return { kicker: '', title: norm(el.textContent) };
  }

  function indexItems(doc, base, links) {
    const cands = new Set(links.map((l) => l.a));
    const hasH2 = !!doc.querySelector('h2');
    const headings = [...doc.querySelectorAll(hasH2 ? 'h2' : 'h2, h3')].filter((h) => {
      const t = norm(h.textContent);
      return t.length >= 2 && t.length <= 60 && ![...h.querySelectorAll('a')].some((a) => cands.has(a));
    });
    const byHref = new Map();
    for (const link of links) {
      const { a, href } = link;
      let { title } = link;
      // widest ancestor that still holds only this headline = the story card
      let box = a;
      while (box.parentElement && box.parentElement !== doc.body) {
        const p = box.parentElement;
        let other = false;
        for (const x of p.querySelectorAll('a[href]')) {
          if (x !== a && cands.has(x) && absUrl(x.getAttribute('href'), base).split('#')[0] !== href) { other = true; break; }
        }
        if (other) break;
        box = p;
      }
      // an overlay link that shares its card with sub-links cannot widen; look around it instead,
      // ignoring anything that belongs to another headline link
      const scope = box === a && a.parentElement ? a.parentElement : box;
      const own = (el) => { const l = el.closest('a[href]'); return !l || l === a || !cands.has(l); };
      const find = (sel) => [...scope.querySelectorAll(sel)].filter(own);
      // headline element: inside the link, or (overlay links) the card's heading
      const headEl = a.querySelector('h1, h2, h3, h4') || (!norm(a.textContent) ? find('h2, h3, h4').find((x) => !headings.includes(x)) : null) || a;
      const parts = splitKicker(headEl);
      let kicker = '';
      if (parts.kicker && parts.title) { kicker = parts.kicker; title = parts.title; }
      let summary = '';
      for (const el of find(SUMMARY_SEL)) {
        const t = norm(el.textContent);
        if (t.length >= 30 && t.length <= 400 && !t.includes(title) && !title.includes(t)) { summary = t; break; }
      }
      // table-layout listings (Hacker News style) keep the byline in the next row
      const nx = box.tagName === 'TR' && box.nextElementSibling;
      if (!summary && nx && ![...nx.querySelectorAll('a[href]')].some((x) => cands.has(x))) summary = norm(nx.textContent).slice(0, 200);
      const timeEl = find('time')[0];
      const time = timeEl ? norm(timeEl.textContent) || norm(timeEl.getAttribute('datetime')) : '';
      let image = '';
      for (const img of find('img')) { const b = imageBlock(img, base); if (b) { image = b.src; break; } }
      let group = '';
      for (const h of headings) {
        if (a.contains(h) || h.contains(a) || headEl.contains(h)) continue;
        if (h.compareDocumentPosition(a) & 4) group = norm(h.textContent); else break;
      }
      const prev = byHref.get(href);
      if (prev) {
        if (title.length > prev.title.length) prev.title = title;
        prev.summary = prev.summary || summary; prev.image = prev.image || image; prev.time = prev.time || time;
        prev.kicker = prev.kicker || kicker;
      } else byHref.set(href, { title, href, summary, time, image, group, kicker });
      if (byHref.size >= MAX_ITEMS) break;
    }
    return [...byHref.values()];
  }

  function pageMeta(doc, article) {
    const pub = (article && article.publishedTime) || metaContent(doc, 'meta[property="article:published_time"]') || metaContent(doc, 'meta[name="date"]');
    let published = '';
    if (pub) { const d = new Date(pub); published = isNaN(d) ? pub : d.toISOString(); }
    const timeEl = !published && doc.querySelector('article time[datetime], time[datetime]');
    if (timeEl) { const d = new Date(timeEl.getAttribute('datetime')); if (!isNaN(d)) published = d.toISOString(); }
    return {
      byline: norm((article && article.byline) || metaContent(doc, 'meta[name="author"]')).replace(/^by\s+/i, '').slice(0, 80),
      siteName: norm((article && article.siteName) || metaContent(doc, 'meta[property="og:site_name"]')).slice(0, 60),
      excerpt: norm((article && article.excerpt) || metaContent(doc, 'meta[name="description"]')).slice(0, 400),
      published,
    };
  }

  // Drop page chrome that survives extraction: repeated deks (responsive duplicates), the byline line
  // already shown in the header, a bare date line and one-word button labels. Content blocks are kept.
  function tidy(model) {
    const seen = new Set();
    const byline = (model.meta.byline || '').toLowerCase();
    const isChrome = (t, linked) =>
      t === model.title || SKIP_LINK_RE.test(t) ||
      (byline && /^by\s/i.test(t) && t.toLowerCase().includes(byline)) ||
      (t.length <= DATE_LINE_MAX && DATE_SHAPE_RE.test(t) && !isNaN(Date.parse(t.replace(/\bUTC\b|,(?=\s*\d{1,2}:)/g, '')))) ||
      (!linked && /^\S+$/.test(t) && t.length <= ONE_WORD_MAX);
    for (const sec of model.sections) {
      sec.blocks = sec.blocks.filter((b) => {
        if (!b.runs || b.label) return true;
        const t = runsText(b.runs);
        if (!t || isChrome(t, b.runs.some((r) => r.href)) || seen.has(t)) return false;
        seen.add(t);
        return true;
      });
    }
    model.sections = model.sections.filter((sec) => sec.blocks.length);
  }

  // ─── API ───
  function extract(doc, opts) {
    opts = opts || {};
    const Readability = opts.Readability || root.Readability;
    const url = opts.url || (doc.location && doc.location.href) || '';
    let site = '';
    try { site = new URL(url).hostname.replace(/^www\./, ''); } catch (e) { site = ''; }
    const title = cleanTitle(doc, opts.title);

    // feeds first: cheap, and Readability would collapse a timeline into one post
    const posts = opts.kind && opts.kind !== 'feed' ? [] : feedPosts(doc, url);
    if (posts.length >= FEED_MIN_POSTS || posts.some((p) => p.focal) || opts.kind === 'feed') {
      const model = buildModel(doc.createElement('div'), doc, { url, site, title, extractor: 'feed' });
      model.kind = 'feed';
      model.items = posts;
      const focal = posts.find((p) => p.focal);
      if (focal) model.title = runsText(focal.runs).slice(0, 90) || title;
      model.meta = pageMeta(doc, null);
      model.sourceChars = null;
      model.modelChars = modelText(model).length;
      return model;
    }

    let article = null;
    if (Readability && doc.body) {
      try { article = new Readability(doc.cloneNode(true), { charThreshold: 200 }).parse(); } catch (e) { article = null; }
    }
    const articleText = article ? norm(article.textContent) : '';
    const headlines = headlineLinks(doc, url);
    const kind = opts.kind || pageKind(doc, url, articleText.length >= MIN_ARTICLE_CHARS ? articleText : '', headlines);
    let model;
    if (kind === 'index') {
      model = buildModel(doc.createElement('div'), doc, { url, site, title, extractor: 'index' });
      model.kind = 'index';
      model.items = indexItems(doc, url, headlines);
      model.meta = pageMeta(doc, null);
      model.sourceChars = null;
      model.modelChars = modelText(model).length;
      return model;
    }
    if (articleText.length >= MIN_ARTICLE_CHARS) {
      const Parser = opts.DOMParser || (doc.defaultView && doc.defaultView.DOMParser) || root.DOMParser;
      const inert = new Parser().parseFromString(article.content, 'text/html');
      model = buildModel(inert.body, doc, { url, site, title, extractor: 'readability' });
      model.sourceChars = articleText.length;
    } else {
      model = buildModel(doc.body || doc.documentElement, doc, { url, site, title, extractor: 'fallback' });
      model.sourceChars = null;
    }
    model.meta = pageMeta(doc, article);
    tidy(model);
    model.modelChars = modelText(model).length;
    return model;
  }

  const api = { extract, modelText, runsText, VERSION: '0.1.1' };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ProLookExtract = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
