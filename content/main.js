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

  // ─── State ───
  const state = { on: false, settings: null, lastUrl: location.href, lastLen: 0, lastRun: 0, timer: null, observer: null, hideTimer: null };

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
      const model = ProLookExtract.extract(document, { Readability: window.Readability, url: location.href });
      ProLookRender.mount(model, state.settings);
      state.lastLen = bodyTextLen();
      state.lastUrl = location.href;
      state.lastRun = Date.now();
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
    if (!urlChanged && !grew) return;
    if (Date.now() - state.lastRun < REEXTRACT_MIN_GAP_MS) { schedule(); return; }
    state.lastLen = len; state.lastUrl = location.href; state.lastRun = Date.now();
    try {
      ProLookRender.update(ProLookExtract.extract(document, { Readability: window.Readability, url: location.href }));
    } catch (e) { console.warn('[pro-look] re-extract failed', e); }
  }

  function schedule() {
    clearTimeout(state.timer);
    state.timer = setTimeout(reextract, REEXTRACT_DEBOUNCE_MS);
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

  // Alt+Shift+X fallback: when Chrome has not bound the command (unpacked installs, conflicts),
  // the key reaches the page and we toggle from here. When Chrome owns it, the page never sees it.
  function onHotkey(e) {
    if (e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyX' && !e.repeat) {
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
