# Multi-login extension: build tasks

## Phase A: set up
- [x] A1. Create folder and move into it
- [x] A2. Write `TASKS.md`
- [x] A3. `package.json` + `.gitignore`
- [x] A4. Minimal `manifest.json`, check it loads in Chromium via `playwright-core` (Brave: LOAD OK via `node test/load-check.mjs`; branded Chrome 157 ignores `--load-extension`, so tests default to Brave)

## Phase B: test the risky assumptions
- [x] B1. `test/echo-server.mjs`
- [x] B2. Bare `background.js` (DNR rule removing `set-cookie`, log what `webRequest` sees)
- [x] B3. `test/spike.mjs`: is the removed `Set-Cookie` still visible? RESULT: YES, in Brave. 8/8 checks passed (per-tab cookie override works, `webRequest` still sees the removed `Set-Cookie`, real cookie store stays empty for profile tabs, untouched tab keeps normal cookies). Per-tab isolation design is confirmed, no swap fallback needed.
- [x] B4. Sync profile-id lookup at `document_start`. RESULT: works, but with a simpler mechanism than planned: the per-tab DNR rule appends `Server-Timing: mlx;desc="<profile>"` to page responses and the MAIN-world content script reads `performance.getEntriesByType('navigation')[0].serverTiming` synchronously. 12/12 spike checks pass (main frame, iframe, and null for tabs without a profile). The planned DNR-redirect-to-`profiles/<n>.json` trick is not needed.

## Phase C: cookie jar (pure functions, test first)
- [x] C1. `test/cookie-jar.test.mjs` parsing cases (written first, confirmed red)
- [x] C2. `lib/cookie-jar.js` `parseSetCookie()`
- [x] C3. `applySetCookie()` tests + code (+ `purgeExpired`)
- [x] C4. `cookieHeaderFor(url)` tests + code
- [x] C5. `test/rules.test.mjs` + `lib/rules.js` `buildRules()`. `npm test`: 42/42 pass. The 140-URL equivalence test (simulated DNR vs `cookieHeaderFor`) caught a real bug: scope intersections must be computed to a fixpoint, not one round, because host, path and Secure narrow independently.

## Phase D: background service worker
- [x] D1. Profile store (`lib/engine.js`, unit-tested)
- [x] D2. Tab-to-profile map (`storage.session`) (`lib/engine.js`, unit-tested)
- [x] D3. Sync DNR rules (`updateSessionRules`) (`lib/engine.js`, unit-tested with a fake DNR)
- [x] D4. `Set-Cookie` capture via `webRequest` in the real `background.js`. Verified in Brave: profile tabs log in as different users on one site, rotated cookie is captured and sent back, real cookie store holds only the no-profile tab's login.
- [x] D5. Tab inheritance. Uses `webNavigation.onCreatedNavigationTarget.sourceTabId`, NOT `tabs.onCreated.openerTabId`: Chrome can report the active tab as opener when the real opener is in the background, which gave children no profile or the wrong one. Verified 6/6 inherited, 0 leaks, on 3 consecutive runs. The race window is real but narrow: rules finish installing ~10 to 30 ms before the child's first request. Speedups in `lib/engine.js`: install DNR rules before storage writes, and remember installed rule ids instead of reading them first.
- [x] D6. Tab groups + badge. Verified: group titled `User 1`, color blue, badge `1`.
- [x] D7. `test/spike.mjs` rewritten against the real extension (10 checks: D4, D5, D6, D2). 10/10 pass, 3 runs in a row. `test/diag-inherit.mjs` is the event-order diagnostic used for D5.

