import { execFileSync } from 'node:child_process';
import { strict as assert } from 'node:assert';
import { resolve } from 'node:path';

const root = process.cwd();
const binary = process.argv[2];
assert(binary, 'Usage: node scripts/check-clean-build.mjs <binary>');
const version = execFileSync(resolve(root, binary), ['--version'], { cwd: root, encoding: 'utf8' }).trim();
console.log(`[check-clean-build] version ${version}`);
assert(!version.endsWith('-dirty'), `Clean checkout produced a dirty version: ${version}`);
const status = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });
assert.equal(status, '', `Build changed the checkout:\n${status}`);
const rawDescription = execFileSync('git', ['describe', '--tags', '--always', '--dirty', '--match', 'myco/v*'], {
  cwd: root, encoding: 'utf8',
}).trim();
const reachableTags = execFileSync('git', ['tag', '--merged', 'HEAD', '--list', 'myco/v*'], {
  cwd: root, encoding: 'utf8',
}).trim();
if (reachableTags) {
  const tag = execFileSync('git', ['describe', '--tags', '--abbrev=0', '--match', 'myco/v*'], {
    cwd: root, encoding: 'utf8',
  }).trim();
  const tagVersion = tag.replace(/^myco\/v/, '').replace(/[^0-9A-Za-z.-]/g, '');
  assert(rawDescription.startsWith('myco/v'), 'Reachable Myco tags must produce a tagged description');
  assert(version.startsWith(`0.0.0-dev+${tagVersion}`), `Dev binary must carry the reachable tag prefix ${tag}`);
  console.log(`[check-clean-build] reachable tag ${tag}; version carries its prefix`);
}
const description = rawDescription.replace(/^myco\/v/, '').replace(/[^0-9A-Za-z.-]/g, '');
assert.equal(version, `0.0.0-dev+${description}`, 'Dev binary must identify the clean commit');
console.log('[check-clean-build] checkout clean; binary identifies the commit');
