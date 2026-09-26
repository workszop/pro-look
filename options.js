// Pro Look – options page.

// ─── Constants ───
const DEFAULTS = { alwaysOn: [], density: 'comfy', thumb: 32 };

// ─── DOM refs ───
const alwaysOnEl = document.getElementById('alwaysOn');
const densityEl = document.getElementById('density');
const thumbEl = document.getElementById('thumb');
const thumbOutEl = document.getElementById('thumbOut');
const saveEl = document.getElementById('save');
const statusEl = document.getElementById('status');

// ─── Helpers ───
const parseHosts = (text) => [...new Set(text.split(/\s+/)
  .map((s) => s.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '').toLowerCase())
  .filter(Boolean))].sort();

// ─── Render ───
function render(s) {
  alwaysOnEl.value = s.alwaysOn.join('\n');
  densityEl.value = s.density;
  thumbEl.value = s.thumb;
  thumbOutEl.textContent = s.thumb;
}

// ─── Listeners ───
thumbEl.addEventListener('input', () => { thumbOutEl.textContent = thumbEl.value; });
saveEl.addEventListener('click', async () => {
  await chrome.storage.sync.set({ alwaysOn: parseHosts(alwaysOnEl.value), density: densityEl.value, thumb: Number(thumbEl.value) });
  render(await chrome.storage.sync.get(DEFAULTS));
  statusEl.textContent = 'Saved. Applies to pages disguised from now on.';
});
document.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); saveEl.click(); } });

// ─── Init ───
chrome.storage.sync.get(DEFAULTS).then(render);
