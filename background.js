// Pro Look – service worker: toggle per tab, always-on sites, badge, settings delivery.

// ─── Constants ───
const DEFAULTS = { alwaysOn: [], density: 'comfy', thumb: 32 };
const CONTENT_FILES = ['content/Readability.js', 'content/extract.js', 'content/render.js', 'content/main.js'];
const MENU_ID = 'pl-always-on';
const BADGE_COLOR = '#1b5fb4'; // mirrors --pl-accent in content/skin.css
const INJECTABLE_RE = /^(https?|file):/;

// ─── State (persisted in storage.session so it survives worker restarts) ───
let cssText = null;

// ─── Helpers ───
async function getSettings() {
  const s = await chrome.storage.sync.get(DEFAULTS);
  return { ...DEFAULTS, ...s };
}

async function getCss() {
  if (cssText == null) cssText = await (await fetch(chrome.runtime.getURL('content/skin.css'))).text();
  return cssText;
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return ''; }
}

async function tabOverrides() {
  const { tabs = {} } = await chrome.storage.session.get('tabs');
  return tabs;
}

// explicit per-tab choice wins; otherwise the always-on list decides
async function effectiveOn(tabId, url) {
  const tabs = await tabOverrides();
  if (typeof tabs[tabId] === 'boolean') return tabs[tabId];
  const { alwaysOn } = await getSettings();
  return alwaysOn.includes(hostOf(url));
}

async function setTabOverride(tabId, on) {
  const tabs = await tabOverrides();
  tabs[tabId] = on;
  await chrome.storage.session.set({ tabs });
}

async function payload(on) {
  const s = await getSettings();
  return { type: 'pl:set', on, settings: { cssText: await getCss(), density: s.density, thumb: s.thumb } };
}

function setBadge(tabId, on) {
  chrome.action.setBadgeText({ tabId, text: on ? 'ON' : '' }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: BADGE_COLOR }).catch(() => {});
}

// ─── Toggle ───
async function toggleTab(tab) {
  if (!tab || !INJECTABLE_RE.test(tab.url || '')) {
    if (tab) {
      chrome.action.setBadgeText({ tabId: tab.id, text: '–' }).catch(() => {});
      chrome.action.setTitle({ tabId: tab.id, title: 'Pro Look cannot run on this page' }).catch(() => {});
    }
    return false;
  }
  const on = !(await effectiveOn(tab.id, tab.url));
  await setTabOverride(tab.id, on);
  const msg = await payload(on);
  try {
    await chrome.tabs.sendMessage(tab.id, msg);
  } catch (e) {
    // tab was open before install/reload: inject, then retry
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: CONTENT_FILES });
    await chrome.tabs.sendMessage(tab.id, msg);
  }
  return on;
}
globalThis.toggleTab = toggleTab; // used by tests/e2e.mjs

async function updateMenu(tab) {
  if (!tab || !tab.url) return;
  const host = hostOf(tab.url);
  const { alwaysOn } = await getSettings();
  chrome.contextMenus.update(MENU_ID, {
    title: host ? `Always disguise ${host}` : 'Always disguise this site',
    checked: alwaysOn.includes(host),
    enabled: !!host,
  }).catch(() => {});
}

// ─── Listeners ───
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: MENU_ID, title: 'Always disguise this site', type: 'checkbox', contexts: ['action'] });
});

chrome.action.onClicked.addListener((tab) => { toggleTab(tab); });

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'toggle-disguise') return;
  if (!tab) [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  toggleTab(tab);
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab) return;
  const host = hostOf(tab.url);
  const s = await getSettings();
  const set = new Set(s.alwaysOn);
  if (info.checked) set.add(host); else set.delete(host);
  await chrome.storage.sync.set({ alwaysOn: [...set].sort() });
  // follow the new site rule on this tab right away
  const tabs = await tabOverrides();
  delete tabs[tab.id];
  await chrome.storage.session.set({ tabs });
  chrome.tabs.sendMessage(tab.id, await payload(info.checked)).catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const tabId = sender.tab && sender.tab.id;
  if (msg.type === 'pl:hello' && tabId != null) {
    effectiveOn(tabId, msg.url).then(payload).then(reply);
    return true; // async reply
  }
  if (msg.type === 'pl:state' && tabId != null) setBadge(tabId, msg.on);
  if (msg.type === 'pl:toggle' && sender.tab) toggleTab(sender.tab);
  return false;
});

chrome.tabs.onActivated.addListener(({ tabId }) => chrome.tabs.get(tabId).then(updateMenu).catch(() => {}));
chrome.tabs.onUpdated.addListener((_id, info, tab) => { if (info.url && tab.active) updateMenu(tab); });
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const tabs = await tabOverrides();
  if (tabId in tabs) { delete tabs[tabId]; await chrome.storage.session.set({ tabs }); }
});
chrome.storage.onChanged.addListener((changes, area) => { if (area === 'sync') chrome.tabs.query({ active: true, currentWindow: true }).then(([t]) => updateMenu(t)); });
