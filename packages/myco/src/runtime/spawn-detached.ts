/**
 * Start a process apart from this one, so it outlives it: in its own session or process group, with no stdio tied to
 * this process's, and no console window on Windows. A start that fails answers `started: false` and never throws.
 *
 * On Windows the child is asked to break away from any Job Object this process runs in (`CREATE_BREAKAWAY_FROM_JOB`):
 * a harness that runs its hooks in a kill-on-close job would otherwise end the child with the hook. A job that forbids
 * breakaway refuses that start (`ERROR_ACCESS_DENIED`), and the child is started inside the job instead, answered as
 * `contained`, and ends with this process's job; a caller that must not lose the work does it in-process instead.
 *
 * That refusal is only seen from the job a process is directly in. Bun puts a process that has spawned anything into
 * a job of its own (which allows breakaway) nested under the job that started it, and a start from there breaks away
 * from Bun's job alone, into the starting job, which then ends it. So the starting job is read once, before anything
 * is spawned (`recordStartingJob`), and a start from a job that kills what it holds and lets nothing break away is
 * answered `contained` whatever `CreateProcessW` would say.
 *
 * Everything the child needs travels on its command line: the Windows start passes the environment this process
 * started with, not changes made to it since.
 */
import { spawn } from 'node:child_process';
import { dlopen, FFIType, ptr } from 'bun:ffi';

export interface DetachedStart {
  started: boolean;
  /** The child's process id, where the start reports one. */
  pid?: number;
  /** Windows only: the child runs inside this process's Job Object, which refused to let it break away. */
  contained?: boolean;
}

export type DetachedSpawn = (command: string, args: readonly string[], opts: { cwd: string }) => DetachedStart;

const posixSpawnDetached: DetachedSpawn = (command, args, opts) => {
  try {
    const child = spawn(command, [...args], { cwd: opts.cwd, detached: true, stdio: 'ignore' });
    child.on('error', () => { /* a failed start is answered below, or found by the next caller */ });
    child.unref();
    return typeof child.pid === 'number' ? { started: true, pid: child.pid } : { started: false };
  } catch {
    return { started: false };
  }
};

// CreateProcessW flags. None has bit 31 set, which bun:ffi marshals wrongly for a u32.
const DETACHED_PROCESS = 0x0000_0008;
const CREATE_NEW_PROCESS_GROUP = 0x0000_0200;
const CREATE_BREAKAWAY_FROM_JOB = 0x0100_0000;
const ERROR_ACCESS_DENIED = 5;

/** `sizeof(STARTUPINFOW)` and `sizeof(PROCESS_INFORMATION)` on 64-bit Windows, x64 and ARM64 alike. */
const STARTUPINFOW_BYTES = 104;
const PROCESS_INFORMATION_BYTES = 24;

interface ProcessApi {
  CreateProcessW: (
    application: number, commandLine: number, processAttrs: bigint, threadAttrs: bigint, inherit: number,
    flags: number, environment: bigint, cwd: number, startupInfo: number, processInfo: number,
  ) => number;
  CloseHandle: (handle: bigint) => number;
  GetLastError: () => number;
  QueryInformationJobObject: (job: bigint, infoClass: number, info: number, length: number, returned: bigint) => number;
}

let processApi: ProcessApi | null = null;

function loadProcessApi(): ProcessApi {
  if (processApi) return processApi;
  const lib = dlopen('kernel32.dll', {
    CreateProcessW: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.u64, FFIType.i32, FFIType.u32, FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.ptr],
      returns: FFIType.i32,
    },
    CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
    GetLastError: { args: [], returns: FFIType.u32 },
    QueryInformationJobObject: { args: [FFIType.u64, FFIType.i32, FFIType.ptr, FFIType.u32, FFIType.u64], returns: FFIType.i32 },
  });
  processApi = lib.symbols as unknown as ProcessApi;
  return processApi;
}

/**
 * One argument as the Windows command-line parser reads it back: quoted when it holds a space, a tab or a quote, with
 * the backslashes before a quote doubled (`CommandLineToArgvW`'s rules).
 */
