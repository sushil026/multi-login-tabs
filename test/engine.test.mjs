import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../lib/engine.js';

const NOW = Date.UTC(2026, 10, 24, 12, 0, 0);

// In-memory stand-ins for chrome.storage.* and chrome.declarativeNetRequest.
function fakeArea() {
  const data = new Map();
  return {
    data,
    async get(keys) {
      const wanted = keys === null ? [...data.keys()] : [].concat(keys);
      return Object.fromEntries(wanted.filter((k) => data.has(k)).map((k) => [k, structuredClone(data.get(k))]));
    },
    async set(obj) {
      for (const [k, v] of Object.entries(obj)) data.set(k, structuredClone(v));
    },
    async remove(keys) {
      for (const k of [].concat(keys)) data.delete(k);
    },
  };
}

// rejectRegex: behave like a browser that refuses any rule set containing regex rules (limit exceeded).
function fakeDnr({ rejectRegex = false } = {}) {
  let rules = [];
  return {
    get rules() {
      return rules;
    },
    async getSessionRules() {
      return structuredClone(rules);
    },
    async updateSessionRules({ removeRuleIds = [], addRules = [] }) {
      if (rejectRegex && addRules.some((r) => r.condition.regexFilter)) throw new Error('rule limit exceeded');
      rules = rules.filter((r) => !removeRuleIds.includes(r.id)).concat(structuredClone(addRules));
    },
  };
}

function setup(existing = {}, options = {}) {
  const local = existing.local ?? fakeArea();
  const session = existing.session ?? fakeArea();
  const dnr = existing.dnr ?? fakeDnr();
  const changes = [];
  const engine = createEngine({
    local,
    session,
    dnr,
    now: options.now ?? (() => NOW),
    onJarChange: (id) => changes.push(id),
    ...(options.maxRegexRules ? { maxRegexRules: options.maxRegexRules } : {}),
  });
  return { engine, local, session, dnr, changes };
}

// A clock that moves forward one second per reading, so "older" and "newer" cookies are distinguishable.
function tickingClock() {
  let t = NOW;
  return () => {
    t += 1000;
    return t;
  };
}
const regexRules = (dnr) => dnr.rules.filter((r) => r.condition.regexFilter);

// The Cookie header DNR would set for `tabId` requesting `url` (highest priority `set`, else stripped).
function cookieFor(dnr, tabId, url) {
  const hit = dnr.rules
    .filter((r) => r.condition.tabIds.includes(tabId))
    .filter((r) => !r.condition.regexFilter || new RegExp(r.condition.regexFilter).test(url))
    .filter((r) => r.action.requestHeaders?.some((h) => h.header === 'cookie'))
    .sort((a, b) => b.priority - a.priority)[0];
  if (!hit) return null;
  const header = hit.action.requestHeaders.find((h) => h.header === 'cookie');
  return header.operation === 'set' ? header.value : '';
}

const URL1 = 'https://example.com/app';

test('init: seeds four default profiles once', async () => {
  const { engine } = setup();
  await engine.init();
  const profiles = await engine.listProfiles();
  assert.deepEqual(profiles.map((p) => p.number), [1, 2, 3, 4]);
  assert.deepEqual(profiles.map((p) => p.name), ['User 1', 'User 2', 'User 3', 'User 4']);
  assert.equal(new Set(profiles.map((p) => p.color)).size, 4);
});

test('init: does not re-seed after the user deleted every profile', async () => {
  const env = setup();
  await env.engine.init();
  for (const p of await env.engine.listProfiles()) await env.engine.deleteProfile(p.id);
  const again = setup(env);
  await again.engine.init();
  assert.deepEqual(await again.engine.listProfiles(), []);
});

test('profiles: create gets the next number, ids are never reused', async () => {
  const { engine } = setup();
  await engine.init();
  const five = await engine.createProfile({ name: 'QA admin', color: 'pink' });
  assert.equal(five.number, 5);
  await engine.deleteProfile(five.id);
  const six = await engine.createProfile({ name: 'QA agent', color: 'cyan' });
  assert.equal(six.number, 6);
  assert.notEqual(six.id, five.id);
});

test('profiles: update renames and recolors; unknown id throws', async () => {
  const { engine } = setup();
  await engine.init();
  await engine.updateProfile('p1', { name: 'Admin', color: 'orange' });
  const p1 = (await engine.listProfiles()).find((p) => p.id === 'p1');
  assert.equal(p1.name, 'Admin');
  assert.equal(p1.color, 'orange');
  await assert.rejects(() => engine.updateProfile('nope', { name: 'x' }), /unknown profile/);
});

