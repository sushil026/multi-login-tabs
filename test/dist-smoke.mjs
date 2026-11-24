// Smoke test of the STORE BUILD (dist/): the test hook is gone and the extension still isolates cookies when
// driven only through its popup. Run `npm run build` first. (The other suites need the hook, so they use the source.)
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.EXT_PATH = path.join(repo, 'dist'); // read by launch.mjs when it loads
if (!existsSync(path.join(repo, 'dist', 'manifest.json'))) throw new Error('dist/ is missing: run `npm run build` first');
const { launchWithExtension } = await import('./launch.mjs');
const { startEchoServer } = await import('./echo-server.mjs');

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await sleep(80);
  }
  return last;
}
const cookiesOf = (header) => Object.fromEntries(header.split('; ').filter(Boolean).map((p) => p.split('=')));

const { server, base } = await startEchoServer();
const { context, worker } = await launchWithExtension(path.join(repo, '.spike-profile', `dist-${Date.now()}`));

try {
  const manifest = JSON.parse(readFileSync(path.join(repo, 'dist', 'manifest.json'), 'utf8'));
  check('shipped manifest has no `tabs` permission and no test files', !manifest.permissions.includes('tabs') && !existsSync(path.join(repo, 'dist', 'test')));
  check('the worker has no test hook (globalThis.mlx)', (await worker.evaluate(() => typeof globalThis.mlx)) === 'undefined');
  const extId = new URL(worker.url()).host;

  const real = await context.newPage();
  await real.goto(`${base}/login?user=carol`);
  const A = await context.newPage();
  await A.goto(`${base}/blank?t=A`);
  const idA = await worker.evaluate(async () => (await chrome.tabs.query({})).find((t) => t.url?.includes('t=A')).id);

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html?tabId=${idA}`);
  await popup.locator('li.profile').first().waitFor();
  check('popup lists the four default profiles', (await popup.locator('li.profile').count()) === 4);

  await popup.locator('li.profile').first().getByRole('button', { name: 'Use in this tab' }).click();
  const assigned = await until(async () => (await popup.locator('#current').textContent())?.includes('User 1'));
  check('"Use in this tab" assigns the profile (popup only, no test hook)', Boolean(assigned));

  await A.goto(`${base}/login?user=alice`);
  const echo = JSON.parse(await (await A.goto(`${base}/echo`)).text());
  const realNow = (await context.cookies(base)).map((c) => `${c.name}=${c.value}`).join('; ');
  check('profile tab logs in as alice while the real browser login stays carol', cookiesOf(echo.cookie).sid === 'alice' && /sid=carol/.test(realNow), `${echo.cookie} | real: ${realNow}`);

  const icon = await popup.evaluate(async (id) => (await fetch(`chrome-extension://${id}/icons/icon-128.png`)).status, extId);
  check('the 128 px icon is served from the package', icon === 200);
} catch (err) {
  console.log(`DIST SMOKE ERROR: ${err.stack}`);
  process.exitCode = 1;
} finally {
  await context.close();
  server.close();
}

const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
if (failed) process.exitCode = 1;
