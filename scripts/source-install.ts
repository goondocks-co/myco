import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveMycoHome } from '@myco/paths/home.js';
import { installedBinaryPath } from '@myco/runtime/binary-resolution.js';

const repo = fs.realpathSync(execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim());
const gitPath = (flag: string): string => fs.realpathSync(execFileSync('git', ['rev-parse', '--path-format=absolute', flag], { cwd: repo, encoding: 'utf8' }).trim());
if (gitPath('--git-dir') !== gitPath('--git-common-dir') && process.env.ALLOW_WORKTREE_INSTALL !== '1') {
  throw new Error('Installing from a git worktree requires ALLOW_WORKTREE_INSTALL=1. For isolated testing, use make source-build and run its absolute artifact path in a scratch home.');
}
if (process.platform === 'win32') throw new Error('Build on macOS or Linux and install the cross-built .exe on Windows; see CONTRIBUTING.md.');
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
execFileSync('make', ['source-build'], { cwd: repo, stdio: 'inherit' });
const target = `${process.platform}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;
const binary = path.join(repo, `packages/myco-${target}/bin/myco`);
const home = resolveMycoHome();
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-source-install-'));
try {
  execFileSync(binary, ['update', '--source-checkout', repo, '--source-commit', commit], {
    cwd: scratch, env: { ...process.env, MYCO_HOME: home }, stdio: 'inherit',
  });
  const pathSetup = fileURLToPath(new URL('../packages/myco/scripts/install-path.sh', import.meta.url));
  execFileSync('sh', ['-c', '. "$1"; myco_setup_path "$2"', 'myco-path', pathSetup, installedBinaryPath(home)], {
    cwd: scratch, stdio: 'inherit',
  });
} finally { fs.rmSync(scratch, { recursive: true, force: true }); }
