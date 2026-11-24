import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSetCookie, applySetCookie, cookieHeaderFor } from '../lib/cookie-jar.js';
import { buildRules } from '../lib/rules.js';

const NOW = Date.UTC(2026, 10, 24, 12, 0, 0);

// Builds a jar from [header, url?, created?] tuples.
const jarOf = (...tuples) =>
  tuples.reduce((jar, [header, url = 'https://example.com/', created = NOW]) => {
    const cookie = parseSetCookie(header, url, created);
    return applySetCookie(jar, cookie, NOW);
  }, []);

const profile = (id, jar, tabIds = [1]) => ({ id, jar, tabIds });

// Tiny stand-in for Chrome's DNR: highest-priority matching `set` wins, else a `remove` from the base rule.
function simulateCookieHeader(rules, tabId, url) {
  const matching = rules
    .filter((r) => r.condition.tabIds.includes(tabId))
    .filter((r) => !r.condition.regexFilter || new RegExp(r.condition.regexFilter).test(url))
    .filter((r) => r.action.requestHeaders?.some((h) => h.header === 'cookie'))
    .sort((a, b) => b.priority - a.priority);
  const top = matching[0]?.action.requestHeaders.find((h) => h.header === 'cookie');
  if (!top) return null; // no rule touches the header: the browser's real cookies would leak
  return top.operation === 'set' ? top.value : '';
}

test('rules: no profiles gives no rules', () => {
  assert.deepEqual(buildRules([], NOW), []);
});

test('rules: a profile with no tabs gets no rules (DNR rejects empty tabIds)', () => {
  assert.deepEqual(buildRules([profile('p1', [], [])], NOW), []);
});

test('rules: empty jar still blocks real cookies, hides Set-Cookie and tags frames', () => {
  const rules = buildRules([profile('p1', [], [7])], NOW);
  assert.equal(rules.length, 2);
  const all = rules.find((r) => r.action.requestHeaders);
  assert.deepEqual(all.action.requestHeaders, [{ header: 'cookie', operation: 'remove' }]);
  assert.deepEqual(all.action.responseHeaders, [{ header: 'set-cookie', operation: 'remove' }]);
  assert.deepEqual(all.condition.tabIds, [7]);
  assert.ok(all.condition.resourceTypes.includes('main_frame'));
  assert.equal(all.priority, 1);

  const frames = rules.find((r) => !r.action.requestHeaders);
  assert.deepEqual(frames.action.responseHeaders, [{ header: 'server-timing', operation: 'append', value: 'mlx;desc="p1"' }]);
  assert.deepEqual(frames.condition.resourceTypes, ['main_frame', 'sub_frame']);
});

test('rules: ids are unique and sequential across profiles', () => {
  const jar = jarOf(['a=1; Path=/']);
  const rules = buildRules([profile('p1', jar, [1]), profile('p2', jar, [2])], NOW);
  assert.deepEqual(rules.map((r) => r.id), rules.map((_, i) => i + 1));
});

test('rules: each profile only affects its own tabs and its own cookies', () => {
  const rules = buildRules(
    [profile('p1', jarOf(['sid=AAA; Path=/']), [1]), profile('p2', jarOf(['sid=BBB; Path=/']), [2])],
    NOW,
  );
  assert.equal(simulateCookieHeader(rules, 1, 'https://example.com/x'), 'sid=AAA');
  assert.equal(simulateCookieHeader(rules, 2, 'https://example.com/x'), 'sid=BBB');
  assert.equal(simulateCookieHeader(rules, 3, 'https://example.com/x'), null);
});

test('rules: host-only cookie rule matches the exact host only', () => {
  const rules = buildRules([profile('p1', jarOf(['a=1; Path=/']))], NOW);
  assert.equal(simulateCookieHeader(rules, 1, 'https://example.com/x?y=1'), 'a=1');
  assert.equal(simulateCookieHeader(rules, 1, 'https://example.com:8443/x'), 'a=1');
  assert.equal(simulateCookieHeader(rules, 1, 'https://sub.example.com/x'), '');
  assert.equal(simulateCookieHeader(rules, 1, 'https://notexample.com/x'), '');
});

test('rules: domain cookie rule matches subdomains but not look-alikes', () => {
  const rules = buildRules([profile('p1', jarOf(['a=1; Path=/; Domain=example.com']))], NOW);
  assert.equal(simulateCookieHeader(rules, 1, 'https://example.com/'), 'a=1');
  assert.equal(simulateCookieHeader(rules, 1, 'https://x.y.example.com/'), 'a=1');
  assert.equal(simulateCookieHeader(rules, 1, 'https://notexample.com/'), '');
  assert.equal(simulateCookieHeader(rules, 1, 'https://example.com.evil.io/'), '');
});

