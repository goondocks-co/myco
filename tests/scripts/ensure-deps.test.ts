import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { installRoots, excludedLockfiles } from '../../scripts/ensure-deps.mjs';
import { sandboxChildEnv, resolveTestTool } from '../../scripts/test-environment.mjs';

const repo = path.resolve(import.meta.dir, '../..');
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-ensure-deps-'));
  roots.push(root);
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const write = (name: string, value: unknown) => {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
  };
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.copyFileSync(path.join(repo, 'scripts/ensure-deps.mjs'), path.join(root, 'scripts/ensure-deps.mjs'));
  fs.copyFileSync(path.join(repo, 'Makefile'), path.join(root, 'Makefile'));
  write('packages/myco/package.json', { engines: { node: '>=20' } });
  fs.mkdirSync(path.join(root, 'packages/myco/scripts'));
  fs.copyFileSync(path.join(repo, 'packages/myco/scripts/check-native-build-tools.sh'), path.join(root, 'packages/myco/scripts/check-native-build-tools.sh'));
  fs.writeFileSync(path.join(root, '.bun-version'), '1.4.0\n');
  const tool = (name: string, body: string) => fs.writeFileSync(path.join(bin, name), '#!/bin/sh\n' + body + '\n', { mode: 0o755 });
  for (const name of ['bash', 'dirname', 'uname']) fs.symlinkSync(resolveTestTool(name)!, path.join(bin, name));
  tool('node', 'if [ "$1" = "--version" ]; then echo v22.0.0; else exec "' + resolveTestTool('node') + '" "$@"; fi');
  for (const name of ['bun', 'clang', 'gcc', 'curl', 'unzip', 'x86_64-w64-mingw32-gcc']) tool(name, 'echo 1.4.0');
  tool('npm', 'exec "' + resolveTestTool('node') + '" "' + path.join(root, 'fake-npm.cjs') + '" "$@"');
  fs.writeFileSync(path.join(root, 'fake-npm.cjs'), `
const fs=require('fs'),path=require('path');
fs.appendFileSync(${JSON.stringify(path.join(root, 'calls'))},JSON.stringify([process.cwd(),...process.argv.slice(2)])+'\\n');
if(process.argv[2]!=='ci') process.exit(99);
const lock=JSON.parse(fs.readFileSync('package-lock.json'));
delete lock.packages[''];
fs.mkdirSync('node_modules',{recursive:true});
for(const name of Object.keys(lock.packages))fs.mkdirSync(name,{recursive:true});
fs.writeFileSync('node_modules/.package-lock.json',JSON.stringify(lock));
`);
  const lock = { lockfileVersion: 3, packages: { '': { name: 'fixture' }, 'node_modules/fixture': { version: '1.0.0', integrity: 'sha512-fixture' } } };
  for (const { directory } of installRoots) {
    write(path.join(directory, 'package-lock.json'), lock);
    fs.mkdirSync(path.join(root, directory, 'node_modules/fixture'), { recursive: true });
    write(path.join(directory, 'node_modules/.package-lock.json'), { lockfileVersion: 3, packages: { 'node_modules/fixture': lock.packages['node_modules/fixture'] } });
  }
  const env = sandboxChildEnv(root, { PATH: bin, CC: '' });
  const run = (args: string[] = []) => spawnSync(resolveTestTool('node')!, ['scripts/ensure-deps.mjs', ...args], { cwd: root, env, encoding: 'utf8' });
  const calls = () => fs.existsSync(path.join(root, 'calls')) ? fs.readFileSync(path.join(root, 'calls'), 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  return { root, bin, write, tool, run, calls, lock, env };
}

