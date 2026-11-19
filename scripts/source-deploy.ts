import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolveMycoHome } from '@myco/paths/home.js';
import { installedBinaryPath } from '@myco/runtime/binary-resolution.js';
import { readInstallMarker } from '@myco/install/marker-reader.js';

function deploySource(): void {
  if (process.env.CI) throw new Error('source-deploy is an owner command and refuses CI.');
  if (process.platform !== 'darwin') throw new Error('source-deploy requires macOS to verify the installed signature.');
  const commit = (process.env.MYCO_SOURCE_DEPLOY_COMMIT ?? '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('Pass the full commit: make source-deploy COMMIT=<40-hex-commit>.');
  const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trim();
  const repo = fs.realpathSync(git('rev-parse', '--show-toplevel'));
  const assertCheckout = (): void => {
    if (git('branch', '--show-current') !== 'main') throw new Error('source-deploy requires main.');
    if (git('rev-parse', '--path-format=absolute', '--git-dir') !== git('rev-parse', '--path-format=absolute', '--git-common-dir')) {
      throw new Error('source-deploy requires the main checkout, not a linked worktree.');
    }
    if (git('status', '--porcelain', '--untracked-files=all') !== '') throw new Error('source-deploy requires a clean checkout, including untracked files.');
    if (git('rev-parse', 'HEAD') !== commit) throw new Error('source-deploy HEAD does not match COMMIT.');
  };
  assertCheckout();
  const expectedBun = fs.readFileSync(path.join(repo, '.bun-version'), 'utf8').trim();
  const bun = execFileSync('bun', ['--version'], { encoding: 'utf8' }).trim();
  if (bun !== expectedBun) throw new Error(`source-deploy requires Bun ${expectedBun}; found ${bun}. Put the pinned Bun first on PATH.`);
  const ownerHome = os.homedir();
  // Resolve the operator's selected home outside repository pin scope.
  process.chdir(ownerHome);
  const home = resolveMycoHome();
  const env = { ...process.env, MYCO_HOME: home };
  execFileSync('make', ['-C', repo, 'source-install'], { env, stdio: 'inherit' });
  process.chdir(repo);
  assertCheckout();
  process.chdir(ownerHome);
  const binary = installedBinaryPath(home);
  const marker = readInstallMarker(home, true);
  const hash = createHash('sha256').update(fs.readFileSync(binary)).digest('hex');
  if (marker?.source !== 'checkout' || marker.commit !== commit || marker.checkout !== repo || marker.binary_sha256.toLowerCase() !== hash) {
    throw new Error('source-deploy installed provenance or binary hash does not match the requested checkout and commit.');
  }
  execFileSync('codesign', ['--verify', '--strict', binary], { stdio: 'inherit' });
  const version = execFileSync(binary, ['--version'], { env, encoding: 'utf8' }).trim();
  if (version !== marker.version) throw new Error('source-deploy installed --version does not match its verified provenance.');
  console.log(`Verified installed ${version}, commit ${marker.commit}, signature and binary hash.`);
  execFileSync(binary, ['server', 'update', '--target', 'cloudflare'], { env, stdio: 'inherit' });
  execFileSync(binary, ['server', 'status', '--target', 'cloudflare'], { env, stdio: 'inherit' });
}

try { deploySource(); }
catch (error) {
  console.error('Myco: source deployment stopped: ' + (error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
}