test('profiles: create without a name gets "User N" and a color from the palette', async () => {
  const { engine } = setup();
  await engine.init();
  const profile = await engine.createProfile({});
  assert.equal(profile.name, 'User 5');
  assert.ok(['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'].includes(profile.color));
});

test('profiles: create rejects an empty name', async () => {
  const { engine } = setup();
  await engine.init();
  await assert.rejects(() => engine.createProfile({ name: '   ', color: 'blue' }), /name/);
});

test('tabs: assign installs rules for that tab, unassign removes them', async () => {
  const { engine, dnr } = setup();
  await engine.init();
  assert.equal(dnr.rules.length, 0);
  await engine.assignTab(10, 'p1');
  assert.ok(dnr.rules.length > 0);
  assert.ok(dnr.rules.every((r) => r.condition.tabIds.includes(10)));
  assert.equal(engine.profileOfTab(10), 'p1');
  await engine.assignTab(10, null);
  assert.equal(dnr.rules.length, 0);
  assert.equal(engine.profileOfTab(10), null);
});

test('tabs: reassigning moves the tab between profiles; unknown profile throws', async () => {
  const { engine } = setup();
  await engine.init();
  await engine.assignTab(10, 'p1');
  await engine.assignTab(10, 'p2');
  assert.equal(engine.profileOfTab(10), 'p2');
  await assert.rejects(() => engine.assignTab(10, 'ghost'), /unknown profile/);
});

test('tabs: removeTab forgets the tab and its rules', async () => {
  const { engine, dnr } = setup();
  await engine.init();
  await engine.assignTab(10, 'p1');
  await engine.removeTab(10);
  assert.equal(engine.profileOfTab(10), null);
  assert.equal(dnr.rules.length, 0);
  await engine.removeTab(999); // unknown tab is a no-op
});

test('capture: Set-Cookie from a profile tab lands in that profile and updates the rules', async () => {
  const { engine, dnr } = setup();
  await engine.init();
  await engine.assignTab(10, 'p1');
  await engine.captureSetCookies(10, URL1, ['sid=abc; Path=/; HttpOnly']);
  assert.equal(cookieFor(dnr, 10, 'https://example.com/x'), 'sid=abc');
});

test('capture: rotation replaces the value in the rules', async () => {
  const { engine, dnr } = setup();
  await engine.init();
  await engine.assignTab(10, 'p1');
  await engine.captureSetCookies(10, URL1, ['rt=one; Path=/']);
  await engine.captureSetCookies(10, URL1, ['rt=two; Path=/']);
  assert.equal(cookieFor(dnr, 10, 'https://example.com/x'), 'rt=two');
});

test('capture: Max-Age=0 deletes the cookie', async () => {
  const { engine, dnr } = setup();
  await engine.init();
  await engine.assignTab(10, 'p1');
  await engine.captureSetCookies(10, URL1, ['sid=abc; Path=/']);
  await engine.captureSetCookies(10, URL1, ['sid=; Path=/; Max-Age=0']);
  assert.equal(cookieFor(dnr, 10, 'https://example.com/x'), '');
});

test('capture: tabs without a profile, unknown tab ids and garbage headers are ignored', async () => {
  const { engine, dnr } = setup();
  await engine.init();
  await engine.captureSetCookies(10, URL1, ['sid=abc; Path=/']);
  await engine.captureSetCookies(-1, URL1, ['sid=abc; Path=/']);
  assert.equal(dnr.rules.length, 0);
  await engine.assignTab(10, 'p1');
  await engine.captureSetCookies(10, URL1, ['', 'nonsense', 'a=1; Domain=evil.com', 'ok=1; Path=/']);
  assert.equal(cookieFor(dnr, 10, 'https://example.com/'), 'ok=1');
});

test('isolation: two profiles on the same site keep separate cookies', async () => {
  const { engine, dnr } = setup();
  await engine.init();
  await engine.assignTab(10, 'p1');
  await engine.assignTab(20, 'p2');
  await engine.captureSetCookies(10, URL1, ['sid=ALICE; Path=/']);
  await engine.captureSetCookies(20, URL1, ['sid=BOB; Path=/']);
  assert.equal(cookieFor(dnr, 10, 'https://example.com/'), 'sid=ALICE');
  assert.equal(cookieFor(dnr, 20, 'https://example.com/'), 'sid=BOB');
  assert.equal(cookieFor(dnr, 30, 'https://example.com/'), null);
});

test('isolation: two tabs of the same profile share one jar', async () => {
  const { engine, dnr } = setup();
  await engine.init();
  await engine.assignTab(10, 'p1');
  await engine.assignTab(11, 'p1');
  await engine.captureSetCookies(10, URL1, ['sid=ALICE; Path=/']);
  assert.equal(cookieFor(dnr, 11, 'https://example.com/'), 'sid=ALICE');
});

