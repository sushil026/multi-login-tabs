// Browser integration test for the failure modes: worker restart, extension-reload state loss, rule-budget overflow.
// Note: the real chrome.runtime.reload() and real worker idling cannot be automated here (see TASKS.md), so
// `mlx.simulateRestart` rebuilds the engine from storage exactly as a freshly started worker does.
import path from 'node:path';
import { extPath, launchWithExtension } from './launch.mjs';
import { startEchoServer } from './echo-server.mjs';

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, ms = 4000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await sleep(60);
  }
  return last;
}
const cookiesOf = (header) => Object.fromEntries(header.split('; ').filter(Boolean).map((p) => p.split('=')));

const { server, base } = await startEchoServer();
const { context, worker } = await launchWithExtension(path.join(extPath, '.spike-profile', `resil-${Date.now()}`));

try {
  await worker.evaluate(() => globalThis.mlx.ready);
  const tabIdFor = (part) => worker.evaluate(async (p) => (await chrome.tabs.query({})).find((t) => t.url?.includes(p))?.id, part);
  const profileOf = (id) => worker.evaluate((t) => globalThis.mlx.engine.profileOfTab(t), id);
  const assign = (id, profile) => worker.evaluate(([t, p]) => globalThis.mlx.assign(t, p), [id, profile]);
  const echo = async (page) => JSON.parse(await (await page.goto(`${base}/echo`)).text());

  const real = await context.newPage();
  await real.goto(`${base}/login?user=carol`); // the real browser login
  const A = await context.newPage();
  await A.goto(`${base}/blank?t=A`);
  const idA = await tabIdFor('t=A');
  await assign(idA, 'p2');
  await A.goto(`${base}/login?user=alice`);
  const first = await echo(A);
  check('baseline: profile tab sends alice, not the real carol', cookiesOf(first.cookie).sid === 'alice');

  // ---- worker restart with state kept (what happens when an idle worker is woken) ----
  await worker.evaluate(() => globalThis.mlx.simulateRestart());
  const w1 = await echo(A);
  const w2 = await echo(A);
  check('worker restart: the tab keeps its profile and login', (await profileOf(idA)) === 'p2' && cookiesOf(w1.cookie).sid === 'alice', w1.cookie);
  check('worker restart: a cookie rotated after the restart is still captured and sent back', cookiesOf(w2.cookie).rot === String(w1.rotation), `sent ${cookiesOf(w2.cookie).rot}, server set ${w1.rotation}`);

  // ---- extension-reload state loss: tab map and rules gone, tab group remains ----
  const W = await context.newPage();
  await W.goto(`${base}/blank?t=W`);
  const idW = await tabIdFor('t=W');
  await worker.evaluate(async (t) => {
    const group = await chrome.tabs.group({ tabIds: [t] });
    await chrome.tabGroups.update(group, { title: 'Work', color: 'blue' }); // someone's own group, not ours
  }, idW);
  const groupBefore = await worker.evaluate(async (t) => (await chrome.tabs.get(t)).groupId, idA);

  await worker.evaluate(() => globalThis.mlx.simulateRestart({ clearSession: true }));
  const leaked = await echo(A);
  check('after state loss the tab (still in its "User 2" group) sends the REAL cookie: the problem being fixed', (await profileOf(idA)) === null && cookiesOf(leaked.cookie).sid === 'carol', leaked.cookie);

  const timeOrigin = await A.evaluate(() => performance.timeOrigin);
  await worker.evaluate(() => globalThis.mlx.reconcileTabs());
  const reattached = await until(async () => (await profileOf(idA)) === 'p2');
  const reloaded = await until(async () => {
    const now = await A.evaluate(() => performance.timeOrigin).catch(() => null); // fails mid-reload: try again
    return now !== null && now !== timeOrigin;
  });
  const afterFix = await echo(A);
  const groupAfter = await worker.evaluate(async (t) => (await chrome.tabs.get(t)).groupId, idA);
  check('reconcile re-attaches the tab to its profile and reloads it', Boolean(reattached) && Boolean(reloaded) && cookiesOf(afterFix.cookie).sid === 'alice', afterFix.cookie);
  check('reconcile reuses the existing tab group and leaves other groups alone', groupAfter === groupBefore && (await profileOf(idW)) === null && (await worker.evaluate(async (t) => (await chrome.tabs.get(t)).groupId > 0, idW)), `group ${groupBefore} -> ${groupAfter}`);

  // ---- rule budget ----
  const limits = await worker.evaluate(() => ({ regex: chrome.declarativeNetRequest.MAX_NUMBER_OF_REGEX_RULES, session: chrome.declarativeNetRequest.MAX_NUMBER_OF_SESSION_RULES }));
  const started = Date.now();
  await worker.evaluate(async ([tab, origin]) => {
    const engine = globalThis.mlx.engine;
    for (let i = 0; i < 600; i += 1) {
      await engine.captureSetCookies(tab, `https://h${i}.flood.test/`, [`k${i}=v; Path=/`]);
      if (i % 50 === 0) await engine.touchPage(tab, `${origin}/`); // the user keeps using the app
    }
  }, [idA, base]);
  const floodMs = Date.now() - started;

  const rules = await worker.evaluate(() => chrome.declarativeNetRequest.getSessionRules());
  const regexUsed = rules.filter((r) => r.condition.regexFilter).length;
  check('flood of 600 hosts: regex rules stay under the browser limit', regexUsed <= limits.regex - 20 && rules.length <= limits.session, `${regexUsed}/${limits.regex} regex, ${rules.length}/${limits.session} total, ${floodMs} ms`);

  const warning = await worker.evaluate(() => globalThis.mlx.engine.warning());
  check('flood: a warning is recorded', /removed/.test(warning ?? ''), warning);

  const stillIn = await echo(A);
  check('flood: the login of the site in use survives (protected by recency)', cookiesOf(stillIn.cookie).sid === 'alice', stillIn.cookie);

  const B = await context.newPage();
  await B.goto(`${base}/blank?t=B`);
  const idB = await tabIdFor('t=B');
  await assign(idB, 'p3');
  const realBefore = JSON.stringify((await context.cookies(base)).map((c) => `${c.name}=${c.value}`).sort());
  const bEcho = await echo(B);
  const realAfter = JSON.stringify((await context.cookies(base)).map((c) => `${c.name}=${c.value}`).sort());
  check('flood: a profile tab created afterwards is still isolated (no real cookies sent, none stored)', !bEcho.cookie.includes('carol') && realBefore === realAfter, `sent "${bEcho.cookie}"`);

  // ---- popup shows the warning ----
  const extId = new URL(worker.url()).host;
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html?tabId=${idA}`);
  await popup.locator('li.profile').first().waitFor();
  const shown = await popup.locator('#warning').isVisible();
  const text = await popup.locator('#warning-text').textContent();
  await popup.getByRole('button', { name: 'Dismiss', exact: true }).click();
  const hidden = await until(async () => !(await popup.locator('#warning').isVisible()));
  check('the popup shows the warning and Dismiss clears it', shown && /removed/.test(text) && Boolean(hidden) && (await worker.evaluate(() => globalThis.mlx.engine.warning())) === null, text);

  // ---- the real browser refuses an oversized rule set (eviction switched off so the true limit is hit) ----
  await worker.evaluate(() => globalThis.mlx.simulateRestart({ maxRegexRules: 5000 }));
  await worker.evaluate(async (tab) => {
    for (let i = 0; i < 90; i += 1) await globalThis.mlx.engine.captureSetCookies(tab, `https://extra${i}.flood.test/`, [`x${i}=v; Path=/`]);
  }, idA);
  const refusal = await worker.evaluate(() => globalThis.mlx.engine.warning());
  const rulesNow = await worker.evaluate(() => chrome.declarativeNetRequest.getSessionRules());
  check('real refusal: the browser rejects the oversized rule set and the engine reports it', /refused/.test(refusal ?? ''), refusal);
  check('real refusal: base rules are installed instead (no regex rules left)', rulesNow.length > 0 && rulesNow.every((r) => !r.condition.regexFilter), `${rulesNow.length} rules`);

  const realBeforeRefusal = JSON.stringify((await context.cookies(base)).map((c) => `${c.name}=${c.value}`).sort());
  const [aRefused, bRefused] = [await echo(A), await echo(B)];
  const realAfterRefusal = JSON.stringify((await context.cookies(base)).map((c) => `${c.name}=${c.value}`).sort());
  check('real refusal: profile tabs send no cookies at all and store nothing real (safe, not leaking)', aRefused.cookie === '' && bRefused.cookie === '' && realBeforeRefusal === realAfterRefusal, `A="${aRefused.cookie}" B="${bRefused.cookie}"`);
} catch (err) {
  console.log(`RESILIENCE SPIKE ERROR: ${err.stack}`);
  process.exitCode = 1;
} finally {
  await context.close();
  server.close();
}

const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
if (failed) process.exitCode = 1;
