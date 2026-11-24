// Builds the Chrome Web Store package: copies only the runtime files into dist/ and removes the test hook
// (`globalThis.mlx`) from dist/background.js. Fails loudly instead of shipping an unstripped file.
// It never deletes anything: files are overwritten in place, and leftovers from an older build make it stop.
// Usage: node scripts/build.mjs   (or `npm run build`)
import { cpSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const dist = path.join(root, 'dist');
export const SHIPPED = ['manifest.json', 'background.js', 'popup.html', 'popup.css', 'popup.js', 'lib', 'content', 'icons'];

const START = '// @test-hook:start';
const END = '// @test-hook:end';

export function stripTestHook(source) {
  const count = (needle) => source.split(needle).length - 1;
  if (count(START) !== 1 || count(END) !== 1) throw new Error(`background.js must contain exactly one ${START} and one ${END} marker`);
  const from = source.indexOf(START);
  const to = source.indexOf(END) + END.length;
  if (to <= from) throw new Error('test-hook markers are in the wrong order');
  const stripped = source.slice(0, from) + source.slice(to).replace(/^\r?\n/, '');
  if (/globalThis\.mlx|simulateRestart/.test(stripped)) throw new Error('test hook is still present after stripping');
  return stripped;
}

export const listFiles = (dir) =>
  readdirSync(dir, { recursive: true })
    .map((f) => f.replaceAll('\\', '/'))
    .filter((f) => statSync(path.join(dir, f)).isFile())
    .sort();

export function build() {
  mkdirSync(dist, { recursive: true });
  const expected = [];
  for (const entry of SHIPPED) {
    cpSync(path.join(root, entry), path.join(dist, entry), { recursive: true });
    const source = path.join(root, entry);
    expected.push(...(statSync(source).isDirectory() ? listFiles(source).map((f) => `${entry}/${f}`) : [entry]));
  }
  const file = path.join(dist, 'background.js');
  writeFileSync(file, stripTestHook(readFileSync(file, 'utf8')));

  const stale = listFiles(dist).filter((f) => !expected.includes(f));
  if (stale.length) throw new Error(`dist/ has files that are not part of the build (delete them yourself): ${stale.join(', ')}`);
  console.log(`dist/ ready: ${expected.length} files`);
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) build();