test('capture: many concurrent responses are all kept (serialized writes)', async () => {
  const { engine, dnr } = setup();
  await engine.init();
  await engine.assignTab(10, 'p1');
  await Promise.all(Array.from({ length: 20 }, (_, i) => engine.captureSetCookies(10, URL1, [`c${i}=v${i}; Path=/`])));
  const header = cookieFor(dnr, 10, 'https://example.com/');
  assert.equal(header.split('; ').length, 20);
});

test('deleteProfile: drops its jar and unassigns its tabs, others untouched', async () => {
  const { engine, dnr } = setup();
  await engine.init();
  await engine.assignTab(10, 'p1');
  await engine.assignTab(20, 'p2');
  await engine.captureSetCookies(10, URL1, ['sid=A; Path=/']);
  await engine.captureSetCookies(20, URL1, ['sid=B; Path=/']);
  await engine.deleteProfile('p1');
  assert.equal(engine.profileOfTab(10), null);
  assert.equal(cookieFor(dnr, 10, 'https://example.com/'), null);
  assert.equal(cookieFor(dnr, 20, 'https://example.com/'), 'sid=B');
});

test('clearProfile: removes all cookies, or only those of one site', async () => {
  const { engine, dnr } = setup();
  await engine.init();
  await engine.assignTab(10, 'p1');
  await engine.captureSetCookies(10, 'https://a.example.com/', ['a=1; Path=/']);
  await engine.captureSetCookies(10, 'https://b.other.org/', ['b=2; Path=/']);
  await engine.clearProfile('p1', { host: 'a.example.com' });
  assert.equal(cookieFor(dnr, 10, 'https://a.example.com/'), '');
  assert.equal(cookieFor(dnr, 10, 'https://b.other.org/'), 'b=2');
  await engine.clearProfile('p1');
  assert.equal(cookieFor(dnr, 10, 'https://b.other.org/'), '');
});

test('persistence: a new engine on the same storage restores profiles, jars and tab map', async () => {
  const env = setup();
  await env.engine.init();
  await env.engine.assignTab(10, 'p2');
  await env.engine.captureSetCookies(10, URL1, ['sid=keep; Path=/']);

  const woke = setup(env); // service worker restarted: same storage, fresh memory
  await woke.engine.init();
  assert.equal(woke.engine.profileOfTab(10), 'p2');
  assert.equal(cookieFor(env.dnr, 10, 'https://example.com/'), 'sid=keep');
  assert.equal((await woke.engine.listProfiles()).length, 4);
});

test('listProfiles: reports tab and cookie counts', async () => {
  const { engine } = setup();
  await engine.init();
  await engine.assignTab(10, 'p1');
  await engine.assignTab(11, 'p1');
  await engine.captureSetCookies(10, URL1, ['a=1; Path=/', 'b=2; Path=/']);
  const p1 = (await engine.listProfiles()).find((p) => p.id === 'p1');
  assert.equal(p1.tabCount, 2);
  assert.equal(p1.cookieCount, 2);
});

test('document.cookie: getter hides httpOnly cookies, setter stores JS cookies only', async () => {
  const { engine, dnr } = setup();
  await engine.init();
  await engine.assignTab(10, 'p1');
  await engine.captureSetCookies(10, URL1, ['srv=1; Path=/; HttpOnly']);
  assert.equal(await engine.documentCookie(10, 'https://example.com/'), '');

  assert.equal(await engine.setDocumentCookie(10, 'https://example.com/', 'js=2; Path=/'), true);
  assert.equal(await engine.documentCookie(10, 'https://example.com/'), 'js=2');
  assert.equal(cookieFor(dnr, 10, 'https://example.com/'), 'srv=1; js=2');

  assert.equal(await engine.setDocumentCookie(10, 'https://example.com/', 'x=1; HttpOnly'), false);
  assert.equal(await engine.setDocumentCookie(99, 'https://example.com/', 'x=1'), false);
});

test('onJarChange: fires with the profile id when its cookies change, not for tabs without a profile', async () => {
  const { engine, changes } = setup();
  await engine.init();
  await engine.captureSetCookies(10, URL1, ['a=1; Path=/']); // no profile: nothing to report
  assert.deepEqual(changes, []);
  await engine.assignTab(10, 'p1');
  await engine.captureSetCookies(10, URL1, ['a=1; Path=/']);
  assert.deepEqual(changes, ['p1']);
  await engine.captureSetCookies(10, URL1, ['', 'garbage']); // nothing parsed: no change
  assert.deepEqual(changes, ['p1']);
});

