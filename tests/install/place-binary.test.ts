/**
 * Putting a Myco executable where something will run it: judged by running it,
 * signed again only when its own signature does not verify, and swapped in by
 * one rename so the destination is never a partial program.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { placeExecutable, programRuns, readyExecutable, type CommandRun } from '@myco/install/place-binary.js';

let scratch: string;
beforeEach(() => { scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-place-binary-')); });
afterEach(() => { fs.rmSync(scratch, { recursive: true, force: true }); });

/** A command runner that records each call and answers from `answer`. */
function recorder(answer: (command: string, args: readonly string[]) => ReturnType<CommandRun> = () => ({ status: 0 })): { run: CommandRun; calls: string[][] } {
  const calls: string[][] = [];
  return { calls, run: (command, args) => { calls.push([command, ...args]); return answer(command, args); } };
}

describe('whether a program runs here', () => {
  it('keeps a Darwin signature that verifies, and runs the program', () => {
    const { run, calls } = recorder();
    expect(readyExecutable('/x/myco', 'darwin', run)).toEqual({ runs: true });
    expect(calls).toEqual([['codesign', '--verify', '--strict', '/x/myco'], ['/x/myco', '--version']]);
  });

  it('signs ad hoc again, keeping entitlements and identifier, only an ad hoc or absent Darwin signature that does not verify', () => {
    for (const shown of ['Executable=/x/myco\nSignature=adhoc\nTeamIdentifier=not set\n', '/x/myco: code object is not signed at all\n']) {
      let verifies = 0;
      const { run, calls } = recorder((command, args) => {
        if (command === 'codesign' && args[0] === '-dv') return { status: shown.includes('not signed') ? 1 : 0, output: shown };
        return command === 'codesign' && args[0] === '--verify' && verifies++ === 0 ? { status: 1 } : { status: 0 };
      });
      expect(readyExecutable('/x/myco', 'darwin', run)).toEqual({ runs: true });
      expect(calls).toEqual([
        ['codesign', '--verify', '--strict', '/x/myco'],
        ['codesign', '-dv', '/x/myco'],
        ['codesign', '--force', '--sign', '-', '--preserve-metadata=entitlements,identifier', '/x/myco'],
        ['codesign', '--verify', '--strict', '/x/myco'],
        ['/x/myco', '--version'],
      ]);
    }
  });

  it('never replaces a certificate\'s signature that does not verify', () => {
    const { run, calls } = recorder((command, args) => (command === 'codesign' && args[0] === '-dv'
      ? { status: 0, output: 'Authority=Developer ID Application: Someone (TEAM123)\nTeamIdentifier=TEAM123\n' }
      : command === 'codesign' ? { status: 1 } : { status: 0 }));
    expect(readyExecutable('/x/myco', 'darwin', run)).toEqual({ runs: false, detail: 'its signature does not verify, and it is not an ad hoc signature this machine may make again' });
    expect(calls.some((call) => call.includes('--force') || call[0] === '/x/myco')).toBe(false);
  });

  it('refuses a program whose signature cannot be made to verify, or that the kernel kills', () => {
    const unsignable = recorder((command, args) => (command === 'codesign' && args[0] === '-dv' ? { status: 0, output: 'Signature=adhoc\n' } : command === 'codesign' ? { status: 1 } : { status: 0 }));
    expect(readyExecutable('/x/myco', 'darwin', unsignable.run)).toEqual({ runs: false, detail: 'its signature does not verify and could not be signed again (exited 1)' });
    expect(unsignable.calls.some(([command]) => command === '/x/myco')).toBe(false);
    const killed = recorder((command) => (command === '/x/myco' ? { status: null, signal: 'SIGKILL' } : { status: 0 }));
    expect(readyExecutable('/x/myco', 'darwin', killed.run)).toEqual({ runs: false, detail: 'ended by SIGKILL' });
  });

  it('runs the program on Linux without macOS tooling, and leaves Windows to its own loader', () => {
    const linux = recorder();
    expect(readyExecutable('/x/myco', 'linux', linux.run)).toEqual({ runs: true });
    expect(linux.calls).toEqual([['/x/myco', '--version']]);
    const windows = recorder();
    expect(readyExecutable('C:\\myco.exe', 'win32', windows.run)).toEqual({ runs: true });
    expect(windows.calls).toEqual([]);
  });

  it('runs a real program, and says why one does not run', () => {
    if (process.platform === 'win32') return;
    const good = path.join(scratch, 'good');
    fs.writeFileSync(good, '#!/bin/sh\n[ "$1" = --version ] && echo 1.0.0\n', { mode: 0o755 });
    expect(programRuns(good)).toEqual({ runs: true });
    const failing = path.join(scratch, 'failing');
    fs.writeFileSync(failing, '#!/bin/sh\nexit 3\n', { mode: 0o755 });
    expect(programRuns(failing)).toEqual({ runs: false, detail: 'exited 3' });
    expect(programRuns(path.join(scratch, 'absent')).runs).toBe(false);
  });
});

describe('placing a program', () => {
  const src = (): string => { const p = path.join(scratch, 'new-myco'); fs.writeFileSync(p, 'NEW'); return p; };
  const dest = (): string => { const d = path.join(scratch, 'bin'); fs.mkdirSync(d, { recursive: true }); const p = path.join(d, 'myco'); fs.writeFileSync(p, 'OLD'); return p; };

  it('replaces the destination by one rename with an executable copy, leaving nothing beside it', () => {
    const to = dest();
    const before = fs.statSync(to).ino;
    const judged: string[] = [];
    placeExecutable(src(), to, { ready: (file) => { judged.push(path.basename(file)); return { runs: true }; } });
    expect(fs.readFileSync(to, 'utf8')).toBe('NEW');
    expect(fs.statSync(to).ino).not.toBe(before);
    if (process.platform !== 'win32') expect(fs.statSync(to).mode & 0o777).toBe(0o755);
    // Judged under the destination's own name, which an ad hoc signature takes its identifier from.
    expect(judged).toEqual(['myco']);
    expect(fs.readdirSync(path.dirname(to))).toEqual(['myco']);
    expect(fs.existsSync(path.join(scratch, 'new-myco'))).toBe(true);
  });

  it('leaves the destination as it was when the new program does not run', () => {
    const to = dest();
    expect(() => placeExecutable(src(), to, { ready: () => ({ runs: false, detail: 'ended by SIGKILL' }) })).toThrow(/does not run on this machine: ended by SIGKILL/);
    expect(fs.readFileSync(to, 'utf8')).toBe('OLD');
    expect(fs.readdirSync(path.dirname(to))).toEqual(['myco']);
  });

  it('moves rather than copies when asked, into a directory that did not exist', () => {
    const from = src();
    const to = path.join(scratch, 'versions', '1.2.3', 'myco');
    placeExecutable(from, to, { move: true });
    expect(fs.readFileSync(to, 'utf8')).toBe('NEW');
    expect(fs.existsSync(from)).toBe(false);
    expect(fs.readdirSync(path.dirname(to))).toEqual(['myco']);
  });
});
