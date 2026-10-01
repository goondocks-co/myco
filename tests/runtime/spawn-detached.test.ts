/**
 * A process started apart from this one (#1561): it runs, it outlives the caller's wait, and on Windows its command
 * line reaches it argument for argument. Runs on POSIX and on the Windows runner (`windows-native`), where the start is
 * `CreateProcessW` with `CREATE_BREAKAWAY_FROM_JOB`.
 */
import { describe, expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { jobHoldsChildren, spawnDetached, windowsArgument } from '@myco/runtime/spawn-detached.js';

describe('a detached start', () => {
  it('runs the command with its arguments in the directory it is given, and answers at once', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-detached-'));
    const out = path.join(dir, 'out.json');
    const script = path.join(dir, 'child.ts');
    fs.writeFileSync(script, `require('node:fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));\n`);
    const args = [script, 'plain', 'with space', 'with "quote"', 'trailing\\', ''];
    const started = Date.now();
    const answer = spawnDetached(process.execPath, args, { cwd: dir });
    expect(answer.started).toBe(true);
    // Answered before the child could have finished anything: the caller never waits on it.
    expect(Date.now() - started).toBeLessThan(2_000);
    for (let i = 0; i < 200 && !fs.existsSync(out); i++) await new Promise((r) => setTimeout(r, 50));
    const seen = JSON.parse(fs.readFileSync(out, 'utf-8')) as { argv: string[]; cwd: string };
    expect(seen.argv).toEqual(args.slice(1));
    expect(fs.realpathSync(seen.cwd)).toBe(fs.realpathSync(dir));
    fs.rmSync(dir, { recursive: true, force: true });
  }, 30_000);

  it('answers a command that cannot start as not started, without throwing', () => {
    expect(spawnDetached(path.join(os.tmpdir(), 'no-such-program-myco'), [], { cwd: os.tmpdir() }).started).toBe(false);
  });
});

describe('a Windows command-line argument', () => {
  it('is quoted only where it must be, and keeps its backslashes and quotes as CommandLineToArgvW reads them', () => {
    expect(windowsArgument('plain')).toBe('plain');
    expect(windowsArgument('')).toBe('""');
    expect(windowsArgument('with space')).toBe('"with space"');
    expect(windowsArgument('C:\\Program Files\\myco\\myco.exe')).toBe('"C:\\Program Files\\myco\\myco.exe"');
    expect(windowsArgument('with "quote"')).toBe('"with \\"quote\\""');
    expect(windowsArgument('trailing\\')).toBe('trailing\\');
    expect(windowsArgument('spaced trailing\\')).toBe('"spaced trailing\\\\"');
    expect(windowsArgument('a\\"b c')).toBe('"a\\\\\\"b c"');
  });
});

describe('a job a detached start cannot leave', () => {
  it('is one that ends what it holds when it closes and lets nothing break away, read from its limit flags', () => {
    // A harness's kill-on-close job with no breakaway: a helper started from it ends with the hook.
    expect(jobHoldsChildren(0x2000)).toBe(true);
    // An SSH session's job, and the job libuv and Bun put their children in: both let a start break away.
    expect(jobHoldsChildren(0x2800)).toBe(false);
    expect(jobHoldsChildren(0x3c00)).toBe(false);
    expect(jobHoldsChildren(0x1000 | 0x2000)).toBe(false);
    // A job that does not end what it holds lets a helper outlive the hook.
    expect(jobHoldsChildren(0)).toBe(false);
  });
});

/**
 * G4e on a Windows runner: a hook started inside a kill-on-close Job Object. The child below stands for the hook: it
 * waits until the test has put it in the job, records the job it began in, spawns something first (as a hook's git
 * call does, which puts it in a nested job of Bun's own), then starts a detached child the way a kick does.
 */
describe.skipIf(process.platform !== 'win32')('a detached start from inside a Job Object (G4e)', () => {
  /** When the detached child writes its marker: after the hook has exited and the job is closed. */
  const MARK_AFTER_MS = 2_000;
  const SPAWN = path.resolve(import.meta.dir, '..', '..', 'packages', 'myco', 'src', 'runtime', 'spawn-detached.ts');

  async function startInJob(breakawayOk: boolean): Promise<{ start: { started: boolean; contained?: boolean }; outlived: boolean }> {
    const { dlopen, FFIType, ptr } = await import('bun:ffi');
    const k = dlopen('kernel32.dll', {
      CreateJobObjectW: { args: [FFIType.u64, FFIType.u64], returns: FFIType.u64 },
      SetInformationJobObject: { args: [FFIType.u64, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
      OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.u64 },
      AssignProcessToJobObject: { args: [FFIType.u64, FFIType.u64], returns: FFIType.i32 },
      CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
    }).symbols;
    const job = k.CreateJobObjectW(0n, 0n);
    const limits = new Uint8Array(144);
    // KILL_ON_JOB_CLOSE, and BREAKAWAY_OK when asked.
    new DataView(limits.buffer).setUint32(16, 0x2000 | (breakawayOk ? 0x0800 : 0), true);
    expect(k.SetInformationJobObject(job, 9, ptr(limits), 144)).not.toBe(0);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-job-'));
    const script = path.join(dir, 'hook.ts');
    // The detached child writes this once it has run past the job's close: only a child that left the job does.
    const marker = path.join(dir, 'outlived');
    fs.writeFileSync(script, [
      `import { recordStartingJob, spawnDetached } from ${JSON.stringify(SPAWN)};`,
      `require('node:fs').readFileSync(0);`,
      `recordStartingJob();`,
      `require('node:child_process').spawnSync(process.execPath, ['-e', '0']);`,
      `console.log(JSON.stringify(spawnDetached(process.execPath, ['-e', ${JSON.stringify(`setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'alive'), ${MARK_AFTER_MS})`)}], { cwd: ${JSON.stringify(os.tmpdir())} })));`,
    ].join('\n'));
    const child = spawn(process.execPath, [script], { stdio: ['pipe', 'pipe', 'inherit'] });
    // PROCESS_SET_QUOTA | PROCESS_TERMINATE: what assigning a process to a job needs.
    const handle = k.OpenProcess(0x0100 | 0x0001, 0, child.pid!);
    expect(k.AssignProcessToJobObject(job, handle)).not.toBe(0);
    k.CloseHandle(handle);
    let out = '';
    child.stdout.on('data', (chunk) => { out += String(chunk); });
    const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()));
    child.stdin.end('go');
    await exited;
    k.CloseHandle(job);
    const deadline = Date.now() + MARK_AFTER_MS + 4_000;
    while (!fs.existsSync(marker) && Date.now() < deadline) await Bun.sleep(100);
    const outlived = fs.existsSync(marker);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    return { start: JSON.parse(out.trim()) as { started: boolean; contained?: boolean }, outlived };
  }

  it('answers contained from a job that lets nothing break away, after the hook has spawned anything', async () => {
    const { start, outlived } = await startInJob(false);
    expect(start).toMatchObject({ started: true, contained: true });
    // What it answered is so: the job's close ended the child.
    expect(outlived).toBe(false);
  }, 30_000);

  it('starts free from a job that lets its children break away', async () => {
    const { start, outlived } = await startInJob(true);
    expect(start.started).toBe(true);
    expect(start.contained).toBeUndefined();
    // The child ran on past the job's close.
    expect(outlived).toBe(true);
  }, 30_000);
});