test('onJarChange: fires for accepted document.cookie writes and for clearing, not for rejected writes', async () => {
  const { engine, changes } = setup();
  await engine.init();
  await engine.assignTab(10, 'p2');
  assert.equal(await engine.setDocumentCookie(10, URL1, 'x=1; HttpOnly'), false);
  assert.deepEqual(changes, []);
  assert.equal(await engine.setDocumentCookie(10, URL1, 'x=1; Path=/'), true);
  assert.deepEqual(changes, ['p2']);
  await engine.clearProfile('p2');
  assert.deepEqual(changes, ['p2', 'p2']);
});

test('tabIdsOfProfile: lists the tabs of one profile as numbers', async () => {
  const { engine } = setup();
  await engine.init();
  await engine.assignTab(10, 'p1');
  await engine.assignTab(11, 'p1');
  await engine.assignTab(20, 'p2');
  assert.deepEqual(engine.tabIdsOfProfile('p1').sort(), [10, 11]);
  assert.deepEqual(engine.tabIdsOfProfile('p3'), []);
});

// ---------- rule budget: fail closed ----------
test('budget: over the regex-rule limit, the stalest cookies are evicted and the profile stays isolated', async () => {
  const { engine, dnr } = setup({}, { now: tickingClock(), maxRegexRules: 6 });
  await engine.init();
  await engine.assignTab(10, 'p1');
  for (const host of ['a', 'b', 'c', 'd', 'e']) await engine.captureSetCookies(10, `https://${host}.example.com/`, ['k=1; Path=/']);

  assert.ok(regexRules(dnr).length <= 6, `regex rules: ${regexRules(dnr).length}`);
  assert.equal(cookieFor(dnr, 10, 'https://e.example.com/'), 'k=1', 'newest cookie survives');
  assert.equal(cookieFor(dnr, 10, 'https://a.example.com/'), '', 'oldest cookie is gone, real cookies still stripped');
  assert.match(engine.warning() ?? '', /removed/);
  const p1 = (await engine.listProfiles()).find((p) => p.id === 'p1');
  assert.ok(p1.cookieCount < 5);
});

test('budget: navigating to a site protects its cookies from eviction', async () => {
  const { engine, dnr } = setup({}, { now: tickingClock(), maxRegexRules: 6 });
  await engine.init();
  await engine.assignTab(10, 'p1');
  for (const host of ['a', 'b', 'c']) await engine.captureSetCookies(10, `https://${host}.example.com/`, ['k=1; Path=/']);
  await engine.touchPage(10, 'https://a.example.com/home'); // the user is using site "a"
  await engine.captureSetCookies(10, 'https://d.example.com/', ['k=1; Path=/']);

  assert.equal(cookieFor(dnr, 10, 'https://a.example.com/'), 'k=1', 'recently visited site keeps its login');
  assert.equal(cookieFor(dnr, 10, 'https://b.example.com/'), '', 'the stalest site was evicted instead');
});

test('budget: within the limit nothing is evicted and there is no warning', async () => {
  const { engine } = setup({}, { now: tickingClock(), maxRegexRules: 50 });
  await engine.init();
  await engine.assignTab(10, 'p1');
  for (const host of ['a', 'b', 'c']) await engine.captureSetCookies(10, `https://${host}.example.com/`, ['k=1; Path=/']);
  assert.equal(engine.warning(), null);
  assert.equal((await engine.listProfiles()).find((p) => p.id === 'p1').cookieCount, 3);
});

test('budget: if the browser refuses the full rule set, base rules still install (fail closed)', async () => {
  const dnr = fakeDnr({ rejectRegex: true });
  const { engine } = setup({ dnr });
  await engine.init();
  await engine.assignTab(10, 'p1'); // no cookies yet: nothing is refused
  await engine.captureSetCookies(10, URL1, ['sid=abc; Path=/']); // regex rules now refused

  assert.equal(cookieFor(dnr, 10, 'https://example.com/'), '', 'tab is isolated: real cookies stripped, none sent');
  assert.match(engine.warning() ?? '', /refused/);
  await engine.assignTab(11, 'p2'); // a new tab must still be isolated
  assert.equal(cookieFor(dnr, 11, 'https://example.com/'), '');
});

test('budget: touchPage ignores tabs without a profile', async () => {
  const { engine } = setup();
  await engine.init();
  await engine.touchPage(99, 'https://example.com/');
  await engine.touchPage(-1, 'https://example.com/');
});

test('expired cookies are purged from the stored jar on sync', async () => {
  const { engine, local } = setup();
  await engine.init();
  await engine.assignTab(10, 'p1');
  await engine.captureSetCookies(10, URL1, ['gone=1; Path=/; Max-Age=0', 'keep=1; Path=/']);
  const stored = (await local.get('jar:p1'))['jar:p1'];
  assert.deepEqual(stored.map((c) => c.name), ['keep']);
});