test('rules: path boundaries', () => {
  const rules = buildRules([profile('p1', jarOf(['a=1; Path=/api']))], NOW);
  assert.equal(simulateCookieHeader(rules, 1, 'https://example.com/api'), 'a=1');
  assert.equal(simulateCookieHeader(rules, 1, 'https://example.com/api/users'), 'a=1');
  assert.equal(simulateCookieHeader(rules, 1, 'https://example.com/api?x=1'), 'a=1');
  assert.equal(simulateCookieHeader(rules, 1, 'https://example.com/apix'), '');
  assert.equal(simulateCookieHeader(rules, 1, 'https://example.com/'), '');
});

test('rules: Secure cookies need https, except on loopback hosts', () => {
  const secure = buildRules([profile('p1', jarOf(['a=1; Path=/; Secure']))], NOW);
  assert.equal(simulateCookieHeader(secure, 1, 'https://example.com/'), 'a=1');
  assert.equal(simulateCookieHeader(secure, 1, 'http://example.com/'), '');

  const local = buildRules([profile('p1', jarOf(['a=1; Path=/; Secure', 'http://localhost:3100/']))], NOW);
  assert.equal(simulateCookieHeader(local, 1, 'http://localhost:3100/x'), 'a=1');
  assert.equal(simulateCookieHeader(local, 1, 'http://localhost:4000/x'), 'a=1');
});

test('rules: expired cookies are left out', () => {
  const jar = jarOf(['a=1; Path=/; Max-Age=10']);
  assert.equal(simulateCookieHeader(buildRules([profile('p1', jar)], NOW), 1, 'https://example.com/'), 'a=1');
  assert.equal(simulateCookieHeader(buildRules([profile('p1', jar)], NOW + 60_000), 1, 'https://example.com/'), '');
});

test('rules: broader cookies are included in more specific scopes, which rank higher', () => {
  const jar = jarOf(
    ['wide=1; Path=/; Domain=example.com', 'https://example.com/', 1],
    ['narrow=2; Path=/', 'https://app.example.com/', 2],
  );
  const rules = buildRules([profile('p1', jar)], NOW);
  assert.equal(simulateCookieHeader(rules, 1, 'https://example.com/'), 'wide=1');
  assert.equal(simulateCookieHeader(rules, 1, 'https://other.example.com/'), 'wide=1');
  assert.equal(simulateCookieHeader(rules, 1, 'https://app.example.com/'), 'wide=1; narrow=2');
});

test('rules: overlapping but non-nested scopes get an intersection rule', () => {
  // X: any *.example.com under /a/b.  Y: only app.example.com under /a.
  const jar = jarOf(
    ['x=1; Path=/a/b; Domain=example.com', 'https://example.com/a/b/', 1],
    ['y=2; Path=/a', 'https://app.example.com/a/', 2],
  );
  const rules = buildRules([profile('p1', jar)], NOW);
  assert.equal(simulateCookieHeader(rules, 1, 'https://app.example.com/a/b/c'), 'x=1; y=2');
  assert.equal(simulateCookieHeader(rules, 1, 'https://app.example.com/a/z'), 'y=2');
  assert.equal(simulateCookieHeader(rules, 1, 'https://other.example.com/a/b/c'), 'x=1');
});

test('rules: simulated DNR output equals cookieHeaderFor for a mixed jar over many URLs', () => {
  const jar = jarOf(
    ['root=r; Path=/; Domain=example.com', 'https://example.com/', 1],
    ['sec=s; Path=/; Domain=example.com; Secure', 'https://example.com/', 2],
    ['host=h; Path=/', 'https://app.example.com/', 3],
    ['api=a; Path=/api', 'https://app.example.com/', 4],
    ['deep=d; Path=/api/v1; Domain=app.example.com', 'https://app.example.com/', 5],
    ['slash=z; Path=/files/', 'https://example.com/', 6],
    ['other=o; Path=/', 'https://another.org/', 7],
    ['loc=l; Path=/; Secure', 'http://localhost:3100/', 8],
  );
  const rules = buildRules([profile('p1', jar)], NOW);

  const hosts = ['example.com', 'app.example.com', 'x.app.example.com', 'sub.example.com', 'another.org', 'localhost', 'notexample.com'];
  const paths = ['/', '/api', '/api/', '/api/v1', '/api/v1/x', '/apix', '/files', '/files/', '/files/a', '/zzz'];
  const schemes = ['http', 'https'];
  let compared = 0;
  for (const scheme of schemes) {
    for (const host of hosts) {
      for (const path of paths) {
        const url = `${scheme}://${host}${path}`;
        const expected = cookieHeaderFor(jar, url, NOW);
        const actual = simulateCookieHeader(rules, 1, url);
        assert.equal(actual, expected, `mismatch for ${url}`);
        compared += 1;
      }
    }
  }
  assert.equal(compared, schemes.length * hosts.length * paths.length);
});