describe('dependency preparation', () => {
  it('accepts npm hidden records without invoking npm, regardless of timestamps', () => {
    const f = fixture();
    for (const { directory } of installRoots) {
      fs.utimesSync(path.join(f.root, directory, 'package-lock.json'), new Date(), new Date());
      fs.utimesSync(path.join(f.root, directory, 'node_modules/.package-lock.json'), new Date(0), new Date(0));
    }
    const result = f.run();
    expect(result.status, result.stderr).toBe(0);
    expect(f.calls()).toEqual([]);
  });

  it.each(['.', 'packages/myco-server/ui'])('reinstalls only the root whose lock content changed: %s', directory => {
    const f = fixture();
    const lockfile = path.join(f.root, directory, 'package-lock.json');
    const originalTime = fs.statSync(lockfile).mtime;
    f.lock.packages['node_modules/fixture'].version = '2.0.0';
    f.write(path.join(directory, 'package-lock.json'), f.lock);
    fs.utimesSync(lockfile, originalTime, originalTime);
    const result = f.run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('packages out of date; reinstalling');
    expect(f.calls()).toEqual([[path.join(f.root, directory), 'ci']]);
    expect(f.run().status).toBe(0);
    expect(f.calls()).toHaveLength(1);
  });

  it('installs missing node_modules and supports the dashboard-only entry point', () => {
    const f = fixture();
    for (const { directory } of installRoots) fs.rmSync(path.join(f.root, directory, 'node_modules'), { recursive: true });
    expect(f.run(['--ui']).status).toBe(0);
    expect(f.calls()).toEqual([[path.join(f.root, 'packages/myco-server/ui'), 'ci']]);
    expect(f.run().status).toBe(0);
    expect(f.calls()).toHaveLength(2);
  });

  it.each(['bun', 'npm', 'curl', 'unzip', process.platform === 'darwin' ? 'clang' : 'gcc'])('refuses missing %s before installing', name => {
    const f = fixture();
    fs.unlinkSync(path.join(f.bin, name));
    fs.rmSync(path.join(f.root, 'node_modules'), { recursive: true });
    const result = f.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(name);
    expect(result.stderr).toContain('Install');
    expect(f.calls()).toEqual([]);
  });

  it('refuses old Node and reports missing Node through Make before any recipe', () => {
    const f = fixture();
    f.tool('node', 'echo v18.0.0');
    expect(f.run().stderr).toContain('Node.js >=20');
    expect(f.run().status).not.toBe(0);
    fs.unlinkSync(path.join(f.bin, 'node'));
    const result = spawnSync(resolveTestTool('make')!, ['source-build'], { cwd: f.root, env: f.env, encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Node.js >=20');
    expect(f.calls()).toEqual([]);
  });

  it('notices a Bun mismatch without refusing the build', () => {
    const f = fixture();
    f.tool('bun', 'echo 1.4.3');
    const result = f.run();
    expect(result.stderr).toContain('Notice: Bun 1.4.3');
    expect(result.status).toBe(0);
    expect(f.calls()).toEqual([]);
  });

  it('requires MinGW before Windows build work', () => {
    const f = fixture();
    fs.unlinkSync(path.join(f.bin, 'x86_64-w64-mingw32-gcc'));
    const result = f.run(['--windows']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Install MinGW');
    expect(f.calls()).toEqual([]);
  });

  it.each(['curl', process.platform === 'darwin' ? 'clang' : 'gcc'])('SQLite script refuses missing %s before creating vendor output', name => {
    const f = fixture();
    const script = path.join(f.root, 'packages/myco/scripts/build-libsqlite3-target.sh');
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.copyFileSync(path.join(repo, 'packages/myco/scripts/build-libsqlite3-target.sh'), script);
    fs.unlinkSync(path.join(f.bin, name));
    const target = process.platform === 'darwin' ? 'darwin-arm64' : 'linux-x64';
    const result = spawnSync(resolveTestTool('bash')!, [script, target], { cwd: f.root, env: f.env, encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(name + ' is required');
    expect(fs.existsSync(path.join(f.root, 'packages/myco/vendor-src'))).toBe(false);
  });

  it('accepts omitted optional trees but detects changed and removed required packages', () => {
    const f = fixture();
    f.write('package-lock.json', { packages: { ...f.lock.packages, 'node_modules/optional': { optional: true, version: '1' } } });
    expect(f.run().status).toBe(0);
    expect(f.calls()).toEqual([]);
    fs.rmSync(path.join(f.root, 'node_modules/fixture'), { recursive: true });
    expect(f.run().status).toBe(0);
    expect(f.calls()).toHaveLength(1);
  });
});

it('accounts for every tracked npm lockfile', () => {
  const result = spawnSync('git', ['ls-files', '*package-lock.json'], { cwd: repo, encoding: 'utf8' });
  expect(result.status).toBe(0);
  const covered = installRoots.map(({ directory }) => path.posix.join(directory, 'package-lock.json'));
  expect([...covered, ...Object.keys(excludedLockfiles)].sort()).toEqual(result.stdout.trim().split('\n').sort());
});

it('prepares every Make recipe invoking npm, node or bun', () => {
  const makefile = fs.readFileSync(path.join(repo, 'Makefile'), 'utf8');
  const targets = new Map<string, { deps: string[]; recipe: string }>();
  let current: { deps: string[]; recipe: string } | undefined;
  for (const line of makefile.split('\n')) {
    const target = /^([\w-]+):\s*(.*)$/.exec(line);
    if (target) {
      current = { deps: target[2]!.trim().split(/\s+/), recipe: '' };
      targets.set(target[1]!, current);
    } else if (line.startsWith('\t') && current) current.recipe += line + '\n';
  }
  const prepared = (name: string, seen = new Set<string>()): boolean =>
    name === 'deps' || (!seen.has(name) && (seen.add(name), targets.get(name)?.deps.some(dep => prepared(dep, seen)) === true));
  for (const [name, { recipe }] of targets) {
    if (/\b(npm|node|bun)\b/.test(recipe)) expect(prepared(name), name + ' must depend on deps').toBe(true);
  }
  expect(targets.get('prepare-build')?.deps).toContain('deps');
  expect(targets.get('install')?.deps).toContain('deps');
});

it('uses shared dashboard preparation in both direct npm scripts', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'packages/myco-server/package.json'), 'utf8'));
  for (const name of ['build:ui', 'check:ui']) {
    expect(pkg.scripts[name]).toContain('node ../../scripts/ensure-deps.mjs --ui &&');
    expect(pkg.scripts[name]).not.toContain('node_modules/react');
  }
});
