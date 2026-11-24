// Diagnostic for D5: replicate the integration test's setup, then trace events around a window.open child.
import path from 'node:path';
import { extPath, launchWithExtension } from './launch.mjs';
import { startEchoServer } from './echo-server.mjs';

const { server, base } = await startEchoServer();
const { context, worker } = await launchWithExtension(path.join(extPath, '.spike-profile', `diag-${Date.now()}`));
const cookiesOf = (h) => Object.fromEntries(h.split('; ').filter(Boolean).map((p) => p.split('=')));
try {
  await worker.evaluate(() => globalThis.mlx.ready);
  const idOf = (part) => worker.evaluate(async (p) => (await chrome.tabs.query({})).find((t) => t.url?.includes(p))?.id, part);
  const pageA = await context.newPage();
  const pageB = await context.newPage();
  const pageC = await context.newPage();
  await pageA.goto(`${base}/blank?t=A`);
  await pageB.goto(`${base}/blank?t=B`);
  await pageC.goto(`${base}/blank?t=C`);
  const [idA, idB, idC] = [await idOf('t=A'), await idOf('t=B'), await idOf('t=C')];
  await worker.evaluate(([a, b]) => Promise.all([globalThis.mlx.assign(a, 'p1'), globalThis.mlx.assign(b, 'p2')]), [idA, idB]);
  await pageA.goto(`${base}/login?user=alice`);
  await pageB.goto(`${base}/login?user=bob`);
  await pageC.goto(`${base}/login?user=carol`);
  await pageA.goto(`${base}/blank?t=opener`);

  await worker.evaluate(() => {
    globalThis.__log = [];
    const add = (name, extra) => globalThis.__log.push({ name, t: Math.round(performance.now()), ...extra });
    chrome.tabs.onCreated.addListener((tab) => add('tabs.onCreated', { tab: tab.id, opener: tab.openerTabId }));
    const originalUpdate = chrome.declarativeNetRequest.updateSessionRules.bind(chrome.declarativeNetRequest);
    chrome.declarativeNetRequest.updateSessionRules = async (opts) => {
      add('dnr.update.start', { removing: opts.removeRuleIds.length, adding: opts.addRules.length });
      const result = await originalUpdate(opts);
      add('dnr.update.done', {});
      return result;
    };
    chrome.webRequest.onBeforeSendHeaders.addListener((d) => add('webRequest.onBeforeSendHeaders', { tab: d.tabId, url: d.url }), { urls: ['<all_urls>'] });
  });

  for (let i = 0; i < 3; i += 1) {
    await worker.evaluate(() => { globalThis.__log = []; });
    const [child] = await Promise.all([context.waitForEvent('page'), pageA.evaluate((u) => window.open(u), `${base}/echo`)]);
    await child.waitForLoadState('domcontentloaded');
    await new Promise((r) => setTimeout(r, 600));
    const body = JSON.parse(await child.evaluate(() => document.body.innerText));
    const log = await worker.evaluate(() => globalThis.__log);
    console.log(`--- attempt ${i + 1}: child sent ${JSON.stringify(cookiesOf(body.cookie))}`);
    for (const e of log.filter((x) => !String(x.url ?? '').includes('favicon'))) console.log(JSON.stringify(e));
    await child.close();
  }
  console.log('tab ids', { idA, idB, idC });
} finally {
  await context.close();
  server.close();
}
