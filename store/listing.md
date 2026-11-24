# Chrome Web Store listing text

Paste these into the developer dashboard. Fields I could not verify against Google's current form are marked CHECK.

## Basics
- **Name:** Multi Login Tabs
- **Category:** Developer Tools (CHECK the category list)
- **Language:** English
- **Version:** 0.1.0 (must be higher on every update)
- **Homepage / support URL:** https://github.com/sushil026/multi-login-tabs (issues: https://github.com/sushil026/multi-login-tabs/issues)
- **Privacy policy URL:** https://github.com/sushil026/multi-login-tabs/blob/main/PRIVACY.md (only works after PRIVACY.md is pushed to `main`)

## Short description (summary, 117 characters; the store limit is 132)
Stay logged in as several users at once in normal tabs. One session per tab profile, no incognito, no second browser.

## Detailed description
Testing an app as more than one user usually means incognito windows or a second browser. Multi Login Tabs gives each tab its own login instead.

Put a tab on a profile (User 1, User 2, ...). Each profile has its own cookies, localStorage, IndexedDB and document.cookie for every site, so you can be signed in as three different users on the same site, side by side, in one window. A tab with no profile keeps using your normal login.

What you get
- Profiles with their own sessions for any website, not just one app.
- Color-coded tab groups and a toolbar badge that show which profile a tab uses.
- Tabs opened from a profile tab (links, window.open) keep that profile.
- "Open in all profiles" opens the same address once per profile.
- Rename, recolor, add or delete profiles, and clear a profile's cookies for one site or for everything.
- Rotating refresh tokens keep working.

Made for testing your own apps
- Use test accounts only. Profile cookies are stored unencrypted in the extension's own storage.
- Everything stays on your device. No accounts, no analytics, no network requests of its own.
- Known limits (for example service workers, and Cache Storage shared across profiles) are listed in the README on GitHub.

Source code: https://github.com/sushil026/multi-login-tabs

## Single purpose
Keep several separate website login sessions open at once, one per tab profile, in a single browser window.

## Permission justifications
- **declarativeNetRequest:** replaces the `Cookie` request header and removes `Set-Cookie` response headers for tabs assigned to a profile, so each profile has its own session. It is the core feature.
- **webRequest:** a read-only listener that reads `Set-Cookie` response headers of profile tabs so the profile's own cookie jar stays up to date (rotated tokens keep working). It does not block or modify requests.
- **webNavigation:** finds which tab opened a new tab, so tabs opened from a profile tab inherit that profile.
- **tabGroups:** shows each profile as a color-coded tab group named after the profile.
- **storage:** keeps profiles and their cookies on the device, and the tab-to-profile map for the current browser session.
- **Host access (`<all_urls>`):** the extension is meant to work on any site the user chooses to test. Header rules apply only to tabs the user assigns to a profile. The content scripts and the read-only `webRequest` listener are loaded for every page and receive response headers of every tab, but they ignore and store nothing for tabs without a profile.

(The `tabs` permission is deliberately not requested.)

## Remote code
No. All code is in the package; nothing is downloaded or evaluated at runtime.

## Data usage disclosure (CHECK the exact wording in the dashboard)
The extension handles website session cookies, which are authentication information, locally on the device. Declare authentication information as handled, and state in the form that it is not transmitted, sold or used for anything other than the extension's single purpose. Tick the three certifications only if they are true for this build (they are: no sale of data, no use unrelated to the single purpose, no creditworthiness use).

## Test instructions for the reviewer (if the form has a field for it)
1. Install the extension and open any site that has a login, for example the reviewer's own test account page.
2. Click the toolbar icon, then **Use in this tab** next to User 1. The tab reloads with a "User 1" tab group and a "1" badge.
3. Log in. Open the same site in a normal tab: it is not logged in as that user. Open it as User 2 with **New tab** to hold a second login.
No sign-in credentials are needed for the extension itself.
