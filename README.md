# Multi Login Tabs

A Chromium extension (Brave, Chrome, Edge) that lets you stay logged in as **several users at once, in normal tabs of one window, on any site**. No incognito windows, no second browser, no changes to the app you are testing.

Each tab can be assigned a **profile** (User 1, User 2, ...). A profile has its own cookies, `localStorage`, IndexedDB and `document.cookie` for every site. A tab with no profile behaves exactly as before and keeps using your normal login.

> **Use test accounts only.** Profile cookies are kept unencrypted in the extension's own storage (`chrome.storage.local`).

## Install (no publishing needed)

0. Get the code: `git clone` this repository (or download the zip and unzip it).
1. Open `brave://extensions` (or `chrome://extensions`).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and choose the folder you cloned (the one containing `manifest.json`).
4. Pin the extension from the puzzle-piece menu so the popup is one click away.

After editing any file here, click the reload icon on the extension card.

## Use

Click the toolbar icon.

| You want to | Do this |
|---|---|
| Put the current tab on a profile | **Use in this tab**. The tab reloads (it was loaded with your normal session). |
| Open a site as a profile in a new tab | Type the address, then **New tab** on that profile. |
| Open the same site once per profile | **Open in all profiles**. |
| Go back to your normal login | **Remove from this tab**. |
| Rename or recolor a profile | **Edit**, then **Save**. The tab group and toolbar badge update. |
| Log a profile out of one site | **Edit**, then **Clear cookies for <site>**. |
| Add or remove a profile | **Add profile** / **Edit**, then **Delete profile** (two clicks). |

Profile tabs show a colored tab group named after the profile and a number badge on the toolbar icon. A tab opened from a profile tab (a link or `window.open`) inherits that profile.

Typical flow for testing your app as three users: open the login page, click **Open in all profiles**, sign in as a different user in each tab. Reloading keeps each tab's login.

## How it works

- **Cookies on the wire.** A `declarativeNetRequest` session rule per profile, limited to that profile's tab ids, replaces the browser's `Cookie` header with the profile's own cookies and strips `Set-Cookie` from responses so nothing reaches your real cookie store. A non-blocking `webRequest` listener still sees the original `Set-Cookie` and records it in the profile's jar, so rotating refresh tokens keep working. (`lib/cookie-jar.js`, `lib/rules.js`, `lib/engine.js`)
- **Page storage.** The same rules append a `Server-Timing` entry to page responses carrying the profile id and the JavaScript-visible cookies. A content script reads it synchronously before any site script runs and then prefixes `localStorage` keys and IndexedDB names per profile and answers `document.cookie` from the profile's jar. (`content/shim-main.js`, `content/bridge.js`)
- **Tabs.** The tab-to-profile map lives in `chrome.storage.session`. Tabs opened by a profile tab are assigned through `webNavigation.onCreatedNavigationTarget`.
- Tabs without a profile are never touched: the content scripts exit immediately.

## Permissions, and why

`<all_urls>` host access is required because the point is to work on any site. `declarativeNetRequest` rewrites cookie headers, `webRequest` reads `Set-Cookie`, `webNavigation` finds the opener of new tabs, `tabGroups` colors and names the tab groups, `storage` keeps profiles and jars. The `tabs` permission is not requested: host access already lets the extension read the address of tabs, and assigning or grouping tabs does not need it. The header rules apply only to tabs assigned to a profile. The `webRequest` listener and the content scripts are loaded for every page, but they ignore and store nothing for tabs without a profile. No data leaves your machine; the extension makes no network requests of its own.

## Known limits

Tested in Brave only. Things that are **known gaps** (not bugs to be found by luck):

- A tab you open by hand (Ctrl+T, typing an address) has no profile until you assign one from the popup.
- A tab opened by a profile tab gets its profile within a few milliseconds. In testing the rules were always in place before the first request (18 of 18), but that is a race, not a guarantee.
- Requests made by a service worker have no tab, so they are not isolated. A site that calls its API from a service worker may mix sessions; unregister its service worker (DevTools, Application) when testing.
- `about:blank` / `srcdoc` / `blob:` iframes and Web Workers are not shimmed, so storage they use is shared.
- Cache Storage, BroadcastChannel and the async `cookieStore` API are shared across profiles on one origin.
- A `localStorage.clear()` in one profile sends a `storage` event with `key: null` that reaches every tab of the origin.
- A normal (no-profile) tab can see the `__mlx_<profile>__` keys in its own `localStorage`.
- Cookies are matched by host and path only. `SameSite` and `Partitioned` are ignored, so profile tabs send cookies on cross-site requests where a browser would not. The public-suffix list is not consulted either, so a cookie with `Domain=com` would be accepted.
- **Rule budget.** The browser allows 1000 regex rules per extension and each cookie scope costs one or two, shared by all profiles. When the limit is reached the least recently used cookies are removed (sites you navigate to count as recently used) and the popup shows a warning. If the browser still refuses the rules, profile tabs fall back to sending **no** cookies (never your real ones) until you clear some data. Both paths are tested, including the real browser refusing the rules.
- Every cookie change rebuilds all rules. At several hundred scopes this took about 60 ms per cookie in testing, so very large jars make rotating cookies slightly slower to take effect.
- **Extension reload and browser restart.** Tab assignments and installed rules do not survive either, but the tab groups do. On startup and on reload the extension re-attaches every tab whose group has a profile's exact name and color, and reloads it. Before that happens, a restored tab may load once with your normal session; nothing from a profile's jar is exposed during that window. Renaming a group in the browser stops it from matching, so then assign the tab again from the popup.
- Sites with bot detection may notice header rewriting. Use this on your own apps.

## Development

```
npm test            # unit tests (Node, no dependencies): cookie jar, rule builder, engine
npm run spike       # browser tests in Brave: cookies/tabs, page storage, popup UI, failure modes
```

Not automatable here, so only simulated: the real `chrome.runtime.reload()` (an extension loaded with `--load-extension` does not come back) and the real 30-second idle shutdown of the service worker (Playwright keeps the worker attached). `mlx.simulateRestart()` in `background.js` rebuilds the engine from storage exactly as a freshly started worker does, and is what those tests use. `test/limits-probe.mjs` and `test/restart-probe.mjs` are the exploratory scripts that established this.

Run `npm install` once (it installs `playwright-core`, the only dev dependency). The browser tests load the extension into Brave with Playwright, expected at its default Windows install path (set `BROWSER_PATH` to the browser executable otherwise), and run against a local test server (`test/echo-server.mjs`). Branded Chrome 157 ignores `--load-extension`, so tests default to Brave; set `BROWSER=edge` or `BROWSER=chrome` to try the others.

### Store package

```
npm run package     # build dist/ (test hook removed), smoke-test it in Brave, write multi-login-tabs-<version>.zip
node scripts/make-icons.mjs        # re-render icons/ from store/icon-source.svg
node scripts/make-screenshots.mjs  # re-make store/screenshot-1.png
```

The zip contains only the runtime files. `scripts/build.mjs` removes the `globalThis.mlx` test hook between the `@test-hook` markers in `background.js` and fails if the markers are missing. Listing text and permission justifications are in `store/listing.md`; the privacy policy is `PRIVACY.md`. The version in `manifest.json` must be raised for every store upload.

Layout: `background.js` wires Chrome events to `lib/engine.js`; `lib/` holds the pure logic; `content/` the page scripts; `popup.*` the UI; `test/` all tests; `TASKS.md` the build log and results.
