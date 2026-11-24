// Shared test helper: launch a Chromium-family browser with the extension loaded.
// playwright-core is a devDependency (npm install). BROWSER_PATH overrides the default install locations below.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright-core';

const here = path.dirname(fileURLToPath(import.meta.url));
// EXT_PATH points the tests at another build of the extension (for example dist/, the store package).
export const extPath = path.resolve(process.env.EXT_PATH ?? path.join(here, '..'));
export const repoPath = path.resolve(here, '..');

const CANDIDATES = {
  brave: 'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe',
  chrome: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  edge: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
};

// Returns { context, worker, browserName }. BROWSER=brave|chrome|edge picks one (default brave).
export async function launchWithExtension(userDataDir, extraArgs = []) {
  const browserName = process.env.BROWSER ?? 'brave';
  const executablePath = process.env.BROWSER_PATH ?? CANDIDATES[browserName];
  if (!existsSync(executablePath)) throw new Error(`${browserName} not found at ${executablePath}`);

  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath,
    headless: false,
    args: [`--disable-extensions-except=${extPath}`, `--load-extension=${extPath}`, ...extraArgs],
  });

  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 8000 });
  return { context, worker, browserName };
}
