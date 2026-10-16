import { mock, spyOn } from 'bun:test';
import * as childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

export interface GitBudgetObservation {
  args: string[];
  phase: 'start' | 'deadline' | 'kill';
  at: number;
  timeout?: number;
  signal?: string;
  committed?: boolean;
  receipt?: boolean;
}

/** Git requests stay open until their caller's timeout kills them; synchronous timeouts advance the hook clock. */
export function installGitBudgetProbe(log: string, beforeGit: () => Pick<GitBudgetObservation, 'committed' | 'receipt'> = () => ({})): void {
  let now = Date.now();
  spyOn(Date, 'now').mockImplementation(() => now);
  const original = { ...childProcess };
  const timers = globalThis.setTimeout;
  const expectedDeadlineMs = 500;
  const pending: Array<{ args: string[]; at: number }> = [];
  const isGit = (command: string) => ['git', 'git.exe'].includes(path.basename(command));
  const record = (event: Omit<GitBudgetObservation, 'at'>) => fs.appendFileSync(log, `${JSON.stringify({ ...event, at: now, ...beforeGit() })}\n`);
  spyOn(globalThis, 'setTimeout').mockImplementation(Object.assign(<Args extends unknown[]>(callback: (...args: Args) => void, timeout?: number, ...args: Args) => {
    const git = timeout === expectedDeadlineMs ? pending.shift() : undefined;
    if (git === undefined) return timers(callback, timeout, ...args);
    record({ args: git.args, phase: 'deadline', timeout });
    return timers(() => {
      now = Math.max(now, git.at + (timeout ?? 0));
      callback(...args);
    }, timeout);
  }, timers));
  mock.module('node:child_process', () => ({
    ...original,
    execFileSync: (command: string, args: string[], options: childProcess.ExecFileSyncOptions) => {
      if (!isGit(command)) return original.execFileSync(command, args, options);
      record({ args, phase: 'start', timeout: options.timeout, signal: options.killSignal?.toString() });
      now += options.timeout ?? 0;
      throw new Error('ETIMEDOUT');
    },
    spawn: (command: string, args: string[], options: childProcess.SpawnOptions) => {
      if (!isGit(command)) return original.spawn(command, args, options);
      record({ args, phase: 'start' });
      pending.push({ args, at: now });
      const child = Object.assign(new EventEmitter(), { kill: (signal: string) => {
        record({ args, phase: 'kill', signal });
        queueMicrotask(() => child.emit('close', null, signal));
        return true;
      } });
      return child;
    },
  }));
}

/** Observe real Git processes and signal issuance without changing their lifetime. */
export function installRealGitProbe(log: string): void {
  const original = { ...childProcess };
  mock.module('node:child_process', () => ({
    ...original,
    spawn: (command: string, args: string[], options: childProcess.SpawnOptions) => {
      const child = original.spawn(command, args, options);
      if (path.basename(command) !== 'git') return child;
      const record = (phase: string, signal?: number | NodeJS.Signals) => fs.appendFileSync(log, `${JSON.stringify({ phase, pid: child.pid, args, signal })}\n`);
      record('start');
      const kill = child.kill.bind(child);
      child.kill = (signal) => { record('kill', signal); return kill(signal); };
      return child;
    },
  }));
}
