# Privacy Policy: Multi Login Tabs

Last updated: 2026-11-24

Multi Login Tabs is a browser extension that keeps separate login sessions ("profiles") in separate tabs. It works entirely on your device.

## What the extension stores

All of this stays in your browser, in the extension's own storage (`chrome.storage.local` and `chrome.storage.session`), and nowhere else:

- Your profiles: their names and colors.
- For each profile, the cookies that websites set while you use a tab assigned to that profile. This includes login/session cookies, including `HttpOnly` ones. These are stored **unencrypted** in the extension's storage.
- The last address you typed in the popup, so it can be pre-filled.
- Which open tabs are assigned to which profile (cleared when the browser closes).

Page data of a profile tab (`localStorage` and IndexedDB) is kept in the website's normal browser storage under a profile-specific prefix. It is not copied anywhere else.

## What the extension does not do

- It does not send any data to the developer or to any third party. It makes no network requests of its own.
- It has no analytics, tracking, advertising or remote code.
- It does not sell or share data.
- It does not change, store or act on anything in tabs that are not assigned to a profile. To work on any site, the extension's code is loaded for every page and receives response headers of every tab, but it ignores those of tabs without a profile and keeps nothing from them.

## Why it needs access to all websites

The extension is meant to work on any site you choose to test. In a tab you assign to a profile, it replaces the browser's cookies for that tab with the profile's own cookies and stops the profile's cookies from reaching your normal cookie store. Details are in the README.

## Your control

- Remove a profile's data at any time: popup, **Edit**, then **Clear cookies for this site**, **Clear all cookies**, or **Delete profile**.
- Uninstalling the extension removes everything it stored.
- Use test accounts only: because stored cookies are unencrypted, anyone with access to your browser profile on your computer could read them.

## Changes and contact

If this policy changes, the new version will be published at this address with a new date. Questions or issues: https://github.com/sushil026/multi-login-tabs/issues
