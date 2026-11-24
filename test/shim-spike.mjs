// Browser integration test (Phase E5): page-storage isolation by the content scripts, in Brave.
// Tabs: A = profile p1, B = profile p2, C = no profile. All on the same origin.
import path from 'node:path';
import { extPath, launchWithExtension } from './launch.mjs';
import { startEchoServer } from './echo-server.mjs';

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await sleep(50);
  }
  return last;
}

const { server, base } = await startEchoServer();
const { context, worker } = await launchWithExtension(path.join(extPath, '.spike-profile', `shim-${Date.now()}`));

try {
  await worker.evaluate(() => globalThis.mlx.ready);
  const tabIdFor = (part) => worker.evaluate(async (p) => (await chrome.tabs.query({})).find((t) => t.url?.includes(p))?.id, part);
  const assign = (tabId, profileId) => worker.evaluate(([t, p]) => globalThis.mlx.assign(t, p), [tabId, profileId]);

  const [A, B, C] = [await context.newPage(), await context.newPage(), await context.newPage()];
  await A.goto(`${base}/blank?t=A`);
  await B.goto(`${base}/blank?t=B`);
  await C.goto(`${base}/blank?t=C`);
  const idA = await tabIdFor('t=A');
  const idB = await tabIdFor('t=B');
  await assign(idA, 'p1');
  await assign(idB, 'p2');
  for (const page of [A, B, C]) await page.goto(`${base}/storage`);

  // ---- localStorage ----
  await A.evaluate(() => localStorage.setItem('who', 'alice'));
  await B.evaluate(() => localStorage.setItem('who', 'bob'));
  await C.evaluate(() => localStorage.setItem('who', 'carol'));
  const who = async (page) => page.evaluate(() => localStorage.getItem('who'));
  check('E1 same key, three tabs, three separate values', (await who(A)) === 'alice' && (await who(B)) === 'bob' && (await who(C)) === 'carol', `${await who(A)}/${await who(B)}/${await who(C)}`);

  await A.goto(`${base}/storage`);
  check('E1 value survives a reload in the profile tab', (await who(A)) === 'alice');

  const shape = await A.evaluate(() => {
    localStorage.n = '5';
    const out = {
      keys: Object.keys(localStorage),
      length: localStorage.length,
      key0: localStorage.key(0),
      key9: localStorage.key(9),
      json: JSON.stringify(localStorage),
      named: localStorage.who,
      has: 'who' in localStorage,
      missing: localStorage.missing,
      viaNamedSet: localStorage.getItem('n'),
      viaProto: Storage.prototype.getItem.call(localStorage, 'who'),
      instance: localStorage instanceof Storage,
      tag: Object.prototype.toString.call(localStorage),
    };
    delete localStorage.n;
    out.afterDelete = localStorage.getItem('n');
    return out;
  });
  check('E1 Object.keys / length / key() show only this profile', JSON.stringify(shape.keys) === '["who","n"]' && shape.length === 2 && shape.key0 === 'who' && shape.key9 === null, JSON.stringify([shape.keys, shape.length, shape.key0, shape.key9]));
  check('E1 JSON.stringify, named access, `in`, missing key', shape.json === '{"who":"alice","n":"5"}' && shape.named === 'alice' && shape.has === true && shape.missing === undefined, shape.json);
  check('E1 named set, delete, Storage.prototype.call, instanceof, toString tag', shape.viaNamedSet === '5' && shape.afterDelete === null && shape.viaProto === 'alice' && shape.instance && shape.tag === '[object Storage]', JSON.stringify(shape));

  await A.evaluate(() => localStorage.clear());
  const after = await A.evaluate(() => localStorage.length);
  check('E1 clear() in the profile tab leaves the other tabs alone', after === 0 && (await who(B)) === 'bob' && (await who(C)) === 'carol', `A.length=${after}`);

  const raw = await C.evaluate(() => localStorage.getItem('__mlx_p2__who'));
  check('E1 the real store holds the profile value under a prefixed key', raw === 'bob', String(raw));

  // ---- storage events ----
  const A2promise = context.waitForEvent('page');
  await A.evaluate((u) => window.open(u), `${base}/storage`);
  const A2 = await A2promise;
  await A2.waitForLoadState('domcontentloaded');
  const listen = (page) => page.evaluate(() => {
    window.__events = [];
    window.addEventListener('storage', (e) => window.__events.push({ key: e.key, ownArea: e.storageArea === localStorage }));
  });
  await listen(A);
  await listen(B);
  await A2.evaluate(() => localStorage.setItem('shared', '1')); // same profile as A
  await C.evaluate(() => localStorage.setItem('raw', '1')); // no profile
  await sleep(400);
  const eventsA = await A.evaluate(() => window.__events);
  const eventsB = await B.evaluate(() => window.__events);
  check('E1 storage event: same-profile tab gets it with the plain key, other profiles and raw keys are dropped', JSON.stringify(eventsA) === '[{"key":"shared","ownArea":true}]' && eventsB.length === 0, `A=${JSON.stringify(eventsA)} B=${JSON.stringify(eventsB)}`);
  await A2.close();

  // ---- IndexedDB ----
  const idbPut = (page, value) => page.evaluate((v) => new Promise((resolve, reject) => {
    const req = indexedDB.open('app', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(v, 'who');
      tx.oncomplete = () => { const name = db.name; db.close(); resolve(name); };
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  }), value);
  const idbGet = (page) => page.evaluate(() => new Promise((resolve, reject) => {
    const req = indexedDB.open('app', 1);
    let upgraded = false;
    req.onupgradeneeded = () => { upgraded = true; req.result.createObjectStore('kv'); };
    req.onsuccess = () => {
      const db = req.result;
      const get = db.transaction('kv').objectStore('kv').get('who');
      get.onsuccess = () => { db.close(); resolve({ value: get.result ?? null, upgraded }); };
    };
    req.onerror = () => reject(req.error);
  }));

  const dbName = await idbPut(A, 'alice');
  const bFirst = await idbGet(B);
  check('E2 database name shown to the page has no prefix', dbName === 'app', dbName);
  check('E2 other profile starts with a fresh database', bFirst.value === null && bFirst.upgraded === true, JSON.stringify(bFirst));
  await idbPut(B, 'bob');
  await idbPut(C, 'carol');
  const [aGet, bGet, cGet] = [await idbGet(A), await idbGet(B), await idbGet(C)];
  check('E2 each profile keeps its own IndexedDB data', aGet.value === 'alice' && bGet.value === 'bob' && cGet.value === 'carol', `${aGet.value}/${bGet.value}/${cGet.value}`);
  const names = await A.evaluate(async () => (await indexedDB.databases()).map((d) => d.name));
  check('E2 indexedDB.databases() lists only this profile, unprefixed', JSON.stringify(names) === '["app"]', JSON.stringify(names));
  await A.evaluate(() => new Promise((resolve) => { const r = indexedDB.deleteDatabase('app'); r.onsuccess = resolve; r.onerror = resolve; r.onblocked = resolve; }));
  check('E2 deleteDatabase only removes this profile\'s copy', (await idbGet(B)).value === 'bob' && (await idbGet(C)).value === 'carol');

  // ---- document.cookie ----
  const docCookie = (page) => page.evaluate(() => document.cookie);
  const echoCookie = (page) => page.evaluate(async () => (await (await fetch('/echo')).json()).cookie);

  await A.goto(`${base}/login?user=alice`); // httpOnly session cookie
  await A.goto(`${base}/jscookie?name=theme&value=dark`); // script-readable cookie from the server
  await until(async () => (await worker.evaluate((t) => globalThis.mlx.engine.documentCookie(t, 'http://localhost/'), idA)) === 'theme=dark');
  await A.goto(`${base}/cookiefirst`);
  const first = await A.evaluate(() => document.documentElement.dataset.cookieAtFirst);
  check('E3 first page script already sees the server-set cookie (Server-Timing snapshot)', first === 'theme=dark', JSON.stringify(first));
  check('E3 httpOnly cookie is invisible to document.cookie but still sent', !(await docCookie(A)).includes('sid') && (await echoCookie(A)).includes('sid=alice'), await docCookie(A));

  await A.evaluate(() => fetch('/jscookie?name=lang&value=en'));
  const pushed = await until(async () => (await docCookie(A)).includes('lang=en'));
  check('E3 cookie set by a later fetch response shows up in document.cookie (push)', pushed, await docCookie(A));

  const written = await A.evaluate(() => { document.cookie = 'js=1; path=/'; return document.cookie; });
  check('E3 document.cookie write is visible immediately', written.includes('js=1'), written);
  const sent = await until(async () => (await echoCookie(A)).includes('js=1'));
  check('E3 script-written cookie is sent with requests', sent, await echoCookie(A));

  const deleted = await A.evaluate(() => { document.cookie = 'js=; path=/; max-age=0'; return document.cookie; });
  const stopped = await until(async () => !(await echoCookie(A)).includes('js='));
  check('E3 deleting via max-age=0 works for reads and requests', !deleted.includes('js=') && stopped, deleted);

  const blocked = await A.evaluate(() => { document.cookie = 'h=1; HttpOnly'; return document.cookie; });
  check('E3 script cannot create an httpOnly cookie', !blocked.includes('h=1'), blocked);

  const realCookies = (await context.cookies(base)).map((c) => c.name);
  check('E3 none of this reached the real cookie store', !['sid', 'theme', 'lang', 'js', 'h'].some((n) => realCookies.includes(n)), JSON.stringify(realCookies));

  await B.goto(`${base}/cookiefirst`);
  await C.goto(`${base}/cookiefirst`);
  const bFirstCookie = await B.evaluate(() => document.documentElement.dataset.cookieAtFirst);
  const cCookie = await docCookie(C);
  check('E3 other profile and the normal tab do not see profile A\'s cookies', bFirstCookie === '' && !/theme|lang|js/.test(cCookie), `B=${JSON.stringify(bFirstCookie)} C=${JSON.stringify(cCookie)}`);

  // ---- normal tabs untouched ----
  const nativeCheck = await C.evaluate(() => ({
    cookie: Object.getOwnPropertyDescriptor(Document.prototype, 'cookie').get.toString().includes('[native code]'),
    getItem: Storage.prototype.getItem.toString().includes('[native code]'),
    idb: IDBFactory.prototype.open.toString().includes('[native code]'),
  }));
  check('E4 a tab without a profile keeps every native API untouched', nativeCheck.cookie && nativeCheck.getItem && nativeCheck.idb, JSON.stringify(nativeCheck));
} catch (err) {
  console.log(`SHIM SPIKE ERROR: ${err.stack}`);
  process.exitCode = 1;
} finally {
  await context.close();
  server.close();
}

const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
if (failed) process.exitCode = 1;
