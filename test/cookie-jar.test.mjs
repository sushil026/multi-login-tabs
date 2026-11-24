import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSetCookie, applySetCookie, purgeExpired, cookieHeaderFor, touchCookies } from '../lib/cookie-jar.js';

const NOW = Date.UTC(2026, 10, 24, 12, 0, 0);
const parse = (header, url = 'https://example.com/a/b', now = NOW) => parseSetCookie(header, url, now);

// ---------- parseSetCookie ----------
test('parse: bare cookie gets host-only scope and default path', () => {
  const c = parse('sid=abc');
  assert.equal(c.name, 'sid');
  assert.equal(c.value, 'abc');
  assert.equal(c.domain, 'example.com');
  assert.equal(c.hostOnly, true);
  assert.equal(c.path, '/a');
  assert.equal(c.secure, false);
  assert.equal(c.httpOnly, false);
  assert.equal(c.expires, null);
});

test('parse: all attributes, case-insensitive, leading dot stripped', () => {
  const c = parse('sid=abc; path=/; DOMAIN=.Example.com; SECURE; httponly; SameSite=Lax', 'https://app.example.com/x');
  assert.equal(c.domain, 'example.com');
  assert.equal(c.hostOnly, false);
  assert.equal(c.path, '/');
  assert.equal(c.secure, true);
  assert.equal(c.httpOnly, true);
  assert.equal(c.sameSite, 'lax');
});

test('parse: Max-Age sets expiry and beats Expires', () => {
  const c = parse('a=1; Max-Age=60; Expires=Wed, 21 Oct 2099 07:28:00 GMT');
  assert.equal(c.expires, NOW + 60_000);
});

test('parse: Max-Age zero or negative means already expired', () => {
  assert.ok(parse('a=1; Max-Age=0').expires <= NOW);
  assert.ok(parse('a=1; Max-Age=-5').expires <= NOW);
});

test('parse: Expires date parsed, invalid Expires ignored', () => {
  assert.equal(parse('a=1; Expires=Wed, 21 Oct 2099 07:28:00 GMT').expires, Date.parse('Wed, 21 Oct 2099 07:28:00 GMT'));
  assert.equal(parse('a=1; Expires=not-a-date').expires, null);
});

test('parse: value keeps extra = signs, whitespace trimmed', () => {
  const c = parse('  a = b=c==  ; Path=/');
  assert.equal(c.name, 'a');
  assert.equal(c.value, 'b=c==');
});

test('parse: invalid input returns null', () => {
  assert.equal(parse(''), null);
  assert.equal(parse('novalue'), null);
  assert.equal(parse('=abc'), null);
  assert.equal(parse(undefined), null);
  assert.equal(parse(42), null);
  assert.equal(parseSetCookie('a=1', 'not a url', NOW), null);
});

test('parse: Domain that does not match the request host is rejected', () => {
  assert.equal(parse('a=1; Domain=evil.com'), null);
  assert.equal(parse('a=1; Domain=sub.example.com'), null);
  assert.notEqual(parse('a=1; Domain=example.com'), null);
});

test('parse: default path rules', () => {
  assert.equal(parse('a=1', 'https://example.com/').path, '/');
  assert.equal(parse('a=1', 'https://example.com/a').path, '/');
  assert.equal(parse('a=1', 'https://example.com/a/b/c').path, '/a/b');
  assert.equal(parse('a=1; Path=relative', 'https://example.com/a/b/c').path, '/a/b');
});

test('parse: unknown attributes ignored', () => {
  assert.equal(parse('a=1; Priority=High; Partitioned').name, 'a');
});

// ---------- applySetCookie / purgeExpired ----------
test('apply: adds to an empty jar', () => {
  const jar = applySetCookie([], parse('a=1'), NOW);
  assert.equal(jar.length, 1);
});

test('apply: same name+domain+path replaces value and keeps creation time', () => {
  const first = parse('a=1; Path=/', 'https://example.com/', NOW);
  const second = parse('a=2; Path=/', 'https://example.com/', NOW + 5000);
  const jar = applySetCookie(applySetCookie([], first, NOW), second, NOW + 5000);
  assert.equal(jar.length, 1);
  assert.equal(jar[0].value, '2');
  assert.equal(jar[0].created, first.created);
});

test('apply: different path or domain coexist', () => {
  let jar = applySetCookie([], parse('a=1; Path=/'), NOW);
  jar = applySetCookie(jar, parse('a=2; Path=/x'), NOW);
  jar = applySetCookie(jar, parse('a=3; Path=/', 'https://other.com/'), NOW);
  assert.equal(jar.length, 3);
});

test('apply: expired cookie deletes the existing one and is not stored', () => {
  let jar = applySetCookie([], parse('a=1; Path=/'), NOW);
  jar = applySetCookie(jar, parse('a=gone; Path=/; Max-Age=0'), NOW);
  assert.equal(jar.length, 0);
});

test('apply: does not mutate the input jar', () => {
  const jar = Object.freeze([]);
  const next = applySetCookie(jar, parse('a=1'), NOW);
  assert.equal(jar.length, 0);
  assert.equal(next.length, 1);
});

test('apply: null cookie leaves the jar unchanged', () => {
  const jar = applySetCookie([], parse('a=1'), NOW);
  assert.deepEqual(applySetCookie(jar, null, NOW), jar);
});

test('purgeExpired: drops expired, keeps session and future cookies', () => {
  let jar = [];
  jar = applySetCookie(jar, parse('s=1; Path=/'), NOW);
  jar = applySetCookie(jar, parse('f=1; Path=/; Max-Age=100'), NOW);
  jar = applySetCookie(jar, parse('p=1; Path=/; Max-Age=10'), NOW);
  const later = purgeExpired(jar, NOW + 50_000);
  assert.deepEqual(later.map((c) => c.name).sort(), ['f', 's']);
});

