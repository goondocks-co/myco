import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();

function statIfPresent(file) {
  try {
    return lstatSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

// Source archives have no repository hooks to install.
if (!existsSync(path.join(root, '.git'))) {
  console.log('Fixture hook not installed: this source tree has no .git entry.');
  process.exit(0);
}

try {
  const commonDir = path.resolve(root, git('rev-parse', '--git-common-dir'));
  const hooksDir = path.resolve(root, git('rev-parse', '--git-path', 'hooks'));
  if (hooksDir !== path.join(commonDir, 'hooks')) {
    throw new Error('Custom core.hooksPath is configured. Add `node --import tsx scripts/check-fixture-redaction.ts` to its pre-commit hook.');
  }
  mkdirSync(hooksDir, { recursive: true });
  if (realpathSync(hooksDir) !== path.join(realpathSync(commonDir), 'hooks')) {
    throw new Error('The hooks directory is a symlink. Install the fixture check through your hook manager.');
  }
  const destination = path.join(hooksDir, 'pre-commit');
  const source = readFileSync(path.join(root, 'scripts/hooks/pre-commit'), 'utf8').replace(/\r\n/g, '\n');
  const existing = statIfPresent(destination);
  if (existing) {
    if (!existing.isFile() || readFileSync(destination, 'utf8') !== source) {
      throw new Error('An existing pre-commit hook was preserved. Add `node --import tsx scripts/check-fixture-redaction.ts` to it.');
    }
  } else {
    writeFileSync(destination, source, { flag: 'wx', mode: 0o755 });
  }
  chmodSync(destination, 0o755);
  console.log('Fixture redaction pre-commit hook installed.');
} catch (error) {
  console.error(`Fixture hook installation failed: ${error.message}`);
  process.exitCode = 1;
}
