// A4: does the unpacked extension load and start its service worker?
import path from 'node:path';
import { extPath, launchWithExtension } from './launch.mjs';

const dir = path.join(extPath, '.spike-profile', `load-${Date.now()}`);
let context;
try {
  const launched = await launchWithExtension(dir);
  context = launched.context;
  console.log(`browser: ${launched.browserName}`);
  console.log(`service worker url: ${launched.worker.url()}`);
  console.log('LOAD OK');
} catch (err) {
  console.log(`LOAD FAILED: ${err.message}`);
  process.exitCode = 1;
} finally {
  await context?.close();
}