// What the page-side shim reads: every matching frame rule appends `mlxc;dur=<rank>;desc="<encoded cookies>"`;
// the entry with the highest rank is the most specific scope.
function simulateDocCookie(rules, tabId, url) {
  const entries = rules
    .filter((r) => r.condition.tabIds.includes(tabId))
    .filter((r) => r.condition.resourceTypes.includes('main_frame'))
    .filter((r) => !r.condition.regexFilter || new RegExp(r.condition.regexFilter).test(url))
    .flatMap((r) => r.action.responseHeaders ?? [])
    .filter((h) => h.header === 'server-timing' && h.value.startsWith('mlxc;'))
    .map((h) => /^mlxc;dur=(\d+);desc="(.*)"$/.exec(h.value))
    .map((m) => ({ rank: Number(m[1]), cookies: decodeURIComponent(m[2]) }))
    .sort((a, b) => b.rank - a.rank);
  return entries[0]?.cookies ?? '';
}

test('rules: frame rules carry the JavaScript-visible cookies, never httpOnly ones', () => {
  const jar = jarOf(['theme=dark; Path=/'], ['sid=secret; Path=/; HttpOnly']);
  const rules = buildRules([profile('p1', jar)], NOW);
  const frameRule = rules.find((r) => r.action.responseHeaders?.[0]?.value?.startsWith('mlxc;'));
  assert.ok(frameRule, 'expected a frame rule with the cookie snapshot');
  assert.deepEqual(frameRule.condition.resourceTypes, ['main_frame', 'sub_frame']);
  assert.equal(frameRule.action.responseHeaders[0].operation, 'append');
  assert.match(frameRule.action.responseHeaders[0].value, /^mlxc;dur=\d+;desc="theme%3Ddark"$/);
  const responseValues = rules.flatMap((r) => r.action.responseHeaders ?? []).map((h) => h.value ?? '');
  assert.ok(responseValues.every((v) => !v.includes('secret')), 'httpOnly values must never reach page-readable headers');
});

test('rules: a jar with only httpOnly cookies adds no snapshot rule', () => {
  const rules = buildRules([profile('p1', jarOf(['sid=secret; Path=/; HttpOnly']))], NOW);
  assert.ok(!rules.some((r) => r.action.responseHeaders?.some((h) => h.value?.startsWith('mlxc;'))));
});

test('rules: cookie values with separators and quotes survive the header encoding', () => {
  const jar = jarOf(['pref=a%20b"c\\d; Path=/']);
  const rules = buildRules([profile('p1', jar)], NOW);
  assert.equal(simulateDocCookie(rules, 1, 'https://example.com/'), cookieHeaderFor(jar, 'https://example.com/', NOW, { includeHttpOnly: false }));
});

test('rules: simulated document snapshot equals cookieHeaderFor(includeHttpOnly=false) for a mixed jar', () => {
  const jar = jarOf(
    ['root=r; Path=/; Domain=example.com', 'https://example.com/', 1],
    ['hid=x; Path=/; Domain=example.com; HttpOnly', 'https://example.com/', 2],
    ['sec=s; Path=/; Domain=example.com; Secure', 'https://example.com/', 3],
    ['host=h; Path=/', 'https://app.example.com/', 4],
    ['api=a; Path=/api', 'https://app.example.com/', 5],
    ['apihid=a; Path=/api; HttpOnly', 'https://app.example.com/', 6],
    ['deep=d; Path=/api/v1; Domain=app.example.com', 'https://app.example.com/', 7],
    ['slash=z; Path=/files/', 'https://example.com/', 8],
    ['loc=l; Path=/; Secure', 'http://localhost:3100/', 9],
  );
  const rules = buildRules([profile('p1', jar)], NOW);
  const hosts = ['example.com', 'app.example.com', 'x.app.example.com', 'sub.example.com', 'localhost', 'notexample.com'];
  const paths = ['/', '/api', '/api/', '/api/v1', '/api/v1/x', '/apix', '/files', '/files/a', '/zzz'];
  for (const scheme of ['http', 'https']) {
    for (const host of hosts) {
      for (const p of paths) {
        const url = `${scheme}://${host}${p}`;
        assert.equal(simulateDocCookie(rules, 1, url), cookieHeaderFor(jar, url, NOW, { includeHttpOnly: false }), `mismatch for ${url}`);
      }
    }
  }
});

test('rules: stays within the DNR rule budget for a realistic jar', () => {
  const tuples = Array.from({ length: 60 }, (_, i) => [`c${i}=v; Path=/`, `https://site${i % 6}.example.com/`, i]);
  const rules = buildRules([profile('p1', jarOf(...tuples))], NOW);
  assert.ok(rules.length < 100, `got ${rules.length} rules`);
});
