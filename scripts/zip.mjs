// Zips dist/ into multi-login-tabs-<version>.zip with manifest.json at the zip root, using the tar that ships
// with Windows 10+ (bsdtar). Refuses to overwrite an existing zip. Lists the result so entry names can be checked.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { dist, root, SHIPPED } from './build.mjs';

const { version } = JSON.parse(readFileSync(path.join(dist, 'manifest.json'), 'utf8'));
const zip = path.join(root, `multi-login-tabs-${version}.zip`);
if (existsSync(zip)) throw new Error(`${path.basename(zip)} already exists: bump the version in manifest.json or delete it yourself`);

// Git Bash puts GNU tar (which cannot write zips) first on PATH; Windows' own bsdtar can.
const windowsTar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
const tar = existsSync(windowsTar) ? windowsTar : 'tar';

execFileSync(tar, ['-a', '-c', '-f', zip, '-C', dist, ...SHIPPED], { stdio: 'inherit' });
const entries = execFileSync(tar, ['-t', '-f', zip], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
const bad = entries.filter((e) => e.includes('\\') || e.startsWith('./') || /^(test|scripts|store)\//.test(e));
if (bad.length || !entries.includes('manifest.json')) throw new Error(`unexpected zip entries: ${bad.join(', ') || 'no manifest.json at root'}`);
console.log(`${path.basename(zip)}: ${entries.length} entries, manifest.json at root`);