## Phase E: page storage shim
- [x] E1. Prefixed `localStorage` (`content/shim-main.js`: Proxy plus patched `Storage.prototype`, storage-event filtering). `sessionStorage` is deliberately NOT wrapped: browsers already keep it separate per tab.
- [x] E2. Prefixed `indexedDB` (`open`, `deleteDatabase`, `databases()`, `IDBDatabase.name`).
- [x] E3. `document.cookie` per profile. Design: the DNR rules also append `Server-Timing: mlxc;dur=<rank>;desc="<cookies>"` to page responses (JavaScript-visible cookies only, tested in `rules.test.mjs`), the shim reads it synchronously at `document_start` into a mirror; JS writes go page -> `content/bridge.js` -> background -> jar; later changes (Set-Cookie on fetch responses, other tabs) are pushed by the background via `engine.onJarChange` -> `tabs.sendMessage` -> bridge -> page.
- [x] E4. Content scripts registered in the manifest: `shim-main.js` (MAIN world) and `bridge.js` (isolated). Both do nothing unless the page response carries the `mlx` Server-Timing entry, so tabs without a profile are untouched (checked: native APIs unpatched).
- [x] E5. `test/shim-spike.mjs`: 23/23 pass, 3 runs in a row. Covers localStorage (isolation, reload, keys/length/key/JSON/named access/delete/instanceof, clear, storage events across profiles), IndexedDB (isolation, name, databases(), delete), document.cookie (first-script snapshot, httpOnly hidden, push after fetch, sync write, send with requests, delete, blocked HttpOnly write, real cookie store stays clean), and untouched native APIs in a normal tab. `npm run spike` runs both browser suites.

## Phase F: popup
- [x] F1. `popup.html` / `popup.css` / `popup.js`: profile list, current-tab status, address box. Checked by screenshot in light and dark (legible, active profile highlighted, swatch selection visible). `lib/colors.js` shares the palette between popup, badge and engine.
- [x] F2. Use in this tab (assigns + reloads), New tab (opens `about:blank`, assigns, then navigates: race-free), Open in all profiles, Remove from this tab, bad-address error. Admin messages are accepted only from pages of this extension (checked by sender origin).
- [x] F3. Add profile ("User N"), rename, recolor (updates tab group + badge), Clear cookies for the current site, Clear all cookies, Delete profile (two-click arming, frees its tabs). `test/popup-spike.mjs`: 15/15, 5 consecutive runs after fixing a test-side race. One earlier full-suite run had a single failure in "Remove from this tab": the test read the popup text before it re-rendered; it never recurred after waiting for the text, but the cause was inferred from the test code, not reproduced.

## Phase G: finish
- [x] G1. `README.md` (install via Load unpacked, usage, how it works, permissions, known limits, development). Removed the unused `scripting` permission.
- [x] G2. Final run (Brave): `npm test` 78/78; `npm run spike`: `spike.mjs` 10/10, `shim-spike.mjs` 23/23, `popup-spike.mjs` 15/15, `resilience-spike.mjs` 14/14. (First G2 run was 71 unit tests and three suites, before the hardening below.)

## Phase H: hardening after review (advisor findings)
- [x] H1. Cross-tab behaviour of the app used for testing: grep of its web frontend for `BroadcastChannel`, `storage` listeners, `navigator.serviceWorker`: no matches. So logging out one profile should not log out the others, and the app's own requests are not made from a service worker. (Searched `apps/web` only, not `apps/api` or packages.)
- [x] H2. Rule budget. Real limits read from Brave: 1000 regex rules, 5000 session rules. Fixed to fail closed: cookies get an `updated` stamp, `touchPage` refreshes it on each main-frame navigation, `engine.syncRules` evicts the least recently updated cookies (10% per round) until under the limit (limit minus 20), and if the browser still refuses the rules it installs base rules only. Warning shown in the popup with Dismiss. Tested: 7 new unit tests (fake browser) plus `resilience-spike.mjs` (600-host flood: 901/1000 regex rules, login of the site in use survives, new profile tab still isolated, real browser refusal `Session rule count for regex rules exceeded.` leaves 4 base rules and tabs send/store nothing).
- [x] H3. Stale tab groups after extension reload / browser restart. Reproduced (a tab still in its "User 2" group sent the REAL cookie after state loss). Fixed with `reconcileTabs` (on `onStartup` and `onInstalled`): tabs in a group whose title and color match a profile are re-attached and reloaded, reusing the group; other groups untouched. Tested through `mlx.simulateRestart({clearSession:true})`. The real `chrome.runtime.reload()` and the real `onInstalled`/`onStartup` firing are NOT tested (an extension loaded with `--load-extension` does not come back from `runtime.reload()`).
- [x] H4. Worker idle and wake. NOT tested for real: Playwright keeps the worker attached, so Brave never stops it (tried `ServiceWorker.stopAllWorkers` from page and extension-page sessions, and closing the target over the debugging port). Tested instead by `mlx.simulateRestart()` (engine rebuilt from storage, as a woken worker does): tab keeps profile and login, and a cookie rotated after the restart is captured and sent back. Real idle is on the manual list.
- [x] H5. README: SameSite/Partitioned ignored, rule budget, rebuild cost (~60 ms per cookie at ~450 scopes, measured in the flood test), reload/restart behaviour.
- [x] G3. Manual checks handed to the user (see below). NOT done by me: they need a person in the real Brave window.

