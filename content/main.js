// Pro Look – content controller. Runs at document_start in every page.
// Asks the background whether this tab is disguised, hides the page early to avoid a flash,
// mounts once the DOM is parsed, and re-extracts on SPA navigation / late content.
(function () {
  'use strict';
  if (window.__proLook) return;
  window.__proLook = true;

  // ─── Constants ───
  const REEXTRACT_DEBOUNCE_MS = 1200;
  const REEXTRACT_MIN_GAP_MS = 3000;
  const TEXT_CHANGE_RATIO = 0.2;
  const HIDE_FAILSAFE_MS = 4000;
  const FEED_DEBOUNCE_MS = 400;
  const FEED_MIN_GAP_MS = 800;
  const MAX_FEED_ITEMS = 500;
  const MORE_RETRY_MS = 1200;
  const MORE_RETRIES = 4;

  // ─── State ───
  const state = {
    on: false, settings: null, lastUrl: location.href, lastLen: 0, lastSig: '', lastRun: 0, kind: '',
    timer: null, observer: null, hideTimer: null, moreTimer: null,
    feed: { url: '', order: [], map: new Map() }, // posts seen so far; X keeps only ~10 in the DOM
  };

  // ─── Helpers ───
  function hidePage() {
    document.documentElement.style.setProperty('visibility', 'hidden', 'important');
    clearTimeout(state.hideTimer);
    state.hideTimer = setTimeout(showPage, HIDE_FAILSAFE_MS); // never leave a blank tab if something throws
  }
  function showPage() {
    clearTimeout(state.hideTimer);
    document.documentElement.style.removeProperty('visibility');
  }

  const bodyTextLen = () => (document.body ? document.body.innerText.length : 0);

  // Feeds swap posts in and out without changing text length much; their permalinks tell us instead
  function postSig() {
    let sig = '';
    for (const t of document.querySelectorAll('article time, [role="article"] time')) {
      const a = t.closest('a[href]');
      if (a) sig += a.getAttribute('href') + '|';
    }
    return sig;
  }

  function mergeFeed(model) {
    const f = state.feed;
    if (model.kind !== 'feed' || f.url !== location.href) { f.url = location.href; f.order = []; f.map = new Map(); }
    if (model.kind !== 'feed') return model;
    for (const it of model.items) {
      if (!f.map.has(it.href)) f.order.push(it.href);
      f.map.set(it.href, it);
    }
    if (f.order.length > MAX_FEED_ITEMS) f.order.splice(0, f.order.length - MAX_FEED_ITEMS);
    model.items = f.order.map((href) => f.map.get(href));
    return model;
  }

  function extractNow() {
    const model = mergeFeed(ProLookExtract.extract(document, { Readability: window.Readability, url: location.href, title: ProLookRender.realTitle() }));
    state.kind = model.kind;
    state.lastLen = bodyTextLen();
    state.lastSig = postSig();
    state.lastUrl = location.href;
    state.lastRun = Date.now();
    return model;
  }

  // The overlay asked for more: scroll the hidden page until its infinite loader delivers new posts
  function loadMore(attempt = 0) {
    window.scrollBy(0, Math.max(window.innerHeight * 2, 1500));
    schedule();
    clearTimeout(state.moreTimer);
    state.moreTimer = setTimeout(() => {
      if (!ProLookRender.isLoading()) return; // an update arrived
      if (attempt < MORE_RETRIES) loadMore(attempt + 1);
      else ProLookRender.idle();
    }, MORE_RETRY_MS);
  }

  function whenReady(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn, { once: true });
    else fn();
  }

  function report() {
    chrome.runtime.sendMessage({ type: 'pl:state', on: ProLookRender.isMounted() }).catch(() => {});
  }

  // ─── Mount / unmount ───
  function mount() {
    try {
      ProLookRender.mount(extractNow(), { ...state.settings, onNeedMore: loadMore });
      watch();
    } catch (e) {
      console.warn('[pro-look] mount failed', e);
    } finally {
      showPage();
      report();
    }
  }

  function unmount() {
    stopWatch();
    ProLookRender.unmount();
    showPage();
    report();
  }

  function reextract() {
    if (!state.on || !ProLookRender.isMounted()) return;
    const len = bodyTextLen();
    const urlChanged = location.href !== state.lastUrl;
    const grew = Math.abs(len - state.lastLen) / Math.max(state.lastLen, 1) > TEXT_CHANGE_RATIO;
    const posts = postSig() !== state.lastSig;
    if (!urlChanged && !grew && !posts) return;
    const gap = state.kind === 'feed' || posts ? FEED_MIN_GAP_MS : REEXTRACT_MIN_GAP_MS;
    if (Date.now() - state.lastRun < gap) { schedule(); return; }
    try {
      ProLookRender.update(extractNow());
    } catch (e) { console.warn('[pro-look] re-extract failed', e); }
  }

  function schedule() {
    clearTimeout(state.timer);
    state.timer = setTimeout(reextract, state.kind === 'feed' ? FEED_DEBOUNCE_MS : REEXTRACT_DEBOUNCE_MS);
  }

  function watch() {
    if (state.observer || !document.body) return;
    // our overlay lives on <html>, outside <body>, so it never triggers this observer
    state.observer = new MutationObserver(schedule);
    state.observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    window.addEventListener('popstate', schedule);
    window.addEventListener('hashchange', schedule);
    window.addEventListener('load', schedule, { once: true });
  }

  function stopWatch() {
    clearTimeout(state.timer);
    clearTimeout(state.moreTimer);
    if (state.observer) state.observer.disconnect();
    state.observer = null;
    window.removeEventListener('popstate', schedule);
    window.removeEventListener('hashchange', schedule);
  }

  function apply(msg) {
    state.settings = msg.settings || state.settings;
    if (msg.on === state.on && (msg.on === ProLookRender.isMounted() || document.readyState === 'loading')) return;
    state.on = msg.on;
    if (state.on) {
      if (document.readyState === 'loading') hidePage();
      whenReady(mount);
    } else unmount();
  }

  // Ctrl+Shift+X fallback: when Chrome has not bound the command (unpacked installs, conflicts),
  // the key reaches the page and we toggle from here. When Chrome owns it, the page never sees it.
  function onHotkey(e) {
    if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && e.code === 'KeyX' && !e.repeat) {
      e.preventDefault();
      e.stopImmediatePropagation();
      chrome.runtime.sendMessage({ type: 'pl:toggle' }).catch(() => {});
    }
  }

  // ─── Listeners ───
  window.addEventListener('keydown', onHotkey, true);
  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg && msg.type === 'pl:set') { apply(msg); reply({ ok: true }); }
    else if (msg && msg.type === 'pl:ping') reply({ ok: true, on: ProLookRender.isMounted() });
  });

  // ─── Init ───
  if (window.top !== window) return;
  chrome.runtime.sendMessage({ type: 'pl:hello', url: location.href })
    .then((res) => { if (res) apply(res); })
    .catch(() => {});
})();