export function windowsArgument(arg: string): string {
  if (arg.length > 0 && !/[\s"]/.test(arg)) return arg;
  let out = '"';
  let backslashes = 0;
  for (const ch of arg) {
    if (ch === '\\') { backslashes += 1; continue; }
    if (ch === '"') { out += '\\'.repeat(backslashes * 2 + 1) + '"'; backslashes = 0; continue; }
    out += '\\'.repeat(backslashes) + ch;
    backslashes = 0;
  }
  return out + '\\'.repeat(backslashes * 2) + '"';
}

/** `QueryInformationJobObject` class for `JOBOBJECT_EXTENDED_LIMIT_INFORMATION`, and what is read from it. */
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9;
const JOB_EXTENDED_LIMIT_BYTES = 144;
const LIMIT_FLAGS_OFFSET = 16;
const JOB_OBJECT_LIMIT_BREAKAWAY_OK = 0x0000_0800;
const JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK = 0x0000_1000;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x0000_2000;

/** Whether the job this process started in ends what it holds and lets nothing break away; null until recorded. */
let startingJobHolds: boolean | null = null;

/** Whether a job's limit flags kill what it holds when it closes and let nothing break away. */
export function jobHoldsChildren(flags: number): boolean {
  return (flags & JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE) !== 0
    && (flags & (JOB_OBJECT_LIMIT_BREAKAWAY_OK | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK)) === 0;
}

/**
 * Read the job this process was started in, before it spawns anything (Windows only; a no-op elsewhere, and once).
 * What a detached start from this process can do depends on it (`spawnDetached`).
 */
export function recordStartingJob(): void {
  if (process.platform !== 'win32' || startingJobHolds !== null) return;
  try {
    const api = loadProcessApi();
    const info = new Uint8Array(JOB_EXTENDED_LIMIT_BYTES);
    // A null job handle names the job this process is in; no job, and the call fails.
    const read = api.QueryInformationJobObject(0n, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, ptr(info), JOB_EXTENDED_LIMIT_BYTES, 0n);
    startingJobHolds = read !== 0 && jobHoldsChildren(new DataView(info.buffer).getUint32(LIMIT_FLAGS_OFFSET, true));
  } catch {
    startingJobHolds = false;
  }
}

const winSpawnDetached: DetachedSpawn = (command, args, opts) => {
  let api: ProcessApi;
  try {
    api = loadProcessApi();
  } catch {
    return { started: false };
  }
  const application = Buffer.from(`${command}\0`, 'utf16le');
  const cwd = Buffer.from(`${opts.cwd}\0`, 'utf16le');
  const attempt = (flags: number): { ok: boolean; error: number; pid?: number } => {
    // CreateProcessW may write into the command line, so each attempt gets a buffer of its own. Every buffer is held
    // in a local across the call: `ptr()` is a plain address, and a buffer collected before the call returns is a
    // dangling one.
    const commandLine = Buffer.from(`${[command, ...args].map(windowsArgument).join(' ')}\0`, 'utf16le');
    const startup = new Uint8Array(STARTUPINFOW_BYTES);
    new DataView(startup.buffer).setUint32(0, STARTUPINFOW_BYTES, true);
    const info = new Uint8Array(PROCESS_INFORMATION_BYTES);
    const ok = api.CreateProcessW(ptr(application), ptr(commandLine), 0n, 0n, 0, flags, 0n, ptr(cwd), ptr(startup), ptr(info));
    if (ok === 0) return { ok: false, error: api.GetLastError() };
    const view = new DataView(info.buffer);
    api.CloseHandle(view.getBigUint64(0, true));
    api.CloseHandle(view.getBigUint64(8, true));
    // PROCESS_INFORMATION: hProcess, hThread, then dwProcessId.
    return { ok: true, error: 0, pid: view.getUint32(16, true) };
  };
  const base = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP;
  // The job that started this process lets nothing it holds outlive it: the start is contained however it is asked.
  if (startingJobHolds === true) {
    const inJob = attempt(base);
    return inJob.ok ? { started: true, pid: inJob.pid, contained: true } : { started: false };
  }
  const free = attempt(base | CREATE_BREAKAWAY_FROM_JOB);
  if (free.ok) return { started: true, pid: free.pid };
  if (free.error !== ERROR_ACCESS_DENIED) return { started: false };
  const inJob = attempt(base);
  return inJob.ok ? { started: true, pid: inJob.pid, contained: true } : { started: false };
};

export const spawnDetached: DetachedSpawn = process.platform === 'win32' ? winSpawnDetached : posixSpawnDetached;
