import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { sandboxChildEnv, resolveTestTool } from '../../scripts/test-environment.mjs';

const repo = path.resolve(import.meta.dir, '../..');
const source = path.join(repo, 'scripts/source-install.ts');
const target = `${process.platform}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-source-install-test-'));
  const checkout = path.join(root, 'checkout');
  const home = path.join(root, 'home');
  fs.mkdirSync(checkout);
  fs.mkdirSync(home);
  const env = sandboxChildEnv(root, { HOME: home, LOCALAPPDATA: path.join(home, 'AppData/Local'), ALLOW_WORKTREE_INSTALL: '' });
  const run = (cmd: string, args: string[], cwd = checkout, overrides = {}) => spawnSync(cmd, args, { cwd, env: { ...env, ...overrides }, encoding: 'utf8' });
  expect(run('git', ['init', '-q']).status).toBe(0);
  for (const file of ['tsconfig.json', 'scripts/source-install.ts']) {
    fs.mkdirSync(path.dirname(path.join(checkout, file)), { recursive: true });
    fs.copyFileSync(path.join(repo, file), path.join(checkout, file));
  }
  fs.mkdirSync(path.join(checkout, 'packages/myco'), { recursive: true });
  for (const dir of ['src', 'scripts']) fs.symlinkSync(path.join(repo, 'packages/myco', dir), path.join(checkout, 'packages/myco', dir), 'dir');
  fs.symlinkSync(path.join(repo, 'node_modules'), path.join(checkout, 'node_modules'), 'dir');
  fs.writeFileSync(path.join(checkout, 'Makefile'), `include ${repo}/Makefile\nprepare-build:\n\t@echo prepare >> built\nsource-build:\n\t@echo build-and-verify >> built\n`);
  const binary = path.join(checkout, `packages/myco-${target}/bin/myco`);
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, `#!${resolveTestTool('node')}\nconst fs=require('fs'),path=require('path');
if(process.argv[2]==='--version'){console.log('0.0.0-dev+fixture.b1');process.exit(0)}
fs.writeFileSync(path.join(process.env.HOME,'called.json'),JSON.stringify({args:process.argv.slice(2),cwd:process.cwd()}));
const home=process.env.MYCO_HOME; fs.mkdirSync(path.join(home,'bin'),{recursive:true});
const bin=fs.existsSync(path.join(home,'install.json'))?JSON.parse(fs.readFileSync(path.join(home,'install.json'))).bin:path.join(home,'bin/myco');
fs.copyFileSync(__filename,bin);fs.chmodSync(bin,0o755);
fs.writeFileSync(path.join(home,'install.json'),JSON.stringify({source:'checkout',checkout:process.argv[4],commit:process.argv[6],channel:'stable',bin,prerelease:true,version:'0.0.0-dev+fixture.b1',binary_sha256:require('crypto').createHash('sha256').update(fs.readFileSync(bin)).digest('hex')}));\n`, { mode: 0o755 });
  expect(run('git', ['add', '.']).status).toBe(0);
  expect(run('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture']).status).toBe(0);
  return { root, checkout, home, env, run, install: (cwd = checkout, overrides = {}) => run('make', ['source-install'], cwd, overrides) };
}

describe.skipIf(process.platform === 'win32')('POSIX source installation', () => {
it('builds once, uses the candidate updater, establishes fresh login PATH and stays idempotent without pins', () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.home, '.profile'), 'export UNRELATED_SETTING=retained\n');
    fs.writeFileSync(path.join(f.home, '.zshenv'), 'export UNRELATED_SETTING=retained\n');
    const result = f.install();
    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(path.join(f.checkout, 'built'), 'utf8')).toBe('prepare\nbuild-and-verify\n');
    const called = JSON.parse(fs.readFileSync(path.join(f.home, 'called.json'), 'utf8'));
    const commit = f.run('git', ['rev-parse', 'HEAD']).stdout.trim();
    expect(called.args).toEqual(['update', '--source-checkout', fs.realpathSync(f.checkout), '--source-commit', commit]);
    expect(called.cwd.startsWith(f.root)).toBe(true);
    expect(called.cwd).not.toBe(f.checkout);
    const binary = path.join(f.env.MYCO_HOME!, 'bin/myco');
    expect(result.stdout).toContain(`Myco command: ${binary}`);
    expect(result.stdout).toContain('Open a new shell');
    const rcFiles = ['.profile', '.zshenv', '.zprofile'];
    const before = rcFiles.map(file => fs.readFileSync(path.join(f.home, file), 'utf8'));
    expect(f.install().status).toBe(0);
    expect(rcFiles.map(file => fs.readFileSync(path.join(f.home, file), 'utf8'))).toEqual(before);
    for (const shell of ['bash', 'zsh']) {
      const executable = resolveTestTool(shell) ?? (fs.existsSync('/bin/' + shell) ? '/bin/' + shell : null);
      if (!executable) continue;
      const child = f.run(executable, ['-l', '-c', 'command -v myco; myco --version; echo "$UNRELATED_SETTING"'], f.home, { PATH: '/usr/bin:/bin', ZDOTDIR: f.home });
      expect(child.status, child.stderr).toBe(0);
      expect(child.stdout).toContain(binary);
      expect(child.stdout).toContain('0.0.0-dev+fixture.b1');
      expect(child.stdout).toContain('retained');
    }
    for (const base of [f.checkout, f.home, f.env.MYCO_HOME!]) {
      for (const name of ['runtime.command', 'runtime.home', 'runtime-exec']) {
        expect(fs.existsSync(path.join(base, '.myco', name))).toBe(false);
        expect(fs.existsSync(path.join(base, name))).toBe(false);
      }
    }
    expect(fs.existsSync(path.join(f.home, '.local/bin/myco-dev'))).toBe(false);
    expect(fs.existsSync(path.join(f.home, '.myco-dev'))).toBe(false);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

it('refuses worktree installation before building and admits the explicit opt-in', () => {
  const f = fixture();
  try {
    const worktree = path.join(f.root, 'worktree');
    expect(f.run('git', ['worktree', 'add', '-qb', 'lane', worktree]).status).toBe(0);
    const refused = f.install(worktree);
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain('ALLOW_WORKTREE_INSTALL=1');
    expect(fs.existsSync(path.join(worktree, 'built'))).toBe(false);
    expect(fs.existsSync(f.env.MYCO_HOME!)).toBe(false);
    const accepted = f.install(worktree, { ALLOW_WORKTREE_INSTALL: '1' });
    expect(accepted.status, accepted.stderr).toBe(0);
    expect(fs.existsSync(path.join(f.env.MYCO_HOME!, 'bin/myco'))).toBe(true);
    expect(fs.existsSync(path.join(worktree, '.myco'))).toBe(false);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

it.each(['file', 'link', 'owned-link'] as const)('preserves foreign paths and repairs an owned link (%s)', kind => {
  const f = fixture();
  f.env.MYCO_HOME = path.join(f.home, 'selected-home');
  try {
    const link = path.join(f.home, '.local/bin/myco');
    fs.mkdirSync(path.dirname(link), { recursive: true });
    const owned = path.join(f.home, '.myco/bin/myco');
    if (kind === 'file') fs.writeFileSync(link, 'foreign bytes');
    else fs.symlinkSync(kind === 'owned-link' ? owned : '/foreign/myco', link);
    const result = f.install();
    expect(result.status, result.stderr).toBe(0);
    if (kind === 'file') expect(fs.readFileSync(link, 'utf8')).toBe('foreign bytes');
    else expect(fs.readlinkSync(link)).toBe(kind === 'owned-link' ? path.join(f.env.MYCO_HOME!, 'bin/myco') : '/foreign/myco');
    if (kind !== 'owned-link') expect(result.stderr).toContain('left foreign');
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

it('uses one generated PATH implementation for source and standalone installs', () => {
  const shared = fs.readFileSync(path.join(repo, 'packages/myco/scripts/install-path.sh'), 'utf8');
  const installer = fs.readFileSync(path.join(repo, 'docs/install.sh'), 'utf8');
  expect(installer).toContain('# install-path:start\n' + shared + '# install-path:end');
  expect(installer).toContain('myco_setup_path "${BIN_DIR}/myco"');
  expect(fs.readFileSync(source, 'utf8')).toContain('install-path.sh');
  expect(fs.readFileSync(source, 'utf8')).toContain('myco_setup_path');
});

it.each(['default', 'machine-pin', 'environment', 'recorded-destination'] as const)('uses the shared home and destination rules (%s)', selection => {
  const f = fixture();
  try {
    const home = selection === 'default' ? path.join(f.home, '.myco') : path.join(f.home, 'selected');
    if (selection !== 'default' && selection !== 'machine-pin') f.env.MYCO_HOME = home;
    const pin = path.join(f.home, '.myco/runtime.home');
    if (selection === 'machine-pin') {
      fs.mkdirSync(path.dirname(pin), { recursive: true });
      fs.writeFileSync(pin, home + '\n', { mode: 0o600 });
    }
    const binary = selection === 'recorded-destination' ? path.join(f.home, 'elsewhere/myco') : path.join(home, 'bin/myco');
    if (selection === 'recorded-destination') {
      fs.mkdirSync(home, { recursive: true });
      fs.mkdirSync(path.dirname(binary), { recursive: true });
      fs.writeFileSync(path.join(home, 'install.json'), JSON.stringify({ source: 'curl', bin: binary, channel: 'stable', prerelease: false }));
    }
    const installed = selection === 'default' || selection === 'machine-pin'
      ? f.run('env', ['-u', 'MYCO_HOME', 'make', 'source-install']) : f.install();
    expect(installed.status, installed.stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(home, 'install.json'), 'utf8')).bin).toBe(binary);
    expect(installed.stdout).toContain('Myco command: ' + binary);
    if (selection === 'machine-pin') expect(fs.readFileSync(pin, 'utf8')).toBe(home + '\n');
    else expect(fs.existsSync(pin)).toBe(false);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

it('shares preparation with the retained development build and verifies one compilation without tests', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-source-recipe-'));
  try {
    const plan = spawnSync('make', ['-n', 'source-build'], { cwd: repo, env: sandboxChildEnv(root), encoding: 'utf8' });
    expect(plan.status).toBe(0);
    for (const command of ['build-libsqlite3-target.sh', 'build:ui', 'npm run codegen', 'build-single-target.mjs', 'verify-build.mjs']) expect(plan.stdout).toContain(command);
    expect(plan.stdout.match(/build-single-target.mjs/g)?.length).toBe(1);
    expect(plan.stdout).not.toMatch(/npm (test|run test)/);
    expect(fs.readFileSync(path.join(repo, 'Makefile'), 'utf8')).toContain('dev-build: source-build');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

});
