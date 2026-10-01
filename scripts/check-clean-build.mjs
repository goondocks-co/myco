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
const description = execFileSync('git', ['describe', '--tags', '--always', '--dirty', '--match', 'myco/v*'], {
  cwd: root, encoding: 'utf8',
}).trim().replace(/^myco\/v/, '').replace(/[^0-9A-Za-z.-]/g, '');
assert.equal(version, `0.0.0-dev+${description}`, 'Dev binary must identify the clean commit');
console.log('[check-clean-build] checkout clean; binary identifies the commit');
