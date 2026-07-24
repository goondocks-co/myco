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
import {
  RealSchtasksRunner,
  WindowsTaskServiceManager,
} from '@myco/service/windows.js';
import type { ServiceSpec } from '@myco/service/types.js';
import { LifecycleLock } from '@myco/utils/lifecycle-lock.js';
import { resolvePerUserLocksDir } from '@myco/utils/user-lock-root.js';
import { moveFileReplaceWriteThrough } from '@myco/utils/windows-atomic-replace.js';

const LOCK_ROOT_CHILD_MODE = 'lock-root-child';
const LOCK_HOLDER_CHILD_MODE = 'lock-holder-child';
const TASK_CHILD_MODE = 'task-child';
const TASK_MARKER_NAME = 'task-proof.json';
const TASK_LABEL_PREFIX = 'Myco-CI-Native-';
const CHILD_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 50;

interface ContractScope {
  runnerTemp: string;
  executable: string;
  scratch: string;
  taskLabel: string;
}

interface TaskSpecInput {
  taskLabel: string;
  executable: string;
  scratch: string;
}

interface ChildProof {
  executable: string;
  argv: string[];
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

export function buildWindowsNativeTaskSpec(input: TaskSpecInput): ServiceSpec {
  return {
    label: input.taskLabel,
    variant: 'dev',
    executable: input.executable,
    args: [TASK_CHILD_MODE, TASK_MARKER_NAME],
    workingDir: input.scratch,
    env: {
      MYCO_WINDOWS_NATIVE_TASK: '1',
    },
    stdoutPath: path.win32.join(input.scratch, 'task-logs', 'stdout.log'),
    stderrPath: path.win32.join(input.scratch, 'task-logs', 'stderr.log'),
    runAtLoad: false,
    keepAlive: false,
    throttleSeconds: 1,
  };
}

function windowsPathEqual(left: string, right: string): boolean {
  return path.win32.resolve(left).toLowerCase() === path.win32.resolve(right).toLowerCase();
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function assertLimitedTaskRunLevel(xml: string): void {
  const runLevels = [
    ...xml.matchAll(/<RunLevel\b[^>]*>([^<]+)<\/RunLevel>/gi),
  ].map((match) => match[1].trim());
  assertCondition(
    runLevels.length === 0
      || (runLevels.length === 1 && runLevels[0] === 'LeastPrivilege'),
    `Task Scheduler task is not limited-rights: ${JSON.stringify(runLevels)}`,
  );
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

async function waitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + CHILD_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return;
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`timed out waiting for ${filePath}`);
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
  const env = {
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

async function proveNativeLockRoot(scratch: string): Promise<void> {
  const [first, second] = await Promise.all([
    runJsonChild([LOCK_ROOT_CHILD_MODE], divergentChildEnvironment(scratch, 'one')),
    runJsonChild([LOCK_ROOT_CHILD_MODE], divergentChildEnvironment(scratch, 'two')),
  ]);
  const firstRoot = (first as { lockRoot?: unknown }).lockRoot;
  const secondRoot = (second as { lockRoot?: unknown }).lockRoot;
  assertCondition(typeof firstRoot === 'string', 'first child did not report a lock root');
  assertCondition(typeof secondRoot === 'string', 'second child did not report a lock root');
  assertCondition(windowsPathEqual(firstRoot, secondRoot), 'divergent environments resolved different lock roots');
  assertCondition(
    windowsPathEqual(firstRoot, resolvePerUserLocksDir()),
    'child lock root did not match the parent native lock root',
  );
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

export async function cleanupTask(
  manager: TaskCleanupManager,
  runner: TaskCleanupRunner,
  taskLabel: string,
): Promise<void> {
  const cleanupErrors: unknown[] = [];
  try {
    await manager.uninstall(taskLabel);
  } catch (error) {
    cleanupErrors.push(error);
    for (const args of [
      ['/end', '/tn', taskLabel],
      ['/delete', '/tn', taskLabel, '/f'],
    ]) {
      try {
        const result = await runner.run(args);
        if (result.exitCode !== 0) {
          cleanupErrors.push(new Error(
            `schtasks ${args[0]} exited ${result.exitCode}: ${result.stdout}`,
          ));
        }
      } catch (fallbackError) {
        cleanupErrors.push(fallbackError);
      }
    }
  }

  let installed: boolean;
  try {
    installed = await manager.isInstalled(taskLabel);
  } catch (error) {
    throw new AggregateError(
      [...cleanupErrors, error],
      `could not verify exact Task Scheduler cleanup for ${taskLabel}`,
    );
  }
  if (installed) {
    throw new AggregateError(
      cleanupErrors,
      `Task Scheduler task ${taskLabel} remained installed after exact cleanup`,
    );
  }
}

async function proveNativeTaskScheduler(
  scratch: string,
  executable: string,
  taskLabel: string,
): Promise<void> {
  const runner = new RealSchtasksRunner();
  const scriptDir = path.win32.join(scratch, 'Task Scripts %PATH% & ! Ω');
  const manager = new WindowsTaskServiceManager({
    scriptDir,
    resolveDaemonPort: () => null,
  });
  const spec = buildWindowsNativeTaskSpec({ taskLabel, executable, scratch });
  const install = await manager.install(spec);
  assertCondition(install.changed, 'Task Scheduler install did not create the unique contract task');
  assertCondition(await manager.isInstalled(taskLabel), 'Task Scheduler did not report the task installed');

  const inspected = await manager.inspect(taskLabel);
  assertCondition(inspected !== null, 'production Task Scheduler inspection could not prove the command');
  assertCondition(
    windowsPathEqual(inspected.executable, executable),
    `installed executable mismatch: ${inspected.executable}`,
  );
  assertCondition(
    JSON.stringify(inspected.args) === JSON.stringify(spec.args),
    `installed argv mismatch: ${JSON.stringify(inspected.args)}`,
  );

  const xml = await runner.run(['/query', '/tn', taskLabel, '/xml']);
  assertCondition(xml.exitCode === 0, 'Task Scheduler XML query failed');
  assertLimitedTaskRunLevel(xml.stdout);
  assertCondition(
    !/<LogonTrigger\b/i.test(xml.stdout),
    'runAtLoad:false unexpectedly installed a logon trigger',
  );

  const markerPath = path.win32.join(scratch, TASK_MARKER_NAME);
  const taskHost = path.win32.join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  const direct = spawnCapturedProcess(
    taskHost,
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      path.win32.join(scriptDir, `${taskLabel}.ps1`),
    ],
    scratch,
  );
  try {
    await waitForFile(markerPath);
  } catch (error) {
    throw new Error(
      `direct Windows PowerShell launcher probe failed: ${JSON.stringify(direct.output())}`,
      { cause: error },
    );
  } finally {
    await forceTerminateProcessTree(direct.child);
  }
  fs.unlinkSync(markerPath);

  await manager.start(taskLabel);
  try {
    await waitForFile(markerPath);
  } catch (error) {
    const status = await manager.status(taskLabel).catch((statusError: unknown) => ({
      error: statusError instanceof Error ? statusError.message : String(statusError),
    }));
    const verbose = await runner.run(['/query', '/tn', taskLabel, '/fo', 'LIST', '/v'])
      .catch((queryError: unknown) => ({
        stdout: queryError instanceof Error ? queryError.message : String(queryError),
        exitCode: -1,
      }));
    const readLog = (logPath: string): string => {
      try {
        return fs.readFileSync(logPath, 'utf8').slice(0, 4_000);
      } catch (readError) {
        return readError instanceof Error ? readError.message : String(readError);
      }
    };
    throw new Error([
      `Task Scheduler child did not publish ${markerPath}`,
      `status=${JSON.stringify(status)}`,
      `query=${JSON.stringify(verbose)}`,
      `stdout=${JSON.stringify(readLog(spec.stdoutPath))}`,
      `stderr=${JSON.stringify(readLog(spec.stderrPath))}`,
    ].join('\n'), { cause: error });
  }
  const proof = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as ChildProof;
  assertCondition(
    windowsPathEqual(proof.executable, executable),
    `scheduled process executable mismatch: ${proof.executable}`,
  );
  assertCondition(
    JSON.stringify(proof.argv) === JSON.stringify(spec.args),
    `scheduled process argv mismatch: ${JSON.stringify(proof.argv)}`,
  );

  await manager.uninstall(taskLabel);
  assertCondition(!(await manager.isInstalled(taskLabel)), 'Task Scheduler task remained after uninstall');
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

  const fallbackRunner = new RealSchtasksRunner();
  const fallbackManager = new WindowsTaskServiceManager({
    scriptDir: path.win32.join(scratch, 'Task Scripts %PATH% & ! Ω'),
    resolveDaemonPort: () => null,
  });
  let primaryError: unknown;
  const cleanupErrors: unknown[] = [];
  try {
    await runContractStage('long-unicode-replacement', () => proveLongUnicodeReplacement(scratch));
    await runContractStage('native-lock-root', async () => await proveNativeLockRoot(scratch));
    await runContractStage('native-lifecycle-lock', async () => await proveNativeLifecycleLock(scratch));
    await runContractStage(
      'native-task-scheduler',
      async () => await proveNativeTaskScheduler(scratch, executable, taskLabel),
    );
  } catch (error) {
    primaryError = error;
  } finally {
    await cleanupTask(fallbackManager, fallbackRunner, taskLabel)
      .catch((error) => cleanupErrors.push(error));
    try {
      fs.rmSync(path.win32.toNamespacedPath(scratch), { recursive: true, force: true });
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

function runLockRootChild(): void {
  process.stdout.write(JSON.stringify({ lockRoot: resolvePerUserLocksDir() }));
}

function runLockHolderChild(lockPath: string | undefined): void {
  assertCondition(lockPath, 'lock-holder-child requires a lock path');
  const acquired = LifecycleLock.acquire(lockPath, { command: 'windows-native-holder' });
  assertCondition(acquired.acquired, 'lock-holder-child could not acquire its lock');
  process.stdout.write(`READY ${process.pid}\n`);
  setInterval(() => {}, 1_000);
}

function runTaskChild(markerName: string | undefined): void {
  assertCondition(markerName === TASK_MARKER_NAME, 'task-child received an unexpected marker name');
  fs.writeFileSync(
    path.win32.join(process.cwd(), markerName),
    JSON.stringify({
      executable: process.execPath,
      argv: process.argv.slice(2),
    } satisfies ChildProof),
    'utf8',
  );
  setInterval(() => {}, 1_000);
}

async function main(): Promise<void> {
  const [mode, argument] = process.argv.slice(2);
  if (mode === LOCK_ROOT_CHILD_MODE) return runLockRootChild();
  if (mode === LOCK_HOLDER_CHILD_MODE) return runLockHolderChild(argument);
  if (mode === TASK_CHILD_MODE) return runTaskChild(argument);
  await runParentContract();
}

if (import.meta.main) {
  await main();
}
