# Pro Look

Chrome extension (Manifest V3, no build step) that re-renders any website as a generic CRM record page. Headings become field sections, short text becomes label/value fields, long paragraphs become notes, lists become related lists, tables become report grids and images shrink to 32 px attachment thumbnails. The real text stays readable up close; from a distance it looks like you are updating an opportunity.

## Install
1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select this folder.
3. Press **Alt+Shift+X** (or click the toolbar icon) on any page.

## What you see
- **Home pages, section fronts, blogs, link aggregators** open as an *All Opportunities* list view: every headline is a row (title link, summary, thumbnail, section as Account, time as Close Date). Click a row (or `j`/`k` + Enter) to open the article.
- **Articles and posts** open as an *Opportunity* record: real site, author and date in the header, the lead as Description, then every paragraph in reading order as an Activity timeline entry (Email / Call / Note / Meeting), lists as task lists, images as File entries, tables as report grids. Site navigation, tags and mega-menus move to a *Related Links* card at the end.

## Use
| Key | Action |
| --- | --- |
| Alt+Shift+X | Toggle disguise on the current tab (rebind at `chrome://extensions/shortcuts`) |
| / | Search / filter the record |
| j / k | Next / previous section (list view: next / previous row, Enter opens) |
| Esc | Close image preview, clear search |

- If Chrome did not register Alt+Shift+X (common for unpacked installs), the page itself catches the key, so it still works; to also make it work while focus is in the address bar, set it at `chrome://extensions/shortcuts`.
- The disguise follows you as you click links in the same tab.
- Right-click the toolbar icon → **Always disguise this site** to auto-disguise a host.
- Options page: always-on hosts, density, thumbnail size.
- Tab title becomes "Opportunity | Workspace", favicon is swapped, playing media is paused.

## Structure
- `background.js` – toggle state per tab (`storage.session`), always-on hosts (`storage.sync`), badge, settings + CSS delivery.
- `content/main.js` – asks the background at `document_start`, hides the page until mounted (no flash), re-extracts on SPA changes.
- `content/extract.js` – page → Model (Mozilla Readability, fallback DOM walker). Pure; unit-tested.
- `content/render.js` – Model → CRM UI in a Shadow DOM overlay; publishes the `data-pl-*` contract.
- `content/skin.css` – every color, font and size is a token on `:host`; reskin there.

## Tests
```bash
npm install
npm test           # extractor unit tests (jsdom, fixtures)
npm run e2e        # real Chromium + unpacked extension, reads the data-pl-* contract, writes shots/
```
`e2e` needs Chrome for Testing (branded Chrome ≥137 ignores `--load-extension`); set `CHROME_BIN` and `PW_MODULE` if yours are elsewhere.
