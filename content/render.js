// Pro Look – Model → CRM record page inside a Shadow-DOM overlay.
// The original page stays untouched underneath; unmount restores it instantly.
(function (root) {
  'use strict';

  // ─── Constants ───
  const VERSION = '0.1.1';
  const HOST_ID = 'pro-look-root';
  const FAKE_TITLES = { article: 'Opportunity | Workspace', index: 'Opportunities | Workspace', feed: 'Cases | Workspace', case: 'Case | Workspace' };
  const CASE_STAGES = ['New', 'Working', 'Escalated', 'Resolved', 'Closed'];
  const CASE_STATUSES = ['New', 'Working', 'Escalated', 'Waiting on Customer', 'Closed'];
  const LOAD_MORE_PX = 600;
  const LOAD_MORE_THROTTLE_MS = 1500;
  const STAGES = ['Qualify', 'Develop', 'Propose', 'Negotiate', 'Close'];
  const APP_TABS = ['Home', 'Accounts', 'Contacts', 'Opportunities', 'Reports', 'Dashboards'];
  // Article paragraphs become activity-timeline entries of these kinds (reading order preserved)
  const TL_KINDS = [
    { k: 'email', label: 'Email', glyph: '✉' },
    { k: 'call', label: 'Call', glyph: '☎' },
    { k: 'note', label: 'Note', glyph: '✎' },
    { k: 'meeting', label: 'Meeting', glyph: '◷' },
  ];
  const TABLE_HEADS = ['Ref', 'Subject', 'Details', 'Status', 'Value', 'Region', 'Date', 'Owner'];
  const EXCERPT_DUP_CHARS = 50;
  const EXCERPT_LOOKAHEAD = 3;
  const OWNERS = ['A. Novak', 'M. Chen', 'J. Silva', 'K. Ito', 'R. Patel', 'L. Weber', 'S. Kowalski', 'D. Okafor'];
  const TASKS = ['Follow up with {site}', 'Send revised proposal', 'Schedule discovery call', 'Update forecast',
    'Review contract terms', 'Prepare QBR deck', 'Confirm pricing with finance', 'Log call notes', 'Book onsite demo'];
  const SAFE_HREF_RE = /^(https?:|file:)/i;
  // Page CSS can target the host <div> (even with !important); inline !important wins over all of it.
  const HOST_LOCK = {
    display: 'block', position: 'fixed', inset: '0', 'z-index': '2147483647', opacity: '1', visibility: 'visible',
    transform: 'none', filter: 'none', 'clip-path': 'none', margin: '0', padding: '0', border: '0', 'pointer-events': 'auto',
  };

  // ─── State ───
  const S = {
    host: null, shadow: null, model: null, opts: null,
    saved: null, titleObserver: null, rng: null, clock: null, fakeTitle: FAKE_TITLES.article, lastMore: 0, moreTimer: null,
  };

  // ─── Helpers ───
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const k of kids.flat(Infinity)) if (k != null && k !== false) el.append(k.nodeType ? k : String(k));
    return el;
  }

  function hashStr(s) {
    let x = 2166136261;
    for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619); }
    return x >>> 0;
  }
  function mulberry(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const pick = (arr) => arr[Math.floor(S.rng() * arr.length)];
  const rint = (a, b) => a + Math.floor(S.rng() * (b - a + 1));
  const fmtDate = (d) => d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  const dayOffset = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return fmtDate(d); };
  const fmtStamp = (d) => d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  function hostOf(url) { try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return ''; } }

  function runsEl(runs) {
    const frag = document.createDocumentFragment();
    for (const r of runs || []) {
      if (r.href && SAFE_HREF_RE.test(r.href)) frag.append(h('a', { href: r.href, text: r.t }));
      else frag.append(r.t);
    }
    return frag;
  }
  const runsText = (runs) => (runs || []).map((r) => r.t).join('').replace(/\s+/g, ' ').trim();

  // ─── Render: blocks ───
  function fieldEl(block) {
    const label = block.label || 'Related Record';
    return h('div', { class: 'field' + (block.wide ? ' wide' : ''), 'data-pl-item': '' },
      h('span', { class: 'f-l', text: label }),
      h('span', { class: 'f-v' + (block.type === 'link' ? ' lookup' : '') }, runsEl(block.runs)));
  }

  // one timeline entry: icon, "Email · M. Chen · Sep 24, 10:42", then the content
  function entryEl(kind, content) {
    S.clock = new Date(S.clock.getTime() + rint(4, 55) * 60000);
    return h('li', { class: 'tl-e', 'data-kind': kind.k, 'data-pl-item': '' },
      h('span', { class: 'tl-ico ' + kind.k, 'aria-hidden': 'true', text: kind.glyph }),
      h('div', { class: 'tl-c' },
        h('div', { class: 'tl-m' }, h('b', { text: kind.label }), ` · ${pick(OWNERS)} · ${fmtStamp(S.clock)}`),
        h('div', { class: 'tl-b' }, content)));
  }

  const textEntryEl = (runs) => entryEl(pick(TL_KINDS), runsEl(runs));

  function taskEntryEl(block) {
    return entryEl({ k: 'task', label: 'Task list', glyph: '✓' },
      h('ul', { class: 'chk' }, block.items.map((runs) => h('li', {}, h('span', { class: 'box', 'aria-hidden': 'true' }), h('span', {}, runsEl(runs))))));
  }

  function fileEntryEl(img) {
    return entryEl({ k: 'file', label: 'File', glyph: '▤' },
      h('span', { class: 'file-cell' },
        h('img', { class: 'thumb', src: img.src, alt: img.alt, loading: 'lazy', referrerpolicy: 'no-referrer', 'data-alt': img.alt }),
        h('span', { text: img.alt })));
  }

  function relatedList(title, iconClass, iconText, count, table) {
    return h('div', { class: 'rl' },
      h('div', { class: 'rl-h' }, h('span', { class: 'ico sm ' + iconClass, text: iconText }), title, h('span', { class: 'count', text: `(${count})` })),
      h('div', { class: 'tbl-wrap' }, table));
  }

  function tableEl(block) {
    const width = Math.max(block.head ? block.head.length : 0, ...block.rows.map((r) => r.length));
    const head = block.head || Array.from({ length: width }, (_, i) => TABLE_HEADS[i] || `Field ${i + 1}`);
    const table = h('table', {},
      h('thead', {}, h('tr', {}, head.map((t) => h('th', { text: t })))),
      h('tbody', {}, block.rows.map((row) => h('tr', { 'data-pl-item': '' },
        Array.from({ length: width }, (_, i) => h('td', {}, runsEl(row[i])))))));
    return relatedList(block.caption || 'Report Data', 'opp', 'R', block.rows.length, table);
  }

  function sectionEl(sec, idx) {
    const body = h('div', { class: 'sec-b' });
    let grid = null;
    let tl = null;
    const inGrid = (el) => { tl = null; if (!grid) { grid = h('div', { class: 'grid' }); body.append(grid); } grid.append(el); };
    const inTl = (el) => { grid = null; if (!tl) { tl = h('ol', { class: 'tl' }); body.append(tl); } tl.append(el); };
    const own = (el) => { grid = null; tl = null; body.append(el); };
    for (const b of sec.blocks) {
      if (b.type === 'link' || (b.type === 'field' && b.label)) inGrid(fieldEl(b));
      else if (b.type === 'field' || b.type === 'note') inTl(textEntryEl(b.runs));
      else if (b.type === 'list') inTl(taskEntryEl(b));
      else if (b.type === 'image') inTl(fileEntryEl(b));
      else if (b.type === 'table') own(tableEl(b));
    }
    return h('section', { class: 'card sec', 'data-collapsed': 'false', 'data-pl-section': String(idx) },
      h('button', { class: 'sec-h', 'aria-expanded': 'true', text: sec.heading === 'Details' ? 'Activity' : sec.heading, onclick: (e) => toggleSection(e.currentTarget.parentElement) }),
      body);
  }

  function relatedLinksEl(model) {
    const links = model.related.filter((r) => SAFE_HREF_RE.test(r.href));
    if (!links.length) return null;
    return h('div', { class: 'card' },
      h('div', { class: 'card-h' }, h('span', { class: 'ico sm acc', text: 'L' }), 'Related Links', h('span', { class: 'count', text: `(${links.length})` })),
      h('div', { class: 'card-b chips' }, links.map((r) => h('a', { class: 'chip', href: r.href, text: r.t }))));
  }

  // ─── Render: feeds (social timelines) ───
  const caseNo = (href) => String(hashStr(href) % 1e8).padStart(8, '0');

  // "3 replies, 2 reposts, 11 likes, 2 bookmarks, 1017 views" → "3 replies · 11 likes · 1017 views"
  function statsShort(stats) {
    const m = {};
    for (const part of (stats || '').split(',')) {
      const mm = /([\d.,]+[KMB]?)\s+([A-Za-z]+)/.exec(part.trim());
      if (mm) m[mm[2].toLowerCase()] = mm[1];
    }
    return [m.replies && `${m.replies} replies`, m.likes && `${m.likes} likes`, m.views && `${m.views} views`].filter(Boolean).join(' · ');
  }

  const thumbEl = (src, alt) => h('img', { class: 'thumb', src, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer', 'data-alt': alt });
  const initialEl = (name) => h('span', { class: 'ico acc', 'aria-hidden': 'true', text: (name || '?').trim().slice(0, 1).toUpperCase() });

  function postBodyEl(it) {
    return h('div', { class: 'post' },
      it.context ? h('div', { class: 'post-ctx', text: it.context }) : null,
      h('div', { class: 'post-b' }, runsEl(it.runs)),
      it.quote ? h('div', { class: 'post-q' }, it.quote.author ? h('b', { text: it.quote.author + ': ' }) : null, runsEl(it.quote.runs)) : null,
      it.video ? h('span', { class: 'pill', text: 'Video attached' }) : null);
  }

  function moreEl() {
    return h('div', { class: 'more' },
      h('button', { class: 'btn', type: 'button', 'data-pl-more': '', text: 'Load more', onclick: () => needMore(true) }),
      h('span', { class: 'hl-l', 'data-pl-more-status': '', 'aria-live': 'polite' }));
  }

  function feedListEl(model) {
    const items = model.items.filter((it) => SAFE_HREF_RE.test(it.href));
    const rows = items.map((it, i) => h('tr', { 'data-pl-item': '' },
      h('td', { class: 'num', text: String(i + 1) }),
      h('td', {}, h('div', { class: 'lv-name top' },
        it.image ? thumbEl(it.image, runsText(it.runs).slice(0, 80)) : initialEl(it.author),
        h('div', {},
          h('div', { class: 'post-h' }, h('a', { class: 'lv-link', href: it.href, text: it.author || 'Case' }), it.handle ? h('span', { class: 'muted', text: ' ' + it.handle }) : null),
          postBodyEl(it)))),
      h('td', { class: 'meta', text: caseNo(it.href) }),
      h('td', {}, h('span', { class: 'pill', text: pick(CASE_STATUSES) })),
      h('td', { class: 'meta', text: it.time }),
      h('td', { class: 'meta', text: statsShort(it.stats) })));
    const table = h('table', { class: 'lv-t' },
      h('thead', {}, h('tr', {}, ['', 'Subject', 'Case Number', 'Status', 'Opened', 'Engagement'].map((t) => h('th', { text: t })))),
      h('tbody', {}, rows));
    return [
      h('div', { class: 'card' }, h('div', { class: 'rec-head' },
        h('div', { class: 'rec-top' },
          h('span', { class: 'ico task', 'aria-hidden': 'true', text: 'C' }),
          h('div', {}, h('div', { class: 'rec-kind', text: 'Cases' }), h('h1', { class: 'rec-name', text: `${model.title} ▾` })),
          h('div', { class: 'rec-actions' }, ['New', 'Assign', 'Change Status'].map((t) => h('button', { class: 'btn', type: 'button', text: t })))),
        h('div', { class: 'hl-l', text: `${items.length} cases · Sorted by Date Opened · Updated a few seconds ago` }))),
      items.length
        ? h('section', { class: 'card sec lv', 'data-pl-section': '0' }, h('div', { class: 'tbl-wrap' }, table), moreEl())
        : h('div', { class: 'card empty', text: 'Loading cases...' }),
    ];
  }

  function commentEl(it) {
    return h('li', { class: 'tl-e', 'data-kind': 'email', 'data-pl-item': '' },
      h('span', { class: 'tl-ico email', 'aria-hidden': 'true', text: '✉' }),
      h('div', { class: 'tl-c' },
        h('div', { class: 'tl-m' }, h('b', { text: 'Comment' }), ' · ', h('a', { href: it.href, text: it.author || 'Reply' }),
          it.handle ? ` ${it.handle}` : '', it.time ? ` · ${it.time}` : '', it.stats ? ` · ${statsShort(it.stats)}` : ''),
        h('div', { class: 'tl-b' }, postBodyEl(it), it.image ? h('div', { class: 'file-cell' }, thumbEl(it.image, 'Attachment'), h('span', { text: 'Attachment' })) : null)));
  }

  // One post's own page: the post is the Case, replies are its comment timeline
  function caseRecordEl(model) {
    const f = model.items.find((it) => it.focal);
    const replies = model.items.filter((it) => !it.focal && SAFE_HREF_RE.test(it.href));
    const opened = f.datetime && !isNaN(new Date(f.datetime)) ? fmtStamp(new Date(f.datetime)) : f.time;
    const full = runsText(f.runs);
    const details = h('div', { class: 'grid' },
      h('div', { class: 'field wide', 'data-pl-item': '' }, h('span', { class: 'f-l', text: 'Description' }), h('span', { class: 'f-v post-b' }, runsEl(f.runs))),
      f.quote ? h('div', { class: 'field wide', 'data-pl-item': '' }, h('span', { class: 'f-l', text: 'Related Case' }), h('span', { class: 'f-v' }, f.quote.author ? h('b', { text: f.quote.author + ': ' }) : null, runsEl(f.quote.runs))) : null,
      f.image ? h('div', { class: 'field', 'data-pl-item': '' }, h('span', { class: 'f-l', text: 'Attachment' }), h('span', { class: 'f-v file-cell' }, thumbEl(f.image, 'Attachment'), h('span', { text: 'Attachment' }))) : null,
      f.video ? h('div', { class: 'field', 'data-pl-item': '' }, h('span', { class: 'f-l', text: 'Media' }), h('span', { class: 'f-v', text: 'Video attached' })) : null);
    return [
      h('div', { class: 'card' },
        h('div', { class: 'rec-head' },
          h('div', { class: 'rec-top' },
            h('span', { class: 'ico task', 'aria-hidden': 'true', text: 'C' }),
            h('div', {}, h('div', { class: 'rec-kind', text: `Case ${caseNo(f.href)}` }), h('h1', { class: 'rec-name', text: model.title + (full.length > model.title.length ? '…' : '') })),
            h('div', { class: 'rec-actions' }, ['Follow', 'Edit', 'Close Case', '▾'].map((t) => h('button', { class: 'btn', type: 'button', text: t })))),
          h('div', { class: 'highlights' },
            [['Account Name', f.author || model.site], ['Contact', f.handle || '-'], ['Opened', opened || '-'],
              ['Engagement', statsShort(f.stats) || '-'], ['Priority', pick(['High', 'Medium', 'Low'])], ['Case Owner', pick(OWNERS)]]
              .map(([l, v]) => h('div', {}, h('div', { class: 'hl-l', text: l }), h('div', { class: 'hl-v', text: v }))))),
        h('ol', { class: 'path', 'aria-label': 'Reading progress' }, CASE_STAGES.map((st) => h('li', { text: st, 'data-state': 'todo' })))),
      h('section', { class: 'card sec', 'data-collapsed': 'false', 'data-pl-section': '0' },
        h('button', { class: 'sec-h', 'aria-expanded': 'true', text: 'Case Details', onclick: (e) => toggleSection(e.currentTarget.parentElement) }),
        h('div', { class: 'sec-b' }, details)),
      h('section', { class: 'card sec', 'data-collapsed': 'false', 'data-pl-section': '1' },
        h('button', { class: 'sec-h', 'aria-expanded': 'true', text: `Comments (${replies.length})`, onclick: (e) => toggleSection(e.currentTarget.parentElement) }),
        h('div', { class: 'sec-b' }, replies.length ? h('ol', { class: 'tl' }, replies.map(commentEl)) : h('div', { class: 'hl-l', text: 'No comments loaded yet.' }), moreEl())),
    ];
  }

  // Index pages: every headline is a row in an "All Opportunities" list view
  function listViewEl(model) {
    const items = model.items.filter((it) => SAFE_HREF_RE.test(it.href));
    const rows = items.map((it, i) => h('tr', { 'data-pl-item': '' },
      h('td', { class: 'num', text: String(i + 1) }),
      h('td', {}, h('div', { class: 'lv-name' },
        it.image
          ? h('img', { class: 'thumb', src: it.image, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer', 'data-alt': it.title })
          : h('span', { class: 'ico opp', 'aria-hidden': 'true', text: 'O' }),
        h('div', {}, h('a', { class: 'lv-link', href: it.href, text: it.title }), it.summary ? h('div', { class: 'lv-sum', text: it.summary }) : null))),
      h('td', { class: 'meta', text: it.kicker || it.group || hostOf(it.href) }),
      h('td', {}, h('span', { class: 'pill', text: pick(STAGES) })),
      h('td', { class: 'meta', text: it.time || dayOffset(rint(3, 60)) }),
      h('td', { class: 'meta', text: pick(OWNERS) })));
    const table = h('table', { class: 'lv-t' },
      h('thead', {}, h('tr', {}, ['', 'Opportunity Name', 'Account Name', 'Stage', 'Close Date', 'Owner'].map((t) => h('th', { text: t })))),
      h('tbody', {}, rows));
    const where = (model.meta && model.meta.siteName) || model.site || 'All';
    return [
      h('div', { class: 'card' }, h('div', { class: 'rec-head' },
        h('div', { class: 'rec-top' },
          h('span', { class: 'ico opp', 'aria-hidden': 'true', text: 'O' }),
          h('div', {}, h('div', { class: 'rec-kind', text: 'Opportunities' }), h('h1', { class: 'rec-name', text: `${model.title} ▾` })),
          h('div', { class: 'rec-actions' }, ['New', 'Import', 'Change Owner'].map((t) => h('button', { class: 'btn', type: 'button', text: t })))),
        h('div', { class: 'hl-l', text: `${items.length} items · Sorted by Close Date · Filtered by Account: ${where} · Updated a few seconds ago` }))),
      items.length
        ? h('section', { class: 'card sec lv', 'data-pl-section': '0' }, h('div', { class: 'tbl-wrap' }, table))
        : h('div', { class: 'card empty', text: 'No items to display in this list view.' }),
    ];
  }

  function toggleSection(card) {
    const collapsed = card.getAttribute('data-collapsed') !== 'true';
    card.setAttribute('data-collapsed', String(collapsed));
    card.firstElementChild.setAttribute('aria-expanded', String(!collapsed));
  }

  // ─── Render: shell ───
  function topbar() {
    return h('header', { class: 'topbar' },
      h('span', { class: 'waffle', 'aria-hidden': 'true' }, Array.from({ length: 9 }, () => h('i'))),
      h('span', { class: 'appname', text: 'Workspace' }),
      h('label', { class: 'search' },
        h('span', { class: 'sr', text: 'Search this record' }),
        h('input', { type: 'search', placeholder: 'Search Opportunities and more...', 'data-pl-search': '', oninput: (e) => filter(e.target.value) }),
        h('kbd', { text: '/' })),
      h('span', { class: 'tb-icons', 'aria-hidden': 'true' }, h('span', { class: 'tb-icon' }), h('span', { class: 'tb-icon' }), h('span', { class: 'avatar', text: 'ME' })));
  }

  function tabs(model) {
    const more = h('details', {},
      h('summary', { text: 'More ▾' }),
      h('div', { class: 'menu' }, model.nav.filter((n) => SAFE_HREF_RE.test(n.href)).map((n) => h('a', { href: n.href, text: n.t }))));
    return h('nav', { class: 'tabs', 'aria-label': 'Apps' },
      APP_TABS.map((t) => h('span', { class: 't', 'aria-current': t === 'Opportunities' ? 'page' : null, text: t })),
      model.nav.length ? more : null);
  }

  function recordHeader(model) {
    const amount = rint(12, 480) * 1000;
    const m = model.meta || {};
    const pub = m.published ? new Date(m.published) : null;
    const created = pub && !isNaN(pub) ? fmtDate(pub) : dayOffset(-rint(1, 30));
    return h('div', { class: 'card' },
      h('div', { class: 'rec-head' },
        h('div', { class: 'rec-top' },
          h('span', { class: 'ico opp', 'aria-hidden': 'true', text: 'O' }),
          h('div', {}, h('div', { class: 'rec-kind', text: 'Opportunity' }), h('h1', { class: 'rec-name', text: model.title })),
          h('div', { class: 'rec-actions' }, ['Follow', 'Edit', 'Clone', '▾'].map((t) => h('button', { class: 'btn', type: 'button', text: t })))),
        h('div', { class: 'highlights' },
          [['Account Name', m.siteName || model.site || 'Internal'], ['Primary Contact', m.byline || pick(OWNERS)],
            ['Created', created], ['Close Date', dayOffset(rint(5, 60))],
            ['Amount', amount.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })],
            ['Opportunity Owner', pick(OWNERS)]]
            .map(([l, v]) => h('div', {}, h('div', { class: 'hl-l', text: l }), h('div', { class: 'hl-v', text: v }))))),
      h('ol', { class: 'path', 'aria-label': 'Reading progress' }, STAGES.map((s) => h('li', { text: s, 'data-state': 'todo' }))),
      h('div', { class: 'rec-tabs', role: 'tablist' },
        ['Details', 'Related', 'Activity', 'Chatter'].map((t, i) => h('span', { role: 'tab', 'aria-selected': String(i === 0), text: t }))));
  }

  function rail(model) {
    const n = rint(4, 6);
    const pool = TASKS.slice().sort(() => S.rng() - 0.5); // deterministic shuffle, no repeats
    const tasks = [];
    for (let i = 0; i < n; i++) {
      const done = i >= n - 2 && S.rng() < 0.6;
      tasks.push(h('div', { class: 'task', 'data-done': String(done) },
        h('span', { class: 'box', 'aria-hidden': 'true' }),
        h('div', {}, h('div', { class: 'tk-t', text: pool[i].replace('{site}', model.site || 'client') }),
          h('div', { class: 'tk-m', text: `${done ? 'Completed' : 'Due'} ${dayOffset(done ? -rint(1, 10) : rint(0, 14))} · ${pick(OWNERS)}` }))));
    }
    return h('aside', { class: 'rail', 'aria-label': 'Activity' },
      h('div', { class: 'card' },
        h('div', { class: 'card-h' }, h('span', { class: 'ico sm task', text: 'A' }), 'Activity'),
        h('div', { class: 'composer' }, ['Log a Call', 'New Task', 'Email'].map((t) => h('span', { text: t }))),
        h('div', { class: 'card-h' }, 'Upcoming & Overdue', h('span', { class: 'count', text: `(${tasks.length})` })),
        tasks),
      h('div', { class: 'card' },
        h('div', { class: 'card-h' }, h('span', { class: 'ico sm acc', text: 'C' }), 'Contact Roles', h('span', { class: 'count', text: '(3)' })),
        h('div', { class: 'card-b' }, OWNERS.slice(0, 3).map((o) => h('div', { class: 'field' },
          h('span', { class: 'f-l', text: pick(['Decision Maker', 'Economic Buyer', 'Evaluator', 'Influencer']) }), h('span', { class: 'f-v', text: o }))))));
  }

  // Lead/excerpt as a Description field, unless it just repeats the first paragraph
  function withDescription(model) {
    const ex = (model.meta && model.meta.excerpt) || '';
    if (!ex || !model.sections.length) return model.sections;
    const head = ex.slice(0, EXCERPT_DUP_CHARS);
    const opening = model.sections.flatMap((s) => s.blocks).filter((b) => b.runs).slice(0, EXCERPT_LOOKAHEAD);
    if (opening.some((b) => runsText(b.runs).includes(head))) return model.sections;
    const [s0, ...rest] = model.sections;
    return [{ ...s0, blocks: [{ type: 'field', label: 'Description', wide: true, runs: [{ t: ex }] }, ...s0.blocks] }, ...rest];
  }

  function titleFor(model) {
    if (model.kind === 'feed') return model.items.some((it) => it.focal) ? FAKE_TITLES.case : FAKE_TITLES.feed;
    return FAKE_TITLES[model.kind] || FAKE_TITLES.article;
  }

  function build(model) {
    S.rng = mulberry(hashStr((model.title || '') + '|' + (model.site || '')));
    S.clock = new Date();
    S.clock.setDate(S.clock.getDate() - rint(1, 6));
    S.clock.setHours(8, rint(0, 59), 0, 0);
    const content = model.kind === 'feed'
      ? (model.items.some((it) => it.focal) ? caseRecordEl(model) : feedListEl(model))
      : model.kind === 'index'
      ? listViewEl(model)
      : [recordHeader(model),
        model.sections.length
          ? withDescription(model).map(sectionEl)
          : h('div', { class: 'card empty', text: 'No records to display. Try refreshing this view.' }),
        relatedLinksEl(model)];
    const main = h('main', { class: 'main', tabindex: '-1', 'data-pl-main': '', onscroll: onScroll }, content);
    return h('div', { class: 'app', 'data-pl-kind': model.kind || 'article' },
      topbar(), tabs(model),
      h('div', { class: 'body', onscroll: onScroll }, main, rail(model)),
      h('div', { class: 'preview', hidden: true, 'data-pl-preview': '', onclick: closePreview }, h('figure', {}, h('img', { alt: '' }), h('figcaption'))),
      h('div', { class: 'sr', 'aria-live': 'polite', 'data-pl-live': '' }));
  }

  // ─── Behaviour ───
  function $(sel) { return S.shadow.querySelector(sel); }
  function $$(sel) { return [...S.shadow.querySelectorAll(sel)]; }

  function onScroll() {
    // desktop scrolls .main; the stacked mobile layout scrolls .body
    const main = $('[data-pl-main]');
    const sc = main.scrollHeight > main.clientHeight + 1 ? main : $('.body');
    const max = sc.scrollHeight - sc.clientHeight;
    const frac = max > 0 ? sc.scrollTop / max : 1;
    const lis = $$('.path li');
    const cur = Math.min(lis.length - 1, Math.floor(frac * lis.length));
    lis.forEach((li, i) => li.setAttribute('data-state', i < cur ? 'done' : i === cur ? 'current' : 'todo'));
    S.host.setAttribute('data-pl-progress', String(Math.round(frac * 100)));
    // endless feeds: near the bottom, ask the hidden page for more
    if (S.model && S.model.kind === 'feed' && max - sc.scrollTop < LOAD_MORE_PX) needMore(false);
  }

  function nearEnd() {
    const main = $('[data-pl-main]');
    const sc = main.scrollHeight > main.clientHeight + 1 ? main : $('.body');
    return sc.scrollHeight - sc.clientHeight - sc.scrollTop < LOAD_MORE_PX;
  }

  function needMore(force) {
    if (!S.opts || typeof S.opts.onNeedMore !== 'function') return;
    const now = Date.now();
    clearTimeout(S.moreTimer);
    if (!force && now - S.lastMore < LOAD_MORE_THROTTLE_MS) {
      // deferred, not dropped: at the very bottom no further scroll events arrive
      S.moreTimer = setTimeout(() => { if (S.host && nearEnd()) needMore(false); }, LOAD_MORE_THROTTLE_MS - (now - S.lastMore));
      return;
    }
    S.lastMore = now;
    S.host.setAttribute('data-pl-loading', 'true');
    const st = $('[data-pl-more-status]');
    if (st) st.textContent = 'Loading more...';
    S.opts.onNeedMore();
  }

  function filter(q) {
    q = q.trim().toLowerCase();
    let matches = 0;
    for (const card of $$('[data-pl-section]')) {
      const headHit = q && card.querySelector('.sec-h').textContent.toLowerCase().includes(q);
      let visible = 0;
      for (const item of card.querySelectorAll('[data-pl-item]')) {
        const hit = !q || headHit || item.textContent.toLowerCase().includes(q);
        item.setAttribute('data-pl-hidden', String(!hit));
        if (hit) { visible++; if (q) matches++; }
      }
      card.setAttribute('data-pl-hidden', String(visible === 0 && !headHit && !!q));
    }
    S.host.setAttribute('data-pl-matches', q ? String(matches) : '');
  }

  function openPreview(img) {
    const p = $('[data-pl-preview]');
    p.querySelector('img').src = img.src;
    p.querySelector('figcaption').textContent = img.getAttribute('data-alt') || '';
    p.hidden = false;
  }
  function closePreview() { const p = $('[data-pl-preview]'); if (p) p.hidden = true; }

  function moveSection(dir) {
    if (S.model && (S.model.kind === 'index' || (S.model.kind === 'feed' && !S.model.items.some((it) => it.focal)))) {
      const links = $$('tr[data-pl-item]:not([data-pl-hidden="true"]) a.lv-link');
      if (!links.length) return;
      const i = Math.max(0, Math.min(links.length - 1, links.indexOf(S.shadow.activeElement) + dir));
      links[i].focus({ preventScroll: true });
      links[i].closest('tr').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      return;
    }
    const cards = $$('[data-pl-section]:not([data-pl-hidden="true"])');
    if (!cards.length) return;
    const active = S.shadow.activeElement && S.shadow.activeElement.closest('[data-pl-section]');
    let i = cards.indexOf(active);
    i = Math.max(0, Math.min(cards.length - 1, i + dir));
    const btn = cards[i].querySelector('.sec-h');
    btn.focus({ preventScroll: true });
    cards[i].scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  function onKey(e) {
    if (!S.host) return;
    const path = e.composedPath();
    const typing = path.some((n) => n && (n.tagName === 'INPUT' || n.tagName === 'TEXTAREA'));
    // keep the page underneath from reacting to keys while disguised
    if (e.type === 'keydown') {
      if (e.key === 'Escape') {
        closePreview();
        const s = $('[data-pl-search]');
        if (typing) { s.value = ''; filter(''); s.blur(); $('[data-pl-main]').focus(); }
      } else if (!typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (e.key === '/') { e.preventDefault(); $('[data-pl-search]').focus(); }
        else if (e.key === 'j') moveSection(1);
        else if (e.key === 'k') moveSection(-1);
      }
    }
    e.stopImmediatePropagation();
  }

  function onClick(e) {
    const img = e.composedPath().find((n) => n && n.classList && n.classList.contains('thumb'));
    if (img) openPreview(img);
  }

  function announce(msg) { const l = S.shadow && $('[data-pl-live]'); if (l) l.textContent = msg; }

  // ─── Document disguise (title, favicon, scroll lock, media) ───
  function faviconHref() {
    const color = getComputedStyle(S.host).getPropertyValue('--pl-accent').trim() || 'currentColor';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="${color}"/><path d="M4 11V6m4 5V4m4 7V8" stroke="white" stroke-width="2" stroke-linecap="round"/></svg>`;
    return 'data:image/svg+xml,' + encodeURIComponent(svg);
  }

  function disguiseDocument() {
    const de = document.documentElement;
    S.saved = {
      title: document.title,
      overflow: de.style.getPropertyValue('overflow'),
      overflowPrio: de.style.getPropertyPriority('overflow'),
      icons: [...document.querySelectorAll('link[rel~="icon" i], link[rel="shortcut icon" i], link[rel="apple-touch-icon" i]')].map((l) => [l, l.getAttribute('rel')]),
    };
    de.style.setProperty('overflow', 'hidden', 'important');
    S.saved.icons.forEach(([l]) => l.setAttribute('rel', 'pl-disabled-icon'));
    const icon = document.createElement('link');
    icon.rel = 'icon'; icon.href = faviconHref(); icon.setAttribute('data-pro-look', '');
    (document.head || de).append(icon);
    document.title = S.fakeTitle;
    // pages that retitle themselves ("(3) Inbox") get overruled; their latest title is kept for restore
    S.titleObserver = new MutationObserver(() => {
      if (document.title !== S.fakeTitle) { S.saved.title = document.title; document.title = S.fakeTitle; }
    });
    S.titleObserver.observe(document.head || de, { subtree: true, childList: true, characterData: true });
    document.querySelectorAll('video, audio').forEach((m) => { try { m.pause(); } catch (e) { /* ignore */ } });
  }

  function restoreDocument() {
    if (!S.saved) return;
    S.titleObserver && S.titleObserver.disconnect();
    S.titleObserver = null;
    const de = document.documentElement;
    if (S.saved.overflow) de.style.setProperty('overflow', S.saved.overflow, S.saved.overflowPrio);
    else de.style.removeProperty('overflow');
    document.querySelectorAll('link[data-pro-look]').forEach((l) => l.remove());
    S.saved.icons.forEach(([l, rel]) => l.setAttribute('rel', rel));
    document.title = S.saved.title;
    S.saved = null;
  }

  // ─── Contract ───
  function publishContract() {
    const m = S.model;
    const a = (k, v) => S.host.setAttribute(k, String(v));
    a('data-pl-state', 'on');
    a('data-pl-version', VERSION);
    a('data-pl-extractor', m.extractor);
    a('data-pl-kind', m.kind || 'article');
    a('data-pl-items', $$('.lv-t tbody tr').length);
    a('data-pl-comments', $$('.tl-e[data-kind="email"] .post').length);
    a('data-pl-loading', 'false');
    a('data-pl-entries', $$('.tl-e').length);
    a('data-pl-related', $$('.chip').length);
    a('data-pl-sections', $$('[data-pl-section]').length);
    a('data-pl-fields', $$('.field').length - $$('.rail .field').length);
    a('data-pl-images', $$('img.thumb').length);
    a('data-pl-coverage', m.sourceChars ? (m.modelChars / m.sourceChars).toFixed(2) : 'n/a');
    a('data-pl-density', S.opts.density || 'comfy');
  }

  function applyStyles(shadow, cssText) {
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(cssText);
      shadow.adoptedStyleSheets = [sheet];
    } catch (e) {
      shadow.append(h('style', { text: cssText }));
    }
  }

  // ─── API ───
  function mount(model, opts) {
    if (S.host) return update(model);
    S.model = model; S.opts = opts || {};
    S.fakeTitle = titleFor(model);
    const host = document.createElement('div');
    host.id = HOST_ID;
    for (const [k, v] of Object.entries(HOST_LOCK)) host.style.setProperty(k, v, 'important');
    const shadow = host.attachShadow({ mode: 'open' });
    applyStyles(shadow, S.opts.cssText || '');
    if (S.opts.thumb) host.style.setProperty('--pl-thumb', S.opts.thumb + 'px');
    S.host = host; S.shadow = shadow;
    shadow.append(build(model));
    document.documentElement.append(host);
    disguiseDocument();
    publishContract();
    onScroll();
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKey, true);
    window.addEventListener('keypress', onKey, true);
    shadow.addEventListener('click', onClick);
    $('[data-pl-main]').focus({ preventScroll: true });
    announce('Workspace view on');
    return host;
  }

  function update(model) {
    if (!S.host) return null;
    const main = $('[data-pl-main]');
    const top = main ? main.scrollTop : 0;
    const q = ($('[data-pl-search]') || {}).value || '';
    S.model = model;
    S.fakeTitle = titleFor(model);
    document.title = S.fakeTitle;
    S.shadow.querySelector('.app').remove();
    S.shadow.append(build(model));
    $('[data-pl-main]').scrollTop = top;
    if (q) { $('[data-pl-search]').value = q; filter(q); }
    publishContract();
    onScroll();
    return S.host;
  }

  function unmount() {
    if (!S.host) return;
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('keyup', onKey, true);
    window.removeEventListener('keypress', onKey, true);
    clearTimeout(S.moreTimer);
    S.host.remove();
    restoreDocument();
    S.host = null; S.shadow = null; S.model = null;
  }

  const isMounted = () => !!S.host;
  // the page's own title while we show the fake one (the page may have retitled itself since)
  const realTitle = () => (S.saved ? S.saved.title : document.title);
  const isLoading = () => !!S.host && S.host.getAttribute('data-pl-loading') === 'true';

  // no new content arrived after a load-more request
  function idle() {
    if (!S.host || S.host.getAttribute('data-pl-loading') !== 'true') return;
    S.host.setAttribute('data-pl-loading', 'false');
    const st = $('[data-pl-more-status]');
    if (st) st.textContent = 'No more items right now.';
  }

  root.ProLookRender = { mount, update, unmount, isMounted, isLoading, idle, realTitle, VERSION, HOST_ID };
})(globalThis);
