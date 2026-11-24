// Stateful core of the extension: profiles, tab assignments, cookie jars and DNR rule syncing.
// Browser APIs are injected (`local`/`session` = chrome.storage areas, `dnr` = chrome.declarativeNetRequest),
// so everything here is unit-tested in Node with in-memory fakes.
//
// Memory is authoritative while the service worker is alive; every change is written through to storage so a
// restarted worker reloads the same state. All mutations run one at a time (see `serialize`).
import { applySetCookie, cookieHeaderFor, domainMatches, parseSetCookie, purgeExpired, touchCookies } from './cookie-jar.js';
import { GROUP_COLORS } from './colors.js';
import { buildRules, countRegexRules } from './rules.js';

const DEFAULT_COLORS = ['blue', 'red', 'green', 'yellow'];
const jarKey = (id) => `jar:${id}`;

// onJarChange(profileId) is called after a profile's cookies changed and its rules are installed, so the caller can
// refresh what open tabs of that profile show in document.cookie.
// maxRegexRules: how many regex rules to use at most (the browser's limit minus a margin; see background.js).
export function createEngine({ local, session, dnr, now = Date.now, onJarChange = () => {}, maxRegexRules = 980 }) {
  let profiles = [];
  let nextNumber = 1;
  let jars = {};
  let tabs = {};
  let queue = Promise.resolve();
  let lastPushed = null;
  let warning = null; // shown in the popup: eviction or refused rules

  // One mutation at a time, so concurrent Set-Cookie responses cannot overwrite each other.
  const serialize = (task) => {
    const result = queue.then(task);
    queue = result.catch(() => {});
    return result;
  };

  const requireProfile = (id) => {
    const profile = profiles.find((p) => p.id === id);
    if (!profile) throw new Error(`unknown profile: ${id}`);
    return profile;
  };
  const tabIdsOf = (profileId) =>
    Object.entries(tabs)
      .filter(([, id]) => id === profileId)
      .map(([tabId]) => Number(tabId));

  const persistProfiles = () => local.set({ profiles: { list: profiles, nextNumber } });
  const persistJar = (id) => local.set({ [jarKey(id)]: jars[id] ?? [] });
  const persistTabs = () => session.set({ tabs });

  // Speed matters here: a tab opened from a profile tab sends its first request ~30 ms after it is created, so the
  // rules must be installed before anything else (storage writes come after). The ids of the rules we installed are
  // remembered, so a sync is a single browser call instead of read-then-write.
  let pushedIds = null;

  const currentRules = ({ withoutCookies = false } = {}) =>
    buildRules(
      profiles.map((p) => ({ id: p.id, jar: withoutCookies ? [] : (jars[p.id] ?? []), tabIds: tabIdsOf(p.id) })),
      now(),
    );

  async function pushRules(rules) {
    if (pushedIds === null) pushedIds = (await dnr.getSessionRules()).map((r) => r.id);
    try {
      await dnr.updateSessionRules({ removeRuleIds: pushedIds, addRules: rules });
    } catch (err) {
      pushedIds = null; // unknown state: re-read next time
      throw err;
    }
    pushedIds = rules.map((r) => r.id);
    lastPushed = JSON.stringify(rules);
  }

  const setWarning = async (text) => {
    warning = text;
    await session.set({ warning });
  };

  // The browser caps regex rules (see countRegexRules). Drop the least recently used cookies, 10% per round, until the
  // rules fit. Cookies of sites you navigate to are kept fresh by touchPage, so an active login is evicted last.
  function evictToFit(initial) {
    let rules = initial;
    let evicted = 0;
    const affected = new Set();
    while (countRegexRules(rules) > maxRegexRules) {
      const stale = profiles
        .flatMap((p) => (jars[p.id] ?? []).map((cookie) => ({ profileId: p.id, cookie })))
        .sort((a, b) => (a.cookie.updated ?? a.cookie.created) - (b.cookie.updated ?? b.cookie.created));
      if (!stale.length) break;
      for (const { profileId, cookie } of stale.slice(0, Math.max(1, Math.ceil(stale.length * 0.1)))) {
        jars[profileId] = jars[profileId].filter((c) => c !== cookie);
        affected.add(profileId);
        evicted += 1;
      }
      rules = currentRules();
    }
    return { rules, evicted, affected };
  }

  // Never leaves a profile tab without its base rules: those strip the browser's real cookies. If the full rule set
  // cannot be installed (over the limit, or refused for any reason), fall back to base rules only. The tab then sends
  // no cookies at all, which is safe; sending your real login would not be.
  async function syncRules() {
    let wanted = currentRules();
    let affected = new Set();
    if (countRegexRules(wanted) > maxRegexRules) {
      const fitted = evictToFit(wanted);
      wanted = fitted.rules;
      affected = fitted.affected;
      await setWarning(
        `Too many cookie rules for the browser (limit ${maxRegexRules}): removed ${fitted.evicted} least recently used cookies. Clear cookies you no longer need from the profile editor.`,
      );
    }
    if (JSON.stringify(wanted) !== lastPushed) {
      try {
        await pushRules(wanted);
      } catch (error) {
        await pushRules(currentRules({ withoutCookies: true }));
        await setWarning(
          `The browser refused the cookie rules (${error.message}). Profile tabs stay isolated but send no cookies until you clear some data.`,
        );
      }
    }
    for (const id of affected) {
      await persistJar(id);
      onJarChange(id);
    }
  }

  const makeProfile = (name, color) => {
    const number = nextNumber;
    nextNumber += 1;
    return { id: `p${number}`, number, name, color };
  };

  const cleanName = (name) => {
    const trimmed = String(name ?? '').trim();
    if (!trimmed) throw new Error('name is required');
    return trimmed;
  };

  return {
    init: () =>
      serialize(async () => {
        const stored = (await local.get(['profiles'])).profiles;
        if (stored) {
          profiles = stored.list;
          nextNumber = stored.nextNumber;
          jars = (await local.get(profiles.map((p) => jarKey(p.id)))) ?? {};
          jars = Object.fromEntries(profiles.map((p) => [p.id, jars[jarKey(p.id)] ?? []]));
        } else {
          profiles = DEFAULT_COLORS.map((color, i) => makeProfile(`User ${i + 1}`, color));
          jars = Object.fromEntries(profiles.map((p) => [p.id, []]));
          await persistProfiles();
        }
        const sessionState = await session.get(['tabs', 'warning']);
        tabs = sessionState.tabs ?? {};
        warning = sessionState.warning ?? null;
        await syncRules();
      }),

    warning: () => warning,

    dismissWarning: () =>
      serialize(async () => {
        warning = null;
        await session.remove('warning');
      }),

    // Call on every main-frame response of a profile tab: the cookies of the site being used count as recently used.
    touchPage: (tabId, url) =>
      serialize(async () => {
        const profileId = tabs[String(tabId)];
        if (!profileId) return;
        jars[profileId] = touchCookies(jars[profileId] ?? [], url, now());
      }),

    listProfiles: () =>
      serialize(async () =>
        profiles.map((p) => ({
          ...p,
          tabCount: tabIdsOf(p.id).length,
          cookieCount: (jars[p.id] ?? []).length,
        })),
      ),

    // name omitted: "User N". An explicit but blank name is an error.
    createProfile: ({ name, color } = {}) =>
      serialize(async () => {
        const profile = makeProfile(
          name === undefined ? `User ${nextNumber}` : cleanName(name),
          color ?? GROUP_COLORS[nextNumber % GROUP_COLORS.length],
        );
        profiles.push(profile);
        jars[profile.id] = [];
        await persistProfiles();
        await persistJar(profile.id);
        return profile;
      }),

    updateProfile: (id, { name, color }) =>
      serialize(async () => {
        const profile = requireProfile(id);
        if (name !== undefined) profile.name = cleanName(name);
        if (color !== undefined) profile.color = color;
        await persistProfiles();
        return profile;
      }),

    deleteProfile: (id) =>
      serialize(async () => {
        requireProfile(id);
        profiles = profiles.filter((p) => p.id !== id);
        delete jars[id];
        tabs = Object.fromEntries(Object.entries(tabs).filter(([, profileId]) => profileId !== id));
        await local.remove(jarKey(id));
        await persistProfiles();
        await persistTabs();
        await syncRules();
      }),

    // host omitted: wipe the profile's whole jar; host given: wipe only cookies that apply to that site.
    clearProfile: (id, { host } = {}) =>
      serialize(async () => {
        requireProfile(id);
        jars[id] = host
          ? (jars[id] ?? []).filter((c) => !(c.hostOnly ? c.domain === host : domainMatches(host, c.domain)))
          : [];
        await syncRules();
        await persistJar(id);
        onJarChange(id);
      }),

    profileOfTab: (tabId) => tabs[String(tabId)] ?? null,

    tabIdsOfProfile: (profileId) => tabIdsOf(profileId),

    assignTab: (tabId, profileId) =>
      serialize(async () => {
        if (profileId !== null) requireProfile(profileId);
        if (profileId === null) delete tabs[String(tabId)];
        else tabs[String(tabId)] = profileId;
        await syncRules();
        await persistTabs();
      }),

    removeTab: (tabId) =>
      serialize(async () => {
        if (!(String(tabId) in tabs)) return;
        delete tabs[String(tabId)];
        await syncRules();
        await persistTabs();
      }),

    // Called with every Set-Cookie header of a response the browser received for `tabId`.
    captureSetCookies: (tabId, url, headers) =>
      serialize(async () => {
        const profileId = tabs[String(tabId)];
        if (!profileId) return;
        let jar = jars[profileId] ?? [];
        let changed = false;
        for (const header of headers) {
          const cookie = parseSetCookie(header, url, now());
          if (!cookie) continue;
          jar = applySetCookie(jar, cookie, now());
          changed = true;
        }
        if (!changed) return;
        jars[profileId] = purgeExpired(jar, now());
        await syncRules();
        await persistJar(profileId);
        onJarChange(profileId);
      }),

    // document.cookie view for a profile tab (httpOnly hidden). null: the tab has no profile.
    documentCookie: (tabId, url) =>
      serialize(async () => {
        const profileId = tabs[String(tabId)];
        if (!profileId) return null;
        return cookieHeaderFor(jars[profileId] ?? [], url, now(), { includeHttpOnly: false });
      }),

    // document.cookie = '...' from page script. Returns false when a browser would also ignore it.
    setDocumentCookie: (tabId, url, cookieString) =>
      serialize(async () => {
        const profileId = tabs[String(tabId)];
        if (!profileId) return false;
        const cookie = parseSetCookie(cookieString, url, now());
        if (!cookie || cookie.httpOnly) return false;
        const jar = jars[profileId] ?? [];
        const existing = jar.find((c) => c.name === cookie.name && c.domain === cookie.domain && c.path === cookie.path);
        if (existing?.httpOnly) return false;
        jars[profileId] = purgeExpired(applySetCookie(jar, cookie, now()), now());
        await syncRules();
        await persistJar(profileId);
        onJarChange(profileId);
        return true;
      }),
  };
}
