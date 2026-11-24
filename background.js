// Service worker: wires Chrome events to the engine (lib/engine.js). All listeners are registered at top level,
// as MV3 requires, so a sleeping worker is woken by the event; `ready` resolves once state is reloaded.
import { COLOR_HEX } from './lib/colors.js';
import { createEngine } from './lib/engine.js';

// When a profile's cookies change, tell its open tabs so their document.cookie view stays current.
function notifyProfileTabs(profileId) {
  for (const tabId of engine.tabIdsOfProfile(profileId)) {
    chrome.tabs.sendMessage(tabId, { type: 'cookies-changed' }).catch(() => {}); // no receiver: not a web page
  }
}

// Leave a margin below the browser's regex-rule limit (1000 in Brave and Chrome).
const makeEngine = (overrides = {}) =>
  createEngine({
    local: chrome.storage.local,
    session: chrome.storage.session,
    dnr: chrome.declarativeNetRequest,
    onJarChange: notifyProfileTabs,
    maxRegexRules: chrome.declarativeNetRequest.MAX_NUMBER_OF_REGEX_RULES - 20,
    ...overrides,
  });

let engine = makeEngine();
let ready = engine.init();

const profileInfo = async (id) => (await engine.listProfiles()).find((p) => p.id === id) ?? null;

// ---- visuals: toolbar badge + color-coded tab group -------------------------------------------------------
async function showBadge(tabId, profile) {
  try {
    await chrome.action.setBadgeText({ tabId, text: profile ? String(profile.number) : '' });
    if (profile) await chrome.action.setBadgeBackgroundColor({ tabId, color: COLOR_HEX[profile.color] ?? COLOR_HEX.grey });
  } catch {
    // the tab closed in the meantime
  }
}

async function groupTab(tabId, profile) {
  const tab = await chrome.tabs.get(tabId);
  const key = `${tab.windowId}:${profile.id}`;
  const { groups = {} } = await chrome.storage.session.get('groups');
  const style = { title: profile.name, color: profile.color };

  if (groups[key] !== undefined) {
    try {
      await chrome.tabs.group({ tabIds: [tabId], groupId: groups[key] });
      await chrome.tabGroups.update(groups[key], style);
      return;
    } catch {
      // the group was closed since; make a new one below
    }
  }
  const groupId = await chrome.tabs.group({ tabIds: [tabId], createProperties: { windowId: tab.windowId } });
  await chrome.tabGroups.update(groupId, style);
  groups[key] = groupId;
  await chrome.storage.session.set({ groups });
}

async function ungroupTab(tabId) {
  try {
    await chrome.tabs.ungroup(tabId);
  } catch {
    // not grouped, or the tab closed
  }
}

// ---- public actions (also used by the popup in Phase F) ---------------------------------------------------
// Rules are installed first, so the tab is isolated before any visual work happens.
async function assign(tabId, profileId) {
  await ready;
  await engine.assignTab(tabId, profileId);
  const profile = profileId ? await profileInfo(profileId) : null;
  await showBadge(tabId, profile);
  if (profile) await groupTab(tabId, profile);
  else await ungroupTab(tabId);
}

// A new tab for a profile. It starts on about:blank so the rules are in place before the first real request;
// navigating afterwards is race-free (unlike tabs opened by a page, see D5).
async function openAs(profileId, url, { active = true } = {}) {
  const parsed = new URL(url); // throws on garbage
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('Only http and https addresses can be opened');
  const tab = await chrome.tabs.create({ url: 'about:blank', active });
  await assign(tab.id, profileId);
  await chrome.tabs.update(tab.id, { url: parsed.href });
  return tab.id;
}

// After a rename or recolor: refresh the badge and group title of every tab of that profile.
async function refreshVisuals(profileId) {
  const profile = await profileInfo(profileId);
  for (const tabId of engine.tabIdsOfProfile(profileId)) {
    await showBadge(tabId, profile);
    try {
      await groupTab(tabId, profile);
    } catch {
      // the tab closed in the meantime
    }
  }
}

// After an extension reload or a browser restart the tab map and the installed rules are gone, but the tab groups
// stay. A tab then still looks like "User 2" while it sends your real cookies. Re-attach every tab that sits in a
// group matching a profile (same title and color) and reload it, so it loads under that profile again.
async function reconcileTabs() {
  await ready;
  const profiles = await engine.listProfiles();
  for (const group of await chrome.tabGroups.query({})) {
    const profile = profiles.find((p) => p.name === group.title && p.color === group.color);
    if (!profile) continue; // not ours: someone's own tab group
    const orphans = (await chrome.tabs.query({ groupId: group.id })).filter((tab) => !engine.profileOfTab(tab.id));
    if (!orphans.length) continue;
    const { groups = {} } = await chrome.storage.session.get('groups');
    groups[`${group.windowId}:${profile.id}`] = group.id; // keep using this group instead of creating a new one
    await chrome.storage.session.set({ groups });
    for (const tab of orphans) {
      await assign(tab.id, profile.id); // rules first
      await chrome.tabs.reload(tab.id);
    }
  }
}