// ---------- recency (used to decide what to evict when the rule budget is full) ----------
test('recency: parse stamps `updated`; a replacement refreshes it but keeps `created`', () => {
  const first = parse('a=1; Path=/', 'https://example.com/', NOW);
  assert.equal(first.updated, NOW);
  const second = parse('a=2; Path=/', 'https://example.com/', NOW + 9000);
  const jar = applySetCookie(applySetCookie([], first, NOW), second, NOW + 9000);
  assert.equal(jar[0].created, NOW);
  assert.equal(jar[0].updated, NOW + 9000);
});

test('touchCookies: bumps `updated` only for cookies that apply to the url, without mutating', () => {
  const jar = [
    parse('hit=1; Path=/', 'https://example.com/', NOW),
    parse('miss=1; Path=/', 'https://other.org/', NOW),
    parse('secret=1; Path=/; HttpOnly', 'https://example.com/', NOW),
  ];
  const touched = touchCookies(jar, 'https://example.com/page', NOW + 5000);
  assert.deepEqual(touched.map((c) => c.updated), [NOW + 5000, NOW, NOW + 5000]);
  assert.deepEqual(jar.map((c) => c.updated), [NOW, NOW, NOW]);
  assert.equal(touched[1], jar[1]);
  assert.equal(touchCookies(jar, 'not a url', NOW + 5000), jar);
});

// ---------- cookieHeaderFor ----------
const jarOf = (...headers) =>
  headers.reduce((jar, [h, url]) => applySetCookie(jar, parseSetCookie(h, url ?? 'https://example.com/', NOW), NOW), []);

test('header: empty jar gives empty string', () => {
  assert.equal(cookieHeaderFor([], 'https://example.com/', NOW), '');
});

test('header: host-only cookie matches exact host, not subdomains', () => {
  const jar = jarOf(['a=1; Path=/']);
  assert.equal(cookieHeaderFor(jar, 'https://example.com/x', NOW), 'a=1');
  assert.equal(cookieHeaderFor(jar, 'https://sub.example.com/x', NOW), '');
});

test('header: domain cookie matches host and subdomains, not look-alikes', () => {
  const jar = jarOf(['a=1; Path=/; Domain=example.com']);
  assert.equal(cookieHeaderFor(jar, 'https://example.com/', NOW), 'a=1');
  assert.equal(cookieHeaderFor(jar, 'https://deep.sub.example.com/', NOW), 'a=1');
  assert.equal(cookieHeaderFor(jar, 'https://notexample.com/', NOW), '');
  assert.equal(cookieHeaderFor(jar, 'https://example.com.evil.io/', NOW), '');
});

test('header: path matching respects segment boundaries', () => {
  const jar = jarOf(['a=1; Path=/a']);
  assert.equal(cookieHeaderFor(jar, 'https://example.com/a', NOW), 'a=1');
  assert.equal(cookieHeaderFor(jar, 'https://example.com/a/b', NOW), 'a=1');
  assert.equal(cookieHeaderFor(jar, 'https://example.com/ab', NOW), '');
  assert.equal(cookieHeaderFor(jar, 'https://example.com/', NOW), '');
});

test('header: path with trailing slash', () => {
  const jar = jarOf(['a=1; Path=/a/']);
  assert.equal(cookieHeaderFor(jar, 'https://example.com/a/x', NOW), 'a=1');
  assert.equal(cookieHeaderFor(jar, 'https://example.com/a', NOW), '');
});

test('header: Secure cookies only on https, but also on http loopback hosts', () => {
  const jar = jarOf(['a=1; Path=/; Secure']);
  assert.equal(cookieHeaderFor(jar, 'https://example.com/', NOW), 'a=1');
  assert.equal(cookieHeaderFor(jar, 'http://example.com/', NOW), '');
  const local = jarOf(['a=1; Path=/; Secure', 'http://localhost:3100/']);
  assert.equal(cookieHeaderFor(local, 'http://localhost:3100/', NOW), 'a=1');
});

test('header: ports are ignored', () => {
  const jar = jarOf(['a=1; Path=/', 'http://localhost:3100/']);
  assert.equal(cookieHeaderFor(jar, 'http://localhost:4000/x', NOW), 'a=1');
});

test('header: expired cookies are skipped even if still in the jar', () => {
  const jar = jarOf(['a=1; Path=/; Max-Age=10']);
  assert.equal(cookieHeaderFor(jar, 'https://example.com/', NOW + 5_000), 'a=1');
  assert.equal(cookieHeaderFor(jar, 'https://example.com/', NOW + 20_000), '');
});

test('header: longer paths first, then oldest first', () => {
  const jar = [
    { ...parse('b=2; Path=/'), created: 2 },
    { ...parse('c=3; Path=/a/b'), created: 3 },
    { ...parse('a=1; Path=/'), created: 1 },
  ];
  assert.equal(cookieHeaderFor(jar, 'https://example.com/a/b/c', NOW), 'c=3; a=1; b=2');
});

test('header: includeHttpOnly=false hides httpOnly cookies (document.cookie view)', () => {
  const jar = jarOf(['vis=1; Path=/'], ['hid=2; Path=/; HttpOnly']);
  assert.equal(cookieHeaderFor(jar, 'https://example.com/', NOW), 'vis=1; hid=2');
  assert.equal(cookieHeaderFor(jar, 'https://example.com/', NOW, { includeHttpOnly: false }), 'vis=1');
});

test('header: bad url returns empty string', () => {
  assert.equal(cookieHeaderFor(jarOf(['a=1; Path=/']), 'nope', NOW), '');
});
