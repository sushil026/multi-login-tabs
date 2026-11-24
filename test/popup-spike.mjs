// Browser integration test (Phase F): drives the real popup UI. The popup page is opened as a normal tab with
// ?tabId=<target> so it acts on a chosen tab instead of "the active tab".
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

const { server, base } = await startEchoServer();
const { context, worker } = await launchWithExtension(path.join(extPath, '.spike-profile', `popup-${Date.now()}`));

try {
  await worker.evaluate(() => globalThis.mlx.ready);
  const extId = new URL(worker.url()).host;
  const tabsMatching = (part) =>
    worker.evaluate(async (p) => (await chrome.tabs.query({})).filter((t) => t.url?.includes(p)).map((t) => t.id), part);
  const profileOf = (tabId) => worker.evaluate((t) => globalThis.mlx.engine.profileOfTab(t), tabId);
  const groupOf = (tabId) =>
    worker.evaluate(async (t) => {
      const tab = await chrome.tabs.get(t);
      const group = tab.groupId > 0 ? await chrome.tabGroups.get(tab.groupId) : null;
      return { title: group?.title ?? null, color: group?.color ?? null, badge: await chrome.action.getBadgeText({ tabId: t }) };
    }, tabId);
  const echoCookie = async (page) => JSON.parse(await (await page.goto(`${base}/echo`)).text()).cookie;

  // The tab we manage, and the popup pointed at it.
  const target = await context.newPage();
  await target.goto(`${base}/blank?t=target`);
  const [targetId] = await tabsMatching('t=target');
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html?tabId=${targetId}`);
  const row = (id) => popup.locator(`li.profile[data-id="${id}"]`);
  const button = (id, name) => row(id).getByRole('button', { name, exact: true });

  // ---- F1: layout ----
  await popup.locator('li.profile').first().waitFor();
  const names = await popup.locator('li.profile .name').allTextContents();
  check('F1 popup lists the four default profiles', JSON.stringify(names) === '["User 1","User 2","User 3","User 4"]', JSON.stringify(names));
  check('F1 popup says the tab uses the normal session', (await popup.locator('#current').textContent()).includes('normal browser session'));
  check('F1 address box is prefilled from the target tab', (await popup.locator('#url').inputValue()) === `${base}/blank?t=target`);

  // ---- F2: assign the current tab ----
  const before = await target.evaluate(() => performance.timeOrigin);
  await button('p2', 'Use in this tab').click();
  await until(async () => (await profileOf(targetId)) === 'p2');
  const reloaded = await until(async () => (await target.evaluate(() => performance.timeOrigin)) !== before);
  const current = await popup.locator('#current').textContent();
  const shimmed = await target.evaluate(() => !Object.getOwnPropertyDescriptor(Document.prototype, 'cookie').get.toString().includes('[native code]'));
  check('F2 "Use in this tab" assigns the profile and reloads the tab', (await profileOf(targetId)) === 'p2' && Boolean(reloaded) && shimmed, `profile=${await profileOf(targetId)} reloaded=${Boolean(reloaded)} shim=${shimmed}`);
  check('F2 popup now shows User 2 as in use', current.includes('User 2') && (await row('p2').getAttribute('aria-current')) === 'true' && await button('p2', 'In use here').isDisabled(), current);

  // ---- F2: open a new tab as a profile ----
  await popup.locator('#url').fill(`${base}/login?user=carol3`);
  const opened = context.waitForEvent('page');
  await button('p3', 'New tab').click();
  const p3page = await opened;
  await p3page.waitForLoadState('domcontentloaded');
  const [p3id] = await until(async () => {
    const ids = await tabsMatching('user=carol3');
    return ids.length ? ids : null;
  });
  const p3cookie = await echoCookie(p3page);
  const p3group = await groupOf(p3id);
  const realAfterP3 = (await context.cookies(base)).map((c) => c.name);
  check('F2 "New tab" opens the address as that profile, logged in separately', (await profileOf(p3id)) === 'p3' && p3cookie.includes('sid=carol3') && !realAfterP3.includes('sid'), `${await profileOf(p3id)} ${p3cookie}`);
  check('F2 the new tab is grouped and badged', p3group.title === 'User 3' && p3group.color === 'green' && p3group.badge === '3', JSON.stringify(p3group));

  // ---- F2: open in all profiles ----
  await popup.locator('#url').fill(`${base}/login?user=everyone`);
  await popup.locator('#open-all').click();
  const everyone = await until(async () => {
    const ids = await tabsMatching('user=everyone');
    return ids.length === 4 ? ids : null;
  });
  const assigned = everyone ? (await Promise.all(everyone.map(profileOf))).sort() : [];
  check('F2 "Open in all profiles" opens one tab per profile', JSON.stringify(assigned) === '["p1","p2","p3","p4"]', JSON.stringify(assigned));

  // ---- invalid address ----
  const tabCountBefore = (await worker.evaluate(async () => (await chrome.tabs.query({})).length));
  await popup.locator('#url').fill('notaurl');
  await button('p1', 'New tab').click();
  await sleep(300);
  const errorText = await popup.locator('#message').textContent();
  const tabCountAfter = (await worker.evaluate(async () => (await chrome.tabs.query({})).length));
  check('F2 a bad address shows an error and opens nothing', errorText.includes('full address') && (await popup.locator('#message').getAttribute('class')).includes('error') && tabCountAfter === tabCountBefore, errorText);

  // ---- F3: add, rename, recolor ----
  await popup.locator('#add').click();
  await popup.locator('li.profile').nth(4).waitFor();
  const fifth = await popup.locator('li.profile .name').nth(4).textContent();
  check('F3 "Add profile" creates "User 5"', fifth === 'User 5', fifth);

  await popup.locator('#url').fill(`${base}/blank?t=p5tab`);
  const p5opened = context.waitForEvent('page');
  await button('p5', 'New tab').click();
  await p5opened;
  const [p5id] = await until(async () => {
    const ids = await tabsMatching('t=p5tab');
    return ids.length ? ids : null;
  });

  await button('p5', 'Edit').click();
  const nameBox = row('p5').getByRole('textbox', { name: /Name for/ });
  await nameBox.fill('QA admin');
  await row('p5').locator('input[value="pink"]').check({ force: true });
  await row('p5').getByRole('button', { name: 'Save', exact: true }).click();
  const renamed = await until(async () => {
    const g = await groupOf(p5id);
    return g.title === 'QA admin' && g.color === 'pink' ? g : null;
  });
  check('F3 rename and recolor update the popup, tab group and badge', Boolean(renamed) && (await popup.locator('li.profile .name').nth(4).textContent()) === 'QA admin', JSON.stringify(renamed));

  // ---- F3: clear cookies for this site ----
  await button('p3', 'Edit').click();
  await row('p3').getByRole('button', { name: /Clear cookies for localhost/ }).click();
  const cleared = await until(async () => !(await echoCookie(p3page)).includes('sid='));
  check('F3 "Clear cookies for <site>" logs that profile out of the site only', cleared);

  // ---- F3: delete needs two clicks (one editor is open at a time, so reopen User 5's) ----
  await button('p5', 'Edit').click();
  const deleteButton = row('p5').getByRole('button', { name: /Delete profile|Click again/ });
  await deleteButton.click();
  const armedText = await deleteButton.textContent();
  const stillThere = (await popup.locator('li.profile').count()) === 5;
  check('F3 first click on Delete only arms it', armedText === 'Click again to confirm' && stillThere, armedText);
  await deleteButton.click();
  await until(async () => (await popup.locator('li.profile').count()) === 4);
  const afterDelete = await groupOf(p5id);
  check('F3 second click deletes the profile and frees its tabs', (await profileOf(p5id)) === null && afterDelete.title === null && afterDelete.badge === '', JSON.stringify([await profileOf(p5id), afterDelete]));

  // ---- F2: remove the profile from the target tab ----
  await popup.getByRole('button', { name: 'Remove from this tab' }).click();
  await until(async () => (await profileOf(targetId)) === null);
  // the popup re-renders only after the background answered and the state was re-read, so wait for the text
  const backToNormal = await until(async () => (await popup.locator('#current').textContent()).includes('normal browser session'));
  check('F2 "Remove from this tab" puts it back on the normal session', (await profileOf(targetId)) === null && Boolean(backToNormal));
} catch (err) {
  console.log(`POPUP SPIKE ERROR: ${err.stack}`);
  process.exitCode = 1;
} finally {
  await context.close();
  server.close();
}

const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
if (failed) process.exitCode = 1;
