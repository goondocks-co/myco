import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveMycoHome } from '@myco/paths/home.js';
import { installedBinaryPath } from '@myco/runtime/binary-resolution.js';

function installFromSource(): void {
  const gitOutput = (args: string[], cwd = process.cwd()): string => execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'],
  }).trim();
  const repo = fs.realpathSync(gitOutput(['rev-parse', '--show-toplevel']));
  const gitPath = (flag: string): string => fs.realpathSync(gitOutput(['rev-parse', '--path-format=absolute', flag], repo));
  if (gitPath('--git-dir') !== gitPath('--git-common-dir') && process.env.ALLOW_WORKTREE_INSTALL !== '1') {
    console.error('Myco: Installing from a git worktree requires ALLOW_WORKTREE_INSTALL=1. For isolated testing, use make source-build and run its absolute artifact path in a scratch home.');
    process.exitCode = 1;
    return;
  }
  if (process.platform === 'win32') {
    console.error('Myco: Build on macOS or Linux and install the cross-built .exe on Windows; see CONTRIBUTING.md.');
    process.exitCode = 1;
    return;
  }
  const commit = gitOutput(['rev-parse', 'HEAD'], repo);
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
}

try { installFromSource(); }
catch (error) {
  const commandFailed = error instanceof Error && 'status' in error;
  console.error(commandFailed
    ? 'Myco: source installation did not finish; see the command output above.'
    : 'Myco: ' + (error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
}
