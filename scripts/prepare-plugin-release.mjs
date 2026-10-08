import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { releaseKey } from '../packages/myco/scripts/release-policy.mjs';

const [version, ...extra] = process.argv.slice(2);
if (!releaseKey(version ?? '') || extra.length) {
  throw new Error('usage: node scripts/prepare-plugin-release.mjs <major.minor.patch[-alpha.N|-beta.N|-rc.N]>');
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
fs.writeFileSync(path.join(root, 'packages/myco/plugin-version.json'), `${JSON.stringify({ version }, null, 2)}\n`);
execFileSync(process.execPath, ['--import', 'tsx', 'packages/myco/scripts/gen-plugin-bundle.ts'], { cwd: root, stdio: 'inherit' });
console.log(`Plugin ${version} prepared. Commit plugin-version.json and the generated Git bundle before tagging.`);
