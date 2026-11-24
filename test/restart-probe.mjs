// Probe (advisor item 4): can the idle service worker be stopped, and does the wake-up path keep a session alive?
import path from 'node:path';
import { extPath, launchWithExtension } from './launch.mjs';
import { startEchoServer } from './echo-server.mjs';

const PORT = 9333;
const { server, base } = await startEchoServer();
const { context, worker } = await launchWithExtension(path.join(extPath, '.spike-profile', `restart-${Date.now()}`), [`--remote-debugging-port=${PORT}`]);
const cookieOf = async (page) => JSON.parse(await (await page.goto(`${base}/echo`)).text());
try {
  await worker.evaluate(() => globalThis.mlx.ready);
  const real = await context.newPage();
  await real.goto(`${base}/login?user=carol`);
  const tab = await context.newPage();
  await tab.goto(`${base}/blank?t=A`);
  const id = await worker.evaluate(async () => (await chrome.tabs.query({})).find((t) => t.url?.includes('t=A')).id);
  await worker.evaluate((t) => globalThis.mlx.assign(t, 'p2'), id);
  await tab.goto(`${base}/login?user=alice`);
  console.log('before stop, tab sends:', (await cookieOf(tab)).cookie);

  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  console.log('targets:', targets.map((t) => `${t.type} ${t.url.slice(0, 60)}`));
  const sw = targets.find((t) => t.type === 'service_worker' && t.url.endsWith('background.js'));
  let closed = false;
  worker.on('close', () => { closed = true; });
  console.log('close request:', sw ? (await (await fetch(`http://127.0.0.1:${PORT}/json/close/${sw.id}`)).text()) : 'no worker target');
  await new Promise((r) => setTimeout(r, 2000));
  console.log('worker closed:', closed, '| workers now:', context.serviceWorkers().length);

  const woke = context.waitForEvent('serviceworker', { timeout: 8000 }).catch(() => null);
  const after = await cookieOf(tab);
  const worker2 = await woke;
  console.log('after wake, tab sends:', after.cookie, '| new worker appeared:', Boolean(worker2));
  const again = await cookieOf(tab);
  console.log('next request sends:', again.cookie, '| rotation', after.rotation, '->', again.rotation);
} finally {
  await context.close();
  server.close();
}
