import { mock, spyOn } from 'bun:test';
import * as childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

/** Observe Git requests at their process boundary; async questions complete on the next microtask. */
export function installGitProcessProbe(log: string, realGit: string): void {
  spyOn(Date, 'now').mockReturnValue(Date.now());
  const original = { ...childProcess };
  const isGit = (command: unknown) => typeof command === 'string' && ['git', 'git.exe'].includes(path.basename(command));
  const record = (args: readonly string[], phase: 'start' | 'end') => fs.appendFileSync(log, `${JSON.stringify({ args, phase })}\n`);
  const observe = <Options, Result, GitResult>(
    run: (command: string, args: string[], options: Options) => Result,
    answer: (args: string[], options: Options) => GitResult,
  ) => (command: string, args: string[], options: Options): Result | GitResult => {
    if (!isGit(command)) return run(command, args, options);
    record(args, 'start');
    return answer(args, options);
  };
  mock.module('node:child_process', () => ({
    ...original,
    // Synchronous probe queries use real Git without a wall-clock timeout.
    execFileSync: observe(original.execFileSync, (args, options: childProcess.ExecFileSyncOptions) =>
      original.execFileSync(realGit, args, { ...options, timeout: undefined })),
    spawnSync: observe(original.spawnSync, (args, options: childProcess.SpawnSyncOptions) =>
      original.spawnSync(realGit, args, { ...options, timeout: undefined })),
    spawn: observe(original.spawn, (args, _options: childProcess.SpawnOptions) => {
      const child = Object.assign(new EventEmitter(), { kill: () => true });
      queueMicrotask(() => {
        record(args, 'end');
        child.emit('close', 0, null);
      });
      return child;
    }),
  }));
}
