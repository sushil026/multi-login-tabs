// Makes store/screenshot-1.png (1280x800): the real popup, captured from the running extension with three profiles
// logged in on a local test server, placed next to a short headline. Uses the source build (needs the test hook).
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { launchWithExtension, repoPath } from '../test/launch.mjs';
import { startEchoServer } from '../test/echo-server.mjs';

const { server, base } = await startEchoServer();
const { context, worker } = await launchWithExtension(path.join(repoPath, '.spike-profile', `shots-${Date.now()}`));
let popupPng;
try {
  await worker.evaluate(() => globalThis.mlx.ready);
  const ids = {};
  for (const [profile, user] of [['p1', 'alice'], ['p2', 'bob'], ['p3', 'carol']]) {
    const page = await context.newPage();
    await page.goto(`${base}/blank?t=${profile}`);
    ids[profile] = await worker.evaluate(async (p) => (await chrome.tabs.query({})).find((t) => t.url?.includes(`t=${p}`)).id, profile);
    await worker.evaluate(([t, p]) => globalThis.mlx.assign(t, p), [ids[profile], profile]);
    await page.goto(`${base}/login?user=${user}`);
  }
  const extId = new URL(worker.url()).host;
  const popup = await context.newPage();
  await popup.emulateMedia({ colorScheme: 'light' });
  await popup.setViewportSize({ width: 404, height: 560 });
  await popup.goto(`chrome-extension://${extId}/popup.html?tabId=${ids.p2}`);
  await popup.locator('li.profile').first().waitFor();
  popupPng = await popup.screenshot();
} finally {
  await context.close();
  server.close();
}

const html = `<body style="margin:0;width:1280px;height:800px;background:linear-gradient(135deg,#0f172a,#1e293b);font-family:Segoe UI,system-ui,sans-serif;color:#f8fafc;display:flex;align-items:center;justify-content:center;gap:72px">
  <div style="width:560px">
    <div style="font-size:60px;font-weight:700;line-height:1.1">Three logins.<br>One window.</div>
    <p style="font-size:26px;line-height:1.45;color:#cbd5e1;margin:28px 0 0">Give each tab its own session on any site. No incognito windows, no second browser.</p>
    <ul style="font-size:22px;line-height:1.9;color:#e2e8f0;padding-left:26px;margin:24px 0 0">
      <li>Separate cookies and storage per profile</li>
      <li>Color-coded tab groups and a badge</li>
      <li>Everything stays on your device</li>
    </ul>
  </div>
  <img src="data:image/png;base64,${popupPng.toString('base64')}" style="width:404px;border-radius:14px;box-shadow:0 24px 60px rgba(0,0,0,.5)">
</body>`;

const browser = await chromium.launch({ executablePath: process.env.BROWSER_PATH ?? 'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.setContent(html);
  writeFileSync(path.join(repoPath, 'store', 'screenshot-1.png'), await page.screenshot({ type: 'png' }));
  console.log('store/screenshot-1.png (1280x800)');
} finally {
  await browser.close();
}