### Manual checks for you (all untested by me)
1. Load unpacked in Brave (`brave://extensions`, Developer mode, Load unpacked, this folder). Confirm no errors on the extension card.
2. Start your app locally. Open it (for example `http://localhost:3100`), click the toolbar icon, **Open in all profiles**, log in as a different user in each tab, reload all tabs: each must keep its own user.
3. Log out in one tab: the others must stay logged in.
4. A normal tab without a profile on the same site must keep your usual login.
5. Press the toolbar icon on an ordinary tab and use **Use in this tab** from the real popup (my tests drove the popup as a tab with `?tabId=`, so the real toolbar popup's "active tab" lookup is untested).
6. Repeat on one external site you care about (a site using Google sign-in, a service worker, or a CSRF cookie is the interesting case).
7. Click a `target=_blank` link and the right-click "open link in new tab" menu inside a profile tab: the new tab should keep the profile (only `window.open` is tested).
8. Real worker idle: log in as two users in profile tabs, then leave the app idle for longer than its access-token lifetime (and more than a minute, so Brave stops the worker). Use the app again: both tabs must still be logged in (this is the refresh-cookie rotation after a worker wake-up; I could only simulate it).
9. Real extension reload: in `brave://extensions` click the reload icon on the extension while profile tabs are open. Each profile tab should be re-attached (same tab group, badge back) and reload itself, then still be logged in as its user. If a tab is left in a group but does not reload, tell me.
10. Browser restart with "continue where you left off": profile tabs come back grouped; they should re-attach and reload within a second or two. Not tested at all.

## Results log
- Known flakiness: the browser suites (mainly `popup-spike.mjs`, once `resilience-spike.mjs`) failed intermittently in roughly 3 of 14 runs while preparing the repo: one "rename and recolor" check timed out, two runs ended with "Target page, context or browser has been closed". Each passed on rerun with no code change. Cause not found; a full `npm run spike` was green afterwards.
- FINAL: `npm test` 78/78; `npm run spike` in Brave 10/10 + 23/23 + 15/15 + 14/14 (see G2 and Phase H).
- After Phase E: `npm test` 70/70 pass (cookie-jar 28, rules 18, engine 24). `npm run spike` in Brave: `spike.mjs` 10/10 and `shim-spike.mjs` 23/23.
- Bug found by the browser test in E: the shim's `document.cookie` attribute parser reused the `name=value` splitter, so `HttpOnly` / `Secure` flags (no `=`) were never recognised. Fixed.
- `background.js` handles `get-document-cookie` / `set-document-cookie` from content scripts. It does not yet handle popup messages; that comes with Phase F. It exposes `globalThis.mlx = { engine, ready, assign }` for the tests.
- Shim limits to put in the README (none of these are tested, they are known gaps): `about:blank` / `srcdoc` / `blob:` iframes and Web Workers are not shimmed (their IndexedDB / storage use is unprefixed); Cache Storage, BroadcastChannel, service workers and the async `cookieStore` API are shared across profiles on one origin; a `localStorage.clear()` in one profile sends a `storage` event with `key: null` that reaches every tab of the origin (it cannot be attributed to a profile); a normal tab sees the `__mlx_<profile>__` keys in its own localStorage.
- The shim and bridge are unit-test-free: only the browser suite covers them.
- Brave is the test browser (`BROWSER=brave` default); branded Chrome 157 ignores `--load-extension`.
- Known limit to document in the README: a tab you open by hand (Ctrl+T, typing a URL) has no profile until you assign one from the popup. Only `window.open` is tested for inheritance; `<a target=_blank>` clicks and the right-click "open link in new tab" menu should fire the same event but are UNTESTED.
