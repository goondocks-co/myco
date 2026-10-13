/*
 * Copyright 2026 Myco Contributors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { LifecycleLock } from '@myco/utils/lifecycle-lock.js';
import { moveFileReplaceWriteThrough } from '@myco/utils/windows-atomic-replace.js';
import { isProcessAlive, waitForProcessExit } from '@goondocks/myco-shared';
const LOCK_HOLDER_CHILD_MODE = 'lock-holder-child';
const TASK_LABEL_PREFIX = 'Myco-CI-Native-';
const CHILD_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 50;
const CLEANUP_TIMEOUT_MS = 10_000;
const TRANSIENT_WINDOWS_CLEANUP_ERRORS = new Set(['EBUSY', 'ENOTEMPTY', 'EPERM']);

interface ContractScope {
  runnerTemp: string;
  executable: string;
  scratch: string;
  taskLabel: string;
}

interface ChildProof {
  executable: string;
  argv: string[];
  pid: number;
}

interface TaskCleanupManager {
  uninstall(taskLabel: string): Promise<void>;
  isInstalled(taskLabel: string): Promise<boolean>;
}

interface TaskCleanupRunner {
  run(args: string[]): Promise<{ stdout: string; exitCode: number }>;
}

function assertAbsoluteWindowsPath(value: string, label: string): string {
  if (!path.win32.isAbsolute(value) || value.includes('\0')) {
    throw new Error(`${label} must be an absolute Windows path`);
  }
  return path.win32.resolve(value);
}

function assertDescendant(root: string, target: string, label: string): void {
  const relative = path.win32.relative(root, target);
  if (relative === '' || relative.startsWith('..') || path.win32.isAbsolute(relative)) {
    throw new Error(`${label} must be a strict descendant of RUNNER_TEMP`);
  }
}

export function assertWindowsNativeContractScope(scope: ContractScope): void {
  const runnerTemp = assertAbsoluteWindowsPath(scope.runnerTemp, 'RUNNER_TEMP');
  const executable = assertAbsoluteWindowsPath(scope.executable, 'contract executable');
  const scratch = assertAbsoluteWindowsPath(scope.scratch, 'contract scratch');
  assertDescendant(runnerTemp, executable, 'contract executable');
  assertDescendant(runnerTemp, scratch, 'contract scratch');
  if (!scope.taskLabel.startsWith(TASK_LABEL_PREFIX)
    || !/^[A-Za-z0-9._-]+$/.test(scope.taskLabel)
    || scope.taskLabel.length > 200) {
    throw new Error(`contract task label must use the ${TASK_LABEL_PREFIX} namespace`);
  }
}

function windowsPathEqual(left: string, right: string): boolean {
  return path.win32.resolve(left).toLowerCase() === path.win32.resolve(right).toLowerCase();
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function spawnSelf(args: string[], env: NodeJS.ProcessEnv = process.env): ChildProcess {
  return spawn(process.execPath, args, {
    cwd: process.cwd(),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

function spawnCapturedProcess(
  executable: string,
  args: string[],
  cwd: string,
): {
  child: ChildProcess;
  output: () => { stdout: string; stderr: string };
} {
  const child = spawn(executable, args, {
    cwd,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
  return {
    child,
    output: () => ({ stdout, stderr }),
  };
}

function waitForExit(child: ChildProcess, timeoutMs = CHILD_TIMEOUT_MS): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`child ${child.pid ?? 'unknown'} did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function runJsonChild(args: string[], env: NodeJS.ProcessEnv): Promise<unknown> {
  const child = spawnSelf(args, env);
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
  await waitForExit(child);
  if (child.exitCode !== 0) {
    throw new Error(`child ${args[0] ?? 'unknown'} exited ${child.exitCode}: ${stderr}`);
  }
  return JSON.parse(stdout);
}

async function waitForReady(child: ChildProcess): Promise<void> {
  let stdout = '';
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`lock holder did not become ready: ${stderr}`));
    }, CHILD_TIMEOUT_MS);
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      if (stdout.includes('READY')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`lock holder exited before readiness with code ${code}: ${stderr}`));
    });
  });
}

function proveLongUnicodeReplacement(scratch: string): void {
  const deepDirectory = path.win32.join(
    scratch,
    'MoveFileExW Ω',
    '深'.repeat(80),
    'a'.repeat(80),
    'b'.repeat(80),
  );
  const source = path.win32.join(deepDirectory, 'source-旧.tmp');
  const destination = path.win32.join(deepDirectory, 'destination-现有.txt');
  assertCondition(destination.length > 260, 'replacement destination did not exceed 260 characters');

  const namespacedDirectory = path.win32.toNamespacedPath(deepDirectory);
  const namespacedSource = path.win32.toNamespacedPath(source);
  const namespacedDestination = path.win32.toNamespacedPath(destination);
  fs.mkdirSync(namespacedDirectory, { recursive: true });
  fs.writeFileSync(namespacedSource, 'new-bytes-Ω', 'utf8');
  fs.writeFileSync(namespacedDestination, 'old-bytes', 'utf8');

  moveFileReplaceWriteThrough(source, destination);

  assertCondition(
    fs.readFileSync(namespacedDestination, 'utf8') === 'new-bytes-Ω',
    'MoveFileExW replacement did not publish the new bytes',
  );
  assertCondition(!fs.existsSync(namespacedSource), 'MoveFileExW replacement left the source behind');
}

function divergentChildEnvironment(scratch: string, name: string): NodeJS.ProcessEnv {
  const poison = path.win32.join(scratch, `environment-${name}`);
  const temp = path.win32.join(poison, 'Temp');
  fs.mkdirSync(path.win32.toNamespacedPath(temp), { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: path.win32.join(poison, 'Home'),
    USERPROFILE: path.win32.join(poison, 'UserProfile'),
    LOCALAPPDATA: path.win32.join(poison, 'LocalAppData'),
    MYCO_HOME: path.win32.join(poison, 'MycoHome'),
    TEMP: temp,
    TMP: temp,
  };
  delete env.MYCO_LAUNCH_AGENTS_DIR;
  return env;
}

async function forceTerminate(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = waitForExit(child);
  assertCondition(child.kill('SIGKILL'), `failed to force-terminate lock holder ${child.pid ?? 'unknown'}`);
  await exited;
}

async function forceTerminateProcessTree(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  assertCondition(child.pid !== undefined, 'direct launcher probe has no process id');
  const exited = waitForExit(child);
  const taskkill = spawn('taskkill.exe', [
    '/PID',
    String(child.pid),
    '/T',
    '/F',
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  taskkill.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
  await waitForExit(taskkill);
  if (taskkill.exitCode !== 0
    && child.exitCode === null
    && child.signalCode === null) {
    throw new Error(`taskkill failed for direct launcher ${child.pid}: ${stderr}`);
  }
  await exited;
}

async function proveNativeLifecycleLock(scratch: string): Promise<void> {
  const lockPath = path.win32.join(scratch, 'locks', 'native.lock');
  const holder = spawnSelf([LOCK_HOLDER_CHILD_MODE, lockPath]);
  try {
    await waitForReady(holder);
    const refused = LifecycleLock.acquire(lockPath, { command: 'windows-native-contender' });
    assertCondition(!refused.acquired, 'LockFileEx allowed a second process to acquire the held lock');
    assertCondition(
      refused.holderPid === holder.pid,
      `LockFileEx refusal reported holder ${refused.holderPid} instead of ${holder.pid}`,
    );

    await forceTerminate(holder);
    const deadline = Date.now() + CHILD_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const reacquired = LifecycleLock.acquire(lockPath, { command: 'windows-native-reacquire' });
      if (reacquired.acquired) {
        reacquired.lock.release();
        return;
      }
      await sleep(POLL_INTERVAL_MS);
    }
    throw new Error('LockFileEx lock was not reacquirable after forced holder termination');
  } finally {
    await forceTerminate(holder).catch(() => {});
  }
}

async function removeScratchDirectory(scratch: string): Promise<void> {
  const deadline = Date.now() + CLEANUP_TIMEOUT_MS;
  for (;;) {
    try {
      fs.rmSync(path.win32.toNamespacedPath(scratch), { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!code || !TRANSIENT_WINDOWS_CLEANUP_ERRORS.has(code) || Date.now() >= deadline) {
        throw error;
      }
      await sleep(POLL_INTERVAL_MS);
    }
  }
}

async function runContractStage(
  name: string,
  stage: () => void | Promise<void>,
): Promise<void> {
  process.stderr.write(`WINDOWS_NATIVE_STAGE ${name} start\n`);
  try {
    await stage();
  } catch (error) {
    throw new Error(`Windows native contract stage ${name} failed`, { cause: error });
  }
  process.stderr.write(`WINDOWS_NATIVE_STAGE ${name} complete\n`);
}

async function runParentContract(): Promise<void> {
  assertCondition(process.platform === 'win32', 'Windows native contract must run on Windows');
  assertCondition(
    !process.env.MYCO_LAUNCH_AGENTS_DIR,
    'MYCO_LAUNCH_AGENTS_DIR must remain unset for the native Task Scheduler proof',
  );

  const runnerTemp = process.env.RUNNER_TEMP;
  const scratch = process.env.MYCO_WINDOWS_NATIVE_SCRATCH;
  const taskLabel = process.env.MYCO_WINDOWS_NATIVE_TASK_LABEL;
  assertCondition(runnerTemp, 'RUNNER_TEMP is required');
  assertCondition(scratch, 'MYCO_WINDOWS_NATIVE_SCRATCH is required');
  assertCondition(taskLabel, 'MYCO_WINDOWS_NATIVE_TASK_LABEL is required');
  const executable = process.execPath;
  assertWindowsNativeContractScope({ runnerTemp, executable, scratch, taskLabel });
  assertCondition(!fs.existsSync(scratch), `contract scratch already exists: ${scratch}`);
  fs.mkdirSync(scratch);

  let primaryError: unknown;
  const cleanupErrors: unknown[] = [];
  try {
    await runContractStage('long-unicode-replacement', () => proveLongUnicodeReplacement(scratch));
    await runContractStage('native-lifecycle-lock', async () => await proveNativeLifecycleLock(scratch));
  } catch (error) {
    primaryError = error;
  } finally {
    try {
      await removeScratchDirectory(scratch);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }

  if (primaryError !== undefined && cleanupErrors.length > 0) {
    throw new AggregateError(
      [primaryError, ...cleanupErrors],
      'Windows native contract failed and exact cleanup also failed',
    );
  }
  if (primaryError !== undefined) throw primaryError;
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, 'Windows native contract exact cleanup failed');
  }
  process.stdout.write('WINDOWS_NATIVE_CONTRACT_OK\n');
}

function runLockHolderChild(lockPath: string | undefined): void {
  assertCondition(lockPath, 'lock-holder-child requires a lock path');
  const acquired = LifecycleLock.acquire(lockPath, { command: 'windows-native-holder' });
  assertCondition(acquired.acquired, 'lock-holder-child could not acquire its lock');
  process.stdout.write(`READY ${process.pid}\n`);
  setInterval(() => {}, 1_000);
}

async function main(): Promise<void> {
  const [mode, argument] = process.argv.slice(2);
  if (mode === LOCK_HOLDER_CHILD_MODE) return runLockHolderChild(argument);
  await runParentContract();
}

if (import.meta.main) {
  await main();
}
