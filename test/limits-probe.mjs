// Probe: what are the DNR limits in this browser, and what happens to the extension when a profile exceeds them?
import path from 'node:path';
import { extPath, launchWithExtension } from './launch.mjs';

const { context, worker } = await launchWithExtension(path.join(extPath, '.spike-profile', `limits-${Date.now()}`));
try {
  await worker.evaluate(() => globalThis.mlx.ready);
  console.log(JSON.stringify(await worker.evaluate(() => ({
    MAX_NUMBER_OF_REGEX_RULES: chrome.declarativeNetRequest.MAX_NUMBER_OF_REGEX_RULES,
    MAX_NUMBER_OF_SESSION_RULES: chrome.declarativeNetRequest.MAX_NUMBER_OF_SESSION_RULES,
    MAX_NUMBER_OF_UNSAFE_SESSION_RULES: chrome.declarativeNetRequest.MAX_NUMBER_OF_UNSAFE_SESSION_RULES,
  }))));
} finally {
  await context.close();
}
