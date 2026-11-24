// Visual check of the popup. Usage: node test/popup-screenshot.mjs <output.png> [light|dark]
import path from 'node:path';
import { extPath, launchWithExtension } from './launch.mjs';
import { startEchoServer } from './echo-server.mjs';

const output = process.argv[2];
const scheme = process.argv[3] ?? 'light';
if (!output) throw new Error('usage: node test/popup-screenshot.mjs <output.png> [light|dark]');

const { server, base } = await startEchoServer();
const { context, worker } = await launchWithExtension(path.join(extPath, '.spike-profile', `shot-${Date.now()}`));
try {
  await worker.evaluate(() => globalThis.mlx.ready);
  const target = await context.newPage();
  await target.goto(`${base}/blank?t=target`);
  const targetId = await worker.evaluate(async () => (await chrome.tabs.query({})).find((t) => t.url?.includes('t=target')).id);
  await worker.evaluate((t) => globalThis.mlx.assign(t, 'p2'), targetId);
  await target.goto(`${base}/login?user=alice`);
  await target.goto(`${base}/jscookie?name=theme&value=dark`);
  await worker.evaluate(() => globalThis.mlx.engine.assignTab(-5, null)); // no-op, keeps the queue ordered
  const extId = new URL(worker.url()).host;
  const popup = await context.newPage();
  await popup.emulateMedia({ colorScheme: scheme });
  await popup.setViewportSize({ width: 404, height: 560 });
  await popup.goto(`chrome-extension://${extId}/popup.html?tabId=${targetId}`);
  await popup.locator('li.profile').first().waitFor();
  await popup.locator('li.profile[data-id="p1"]').getByRole('button', { name: 'Edit', exact: true }).click();
  await popup.screenshot({ path: output });
  console.log(`saved ${output}`);
} finally {
  await context.close();
  server.close();
}
