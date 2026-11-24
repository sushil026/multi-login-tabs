// Browser integration test (Phase D7): the real extension in Brave against the echo server.
import path from 'node:path';
import { extPath, launchWithExtension } from './launch.mjs';
import { startEchoServer } from './echo-server.mjs';

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`);
};
const cookiesOf = (header) => Object.fromEntries(header.split('; ').filter(Boolean).map((p) => p.split('=')));

const { server, base } = await startEchoServer();
const dir = path.join(extPath, '.spike-profile', `int-${Date.now()}`);
const { context, worker } = await launchWithExtension(dir);

try {
  await worker.evaluate(() => globalThis.mlx.ready);
  const tabIdFor = (part) =>
    worker.evaluate(async (p) => (await chrome.tabs.query({})).find((t) => t.url?.includes(p))?.id, part);
  const assign = (tabId, profileId) => worker.evaluate(([t, p]) => globalThis.mlx.assign(t, p), [tabId, profileId]);
  const echo = async (page) => JSON.parse(await (await page.goto(`${base}/echo`)).text());

  const pageA = await context.newPage();
  const pageB = await context.newPage();
  const pageC = await context.newPage();
  await pageA.goto(`${base}/blank?t=A`);
  await pageB.goto(`${base}/blank?t=B`);
  await pageC.goto(`${base}/blank?t=C`);
  const [idA, idB] = [await tabIdFor('t=A'), await tabIdFor('t=B')];
  await assign(idA, 'p1');
  await assign(idB, 'p2');

  // Three users log in on the same site: A and B through profiles, C with the normal browser cookies.
  await pageA.goto(`${base}/login?user=alice`);
  await pageB.goto(`${base}/login?user=bob`);
  await pageC.goto(`${base}/login?user=carol`);

  const a1 = cookiesOf((await echo(pageA)).cookie);
  const b1 = cookiesOf((await echo(pageB)).cookie);
  const c1 = cookiesOf((await echo(pageC)).cookie);
  check('D4 profile tab A is logged in as alice', a1.sid === 'alice', JSON.stringify(a1));
  check('D4 profile tab B is logged in as bob', b1.sid === 'bob', JSON.stringify(b1));
  check('D4 tab without profile is logged in as carol', c1.sid === 'carol', JSON.stringify(c1));

  const real = await context.cookies(base);
  check('D4 real cookie store holds only carol, never alice or bob', real.some((c) => c.value === 'carol') && !real.some((c) => ['alice', 'bob'].includes(c.value)), JSON.stringify(real.map((c) => `${c.name}=${c.value}`)));

  // Rotation: the cookie the server rotates on every response must come back on the next request.
  const first = await echo(pageA);
  const second = await echo(pageA);
  check('D4 rotated cookie is captured and sent back', cookiesOf(second.cookie).rot === String(first.rotation), `sent ${cookiesOf(second.cookie).rot}, server had set ${first.rotation}`);

  // Reload keeps the session (what a refresh-cookie app relies on).
  const reloaded = cookiesOf((await echo(pageB)).cookie);
  check('D4 profile tab keeps its login across reloads', reloaded.sid === 'bob');

  // D5: a tab opened from a profile tab inherits the profile. Repeat to expose the first-request race.
  await pageA.goto(`${base}/blank?t=opener`);
  const attempts = 6;
  let inherited = 0;
  let leaked = 0;
  for (let i = 0; i < attempts; i += 1) {
    const [child] = await Promise.all([context.waitForEvent('page'), pageA.evaluate((u) => window.open(u), `${base}/echo`)]);
    await child.waitForLoadState('domcontentloaded');
    const body = JSON.parse(await child.evaluate(() => document.body.innerText));
    const sid = cookiesOf(body.cookie).sid;
    if (sid === 'alice') inherited += 1;
    else if (sid === 'carol') leaked += 1;
    await child.close();
  }
  check('D5 child tab inherits the opener profile on its first request', inherited === attempts, `inherited ${inherited}/${attempts}, leaked real cookie ${leaked}/${attempts}`);

  // D6: tab group and badge.
  const visual = await worker.evaluate(async (tabId) => {
    const tab = await chrome.tabs.get(tabId);
    const group = tab.groupId > 0 ? await chrome.tabGroups.get(tab.groupId) : null;
    return { title: group?.title, color: group?.color, badge: await chrome.action.getBadgeText({ tabId }) };
  }, idA);
  check('D6 profile tab is in a color-coded group named after the profile', visual.title === 'User 1' && visual.color === 'blue', JSON.stringify(visual));
  check('D6 toolbar badge shows the profile number', visual.badge === '1', visual.badge);

  // D2: closing a tab drops it from the map and the rules.
  await pageB.close();
  await new Promise((r) => setTimeout(r, 500));
  const gone = await worker.evaluate((t) => globalThis.mlx.engine.profileOfTab(t), idB);
  check('D2 closed tab is forgotten', gone === null);
} catch (err) {
  console.log(`SPIKE ERROR: ${err.stack}`);
  process.exitCode = 1;
} finally {
  await context.close();
  server.close();
}

const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
if (failed) process.exitCode = 1;
