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
const pluginVersionFile = path.join(root, 'packages/myco/plugin-version.json');
// The first release prepared without the retired backup format records the release it replaces as the last that reads it.
const retiredFormatFile = path.join(root, 'packages/myco-server/src/core/retired-format-release.ts');
const retiredFormat = fs.readFileSync(retiredFormatFile, 'utf8');
const unset = 'LAST_RELEASE_RESTORING_RETIRED_FORMAT: string | null = null;';
if (retiredFormat.includes(unset)) {
  const { version: replaced } = JSON.parse(fs.readFileSync(pluginVersionFile, 'utf8'));
  fs.writeFileSync(retiredFormatFile, retiredFormat.replace(unset, `LAST_RELEASE_RESTORING_RETIRED_FORMAT: string | null = ${JSON.stringify(replaced)};`));
}
fs.writeFileSync(pluginVersionFile, `${JSON.stringify({ version }, null, 2)}\n`);
execFileSync(process.execPath, ['--import', 'tsx', 'packages/myco/scripts/gen-plugin-bundle.ts'], { cwd: root, stdio: 'inherit' });
console.log(`Plugin ${version} prepared. Commit plugin-version.json, retired-format-release.ts and the generated Git bundle before tagging.`);