const reconcileSafely = () => reconcileTabs().catch((error) => console.error('multi-login-ext: could not re-attach tabs', error));
chrome.runtime.onStartup.addListener(reconcileSafely);
chrome.runtime.onInstalled.addListener(reconcileSafely); // also fires when the extension is reloaded

// @test-hook:start (removed from the store build by scripts/build.mjs)
// Handle for the browser tests. simulateRestart rebuilds the engine from storage like a freshly woken worker;
// clearSession also forgets tab assignments and installed rules, like an extension reload does.
globalThis.mlx = {
  get engine() {
    return engine;
  },
  get ready() {
    return ready;
  },
  assign,
  reconcileTabs,
  async simulateRestart({ clearSession = false, ...engineOverrides } = {}) {
    await ready;
    if (clearSession) {
      await chrome.storage.session.clear();
      const rules = await chrome.declarativeNetRequest.getSessionRules();
      await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: rules.map((r) => r.id) });
    }
    engine = makeEngine(engineOverrides);
    ready = engine.init();
    await ready;
  },
};
// @test-hook:end

// ---- D4: capture Set-Cookie of profile tabs ---------------------------------------------------------------
// DNR strips Set-Cookie before the browser stores it; this non-blocking observer still sees the original header.
// A main-frame response also marks the cookies of that site as recently used (see engine.touchPage).
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0) return;
    const values = (details.responseHeaders ?? [])
      .filter((h) => h.name.toLowerCase() === 'set-cookie')
      .map((h) => h.value);
    const isPage = details.type === 'main_frame';
    if (!values.length && !isPage) return;
    ready
      .then(async () => {
        if (!engine.profileOfTab(details.tabId)) return;
        if (isPage) await engine.touchPage(details.tabId, details.url);
        if (values.length) await engine.captureSetCookies(details.tabId, details.url, values);
      })
      .catch((error) => console.error('multi-login-ext: could not record cookies', error));
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders', 'extraHeaders'],
);

// ---- D5: tabs opened from a profile tab inherit its profile -----------------------------------------------
// sourceTabId is the tab whose page opened the new one. tabs.onCreated's openerTabId is NOT used: Chrome can report
// the active tab there when the opener is in the background, which would give the child the wrong profile.
chrome.webNavigation.onCreatedNavigationTarget.addListener(async (details) => {
  await ready;
  const profileId = engine.profileOfTab(details.sourceTabId);
  if (profileId) await assign(details.tabId, profileId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  ready.then(() => engine.removeTab(tabId));
});

// ---- messages ---------------------------------------------------------------------------------------------
// Content scripts may only ask for their own document.cookie view. Everything that changes profiles comes from
// the popup, and is refused unless the sender is a page of this extension.
const contentHandlers = {
  'get-document-cookie': (message, sender) => engine.documentCookie(sender.tab?.id, message.url),
  'set-document-cookie': (message, sender) => engine.setDocumentCookie(sender.tab?.id, message.url, message.cookie),
};

const adminHandlers = {
  state: async ({ tabId }) => ({
    profiles: await engine.listProfiles(),
    tabProfileId: tabId === undefined ? null : engine.profileOfTab(tabId),
    warning: engine.warning(),
  }),
  'dismiss-warning': async () => {
    await engine.dismissWarning();
    return true;
  },
  // The page already loaded with the real session and without the shim, so a reload is needed after (un)assigning.
  assign: async ({ tabId, profileId }) => {
    await assign(tabId, profileId);
    await chrome.tabs.reload(tabId);
    return true;
  },
  'open-as': ({ profileId, url }) => openAs(profileId, url),
  'open-all': async ({ url }) => {
    new URL(url); // validate once before opening anything
    for (const profile of await engine.listProfiles()) await openAs(profile.id, url, { active: false });
    return true;
  },
  'create-profile': ({ name, color }) => engine.createProfile({ name, color }),
  'update-profile': async ({ id, name, color }) => {
    await engine.updateProfile(id, { name, color });
    await refreshVisuals(id);
    return true;
  },
  'delete-profile': async ({ id }) => {
    const tabIds = engine.tabIdsOfProfile(id);
    await engine.deleteProfile(id);
    for (const tabId of tabIds) {
      await showBadge(tabId, null);
      await ungroupTab(tabId);
    }
    return true;
  },
  'clear-profile': async ({ id, host }) => {
    await engine.clearProfile(id, host ? { host } : {});
    return true;
  },
};

// sender.origin is chrome-extension://<id> for our own pages and the web page's origin for content scripts.
const isExtensionPage = (sender) => sender.id === chrome.runtime.id && sender.origin === new URL(chrome.runtime.getURL('')).origin;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = (isExtensionPage(sender) ? adminHandlers[message?.type] : undefined) ?? contentHandlers[message?.type];
  if (!handler) return false;
  ready
    .then(() => handler(message, sender))
    .then(sendResponse, (error) => sendResponse({ error: error.message }));
  return true; // keep the channel open for the async response
});

// Keep the badge after navigations.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status !== 'loading') return;
  await ready;
  const profileId = engine.profileOfTab(tabId);
  if (profileId) await showBadge(tabId, await profileInfo(profileId));
});
