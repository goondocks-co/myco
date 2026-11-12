import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { workerLockPath } from '@myco/runner/instance.js';
import { LifecycleLock } from '@myco/utils/lifecycle-lock.js';

export const URL = 'https://setup.invalid';
export const fakeFetch = (fn: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>): typeof fetch => Object.assign(fn, { preconnect: () => {} });

export function freshJourney(): { root: string; home: string; project: string; lines: string[]; errors: string[] } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-setup-journey-'));
  const home = path.join(root, 'myco');
  const project = path.join(root, 'repo');
  fs.mkdirSync(project);
  execFileSync('git', ['init', '-q'], { cwd: project });
  return { root, home, project, lines: [], errors: [] };
}

export function holdRunnerLock(closers: (() => void | Promise<void>)[], lockDir: string): void {
  const held = LifecycleLock.acquire(workerLockPath(lockDir, URL), { command: 'fixture runner' });
  if (!held.acquired) throw new Error('Fixture runner lock already held');
  closers.push(() => held.lock.release());
}

/** Names, contents, modes and mtimes cover status's filesystem contract. */
export function snapshot(directory: string): unknown {
  if (!fs.existsSync(directory)) return null;
  return fs.readdirSync(directory).sort().map((name) => {
    const file = path.join(directory, name);
    const stat = fs.lstatSync(file);
    return [name, stat.mode, stat.mtimeMs, stat.isDirectory() ? snapshot(file) : stat.isSymbolicLink() ? fs.readlinkSync(file) : fs.readFileSync(file).toString('base64')];
  });
}
