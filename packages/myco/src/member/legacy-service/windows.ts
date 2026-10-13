import path from 'node:path';
import { sleep } from '@myco/utils/sleep.js';
import { SERVICE_UNIT_DIR_ENV } from '@myco/paths/service-units.js';
import { spawnCombinedOutput, spawnRawOutput, assertRunSucceeded, type RawCommandOutput } from './run-command.js';



export interface SchtasksRunner {
  run(args: string[]): Promise<{ stdout: string; stderr?: string; exitCode: number }>;
  queryState(label: string): Promise<TaskSchedulerState>;
  currentUserSid(): Promise<string>;
}

export type TaskSchedulerState =
  | 'absent'
  | 'unknown'
  | 'disabled'
  | 'queued'
  | 'ready'
  | 'running';

export class RealSchtasksRunner implements SchtasksRunner {
  protected runPowerShell(args: string[]): Promise<{ stdout: string; exitCode: number }> {
    return spawnCombinedOutput(WINDOWS_TASK_HOST, args);
  }

  async run(args: string[]): Promise<{ stdout: string; stderr?: string; exitCode: number }> {
    if (process.env[SERVICE_UNIT_DIR_ENV]?.trim()) {
      return {
        stdout: `[sandbox] skipped schtasks ${args.join(' ')}`,
        exitCode: args[0] === '/query' ? 1 : 0,
      };
    }
    const result = await this.runSchtasks(args);
    const stderr = result.stderr.toString('utf8');
    if (args[0]?.toLowerCase() === '/query' && args.some(arg => arg.toLowerCase() === '/xml')) {
      return { stdout: decodeTaskXmlOutput(result.stdout), stderr, exitCode: result.exitCode };
    }
    return { stdout: result.stdout.toString('utf8') + stderr, exitCode: result.exitCode };
  }

  protected runSchtasks(args: string[]): Promise<RawCommandOutput> {
    return spawnRawOutput('schtasks', args);
  }

  async queryState(label: string): Promise<TaskSchedulerState> {
    if (process.env[SERVICE_UNIT_DIR_ENV]?.trim()) return 'absent';
    const escapedLabel = label.replace(/'/g, "''");
    const command = [
      'try {',
      `$tasks = @(Get-ScheduledTask -TaskPath '\\' -ErrorAction Stop | Where-Object { $_.TaskName -ceq '${escapedLabel}' })`,
      "if ($tasks.Count -eq 0) { Write-Output '-1' }",
      'elseif ($tasks.Count -eq 1) { Write-Output ([int]$tasks[0].State) }',
      "else { throw 'Multiple exact-name tasks found' }",
      '} catch { Write-Error $_; exit 1 }',
    ].join('\n');
    const result = await this.runPowerShell([
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      command,
    ]);
    assertRunSucceeded(result, `PowerShell Get-ScheduledTask ${label}`);
    const output = result.stdout.trim();
    if (!/^-?\d+$/.test(output)) {
      throw new Error(`Invalid Task Scheduler state for ${label}: ${JSON.stringify(output)}`);
    }
    return taskSchedulerStateFromNumber(parseInt(output, 10), label);
  }

  async currentUserSid(): Promise<string> {
    if (process.env[SERVICE_UNIT_DIR_ENV]?.trim()) return 'S-1-0-0';
    const result = await this.runPowerShell([
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '[Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
    ]);
    assertRunSucceeded(result, 'PowerShell current Windows user SID');
    const sid = result.stdout.trim();
    if (!/^S-\d+(?:-\d+)+$/i.test(sid)) {
      throw new Error(`Invalid current Windows user SID: ${JSON.stringify(sid)}`);
    }
    return sid;
  }
}

export interface WindowsManagerOptions {
  runner?: SchtasksRunner;
  sleep?: (delayMs: number) => Promise<void>;
}

const WINDOWS_TEARDOWN_TIMEOUT_MS = 10_000;
const WINDOWS_TEARDOWN_POLL_INTERVAL_MS = 100;
const WINDOWS_TASK_HOST = path.win32.join(
  process.env.SystemRoot ?? 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
);

function decodeTaskXmlOutput(bytes: Buffer): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString('utf16le');
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return Buffer.from(bytes.subarray(2)).swap16().toString('utf16le');
  if (bytes[0] === 0x3c && bytes[1] === 0) return bytes.toString('utf16le');
  return bytes.toString('utf8');
}

function taskActionMatchesLauncher(action: ReturnType<typeof parseTaskAction>, launcherFile: string): boolean {
  if (action?.command.toLowerCase() !== WINDOWS_TASK_HOST.toLowerCase()) return false;
  const encoded = /^-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ([A-Za-z0-9+/]+={0,2})$/i.exec(action.arguments)?.[1];
  if (encoded === undefined) return false;
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length % 2 !== 0 || bytes.toString('base64') !== encoded) return false;
  const literal = /^& '((?:[^']|'')*)'$/.exec(bytes.toString('utf16le'))?.[1];
  if (literal === undefined) return false;
  const decodedPath = literal.replaceAll("''", "'");
  return path.win32.isAbsolute(decodedPath)
    && path.win32.parse(path.win32.normalize(decodedPath)).root.toLowerCase() === path.win32.parse(path.win32.normalize(launcherFile)).root.toLowerCase()
    && path.win32.resolve(decodedPath).toLowerCase() === path.win32.resolve(launcherFile).toLowerCase();
}

export class WindowsTaskServiceManager {
  private readonly runner: SchtasksRunner;
  private readonly sleep: (delayMs: number) => Promise<void>;

  constructor(opts: WindowsManagerOptions = {}) {
    this.runner = opts.runner ?? new RealSchtasksRunner();
    this.sleep = opts.sleep ?? sleep;
  }

    async unregisterAfterDrain(
    label: string,
    launcherFile: string,
    drain: () => Promise<'stopped' | 'none' | 'not-this-home'>,
    backupTask: (label: string, xml: string, previouslyDisabled: boolean) => void,
  ): Promise<void> {
    const before = await this.requireTaskState(label);
    if (before === 'absent') return;
    const task = await this.runner.run(['/query', '/tn', label, '/xml']);
    assertRunSucceeded(task, `schtasks /query /tn ${label}`);
    const action = parseTaskAction(task.stdout);
    const principal = singleXmlElementBody(task.stdout, 'Principal');
    const sid = await this.runner.currentUserSid();
    if (!taskActionMatchesLauncher(action, launcherFile)
      || principal === null
      || singleXmlText(principal, 'UserId')?.toLowerCase() !== sid.toLowerCase()
      || singleXmlText(principal, 'LogonType') !== 'InteractiveToken') {
      throw new Error(`Task Scheduler task ${label} does not belong to this user's launcher ${launcherFile}`);
    }
    backupTask(label, task.stdout, before === 'disabled');
    assertRunSucceeded(
      await this.runner.run(['/change', '/tn', label, '/disable']),
      `schtasks /change /tn ${label} /disable`,
    );
    const stopped = await drain();
    if (stopped === 'not-this-home' || (stopped !== 'stopped' && (before === 'running' || before === 'queued'))) {
      throw new Error(`Task Scheduler task ${label} is disabled but its home daemon did not confirm shutdown; its launcher is retained`);
    }
    await this.waitUntilNotRunning(label);
    assertRunSucceeded(await this.runner.run(['/delete', '/tn', label, '/f']), `schtasks /delete /tn ${label}`);
    await this.waitUntilDeleted(label);
  }

  private async requireTaskState(label: string): Promise<TaskSchedulerState> {
    const state = await this.runner.queryState(label);
    if (state === 'unknown') {
      throw new Error(`Unknown Task Scheduler state for ${label}`);
    }
    return state;
  }

  private async waitUntilNotRunning(label: string): Promise<void> {
    const maxPolls = Math.ceil(WINDOWS_TEARDOWN_TIMEOUT_MS / WINDOWS_TEARDOWN_POLL_INTERVAL_MS);
    for (let poll = 0; poll <= maxPolls; poll++) {
      const state = await this.requireTaskState(label);
      if (state === 'absent' || state !== 'running') return;
      if (poll < maxPolls) await this.sleep(WINDOWS_TEARDOWN_POLL_INTERVAL_MS);
    }
    throw new Error(`Timed out waiting for Task Scheduler task ${label} to exit`);
  }

  private async waitUntilDeleted(label: string): Promise<void> {
    const maxPolls = Math.ceil(WINDOWS_TEARDOWN_TIMEOUT_MS / WINDOWS_TEARDOWN_POLL_INTERVAL_MS);
    for (let poll = 0; poll <= maxPolls; poll++) {
      if ((await this.requireTaskState(label)) === 'absent') return;
      if (poll < maxPolls) await this.sleep(WINDOWS_TEARDOWN_POLL_INTERVAL_MS);
    }
    throw new Error(`Timed out waiting for Task Scheduler task ${label} deletion`);
  }
}

function parseTaskAction(
  xml: string,
): { command: string; arguments: string } | null {
  const commands = [...xml.matchAll(/<Command>([\s\S]*?)<\/Command>/gi)];
  const argumentsElements = [...xml.matchAll(/<Arguments>([\s\S]*?)<\/Arguments>/gi)];
  if (commands.length !== 1 || argumentsElements.length !== 1) return null;
  const command = decodeXmlText(commands[0][1]);
  const argumentsValue = decodeXmlText(argumentsElements[0][1]);
  return command === null || argumentsValue === null
    ? null
    : { command, arguments: argumentsValue };
}

function singleXmlElementBody(xml: string, element: string): string | null {
  const pattern = new RegExp(`<${element}\\b[^>]*>([\\s\\S]*?)<\\/${element}>`, 'gi');
  const matches = [...xml.matchAll(pattern)];
  return matches.length === 1 ? matches[0][1] : null;
}

function singleXmlText(xml: string, element: string): string | null {
  const body = singleXmlElementBody(xml, element);
  if (body === null) return null;
  const decoded = decodeXmlText(body);
  return decoded?.trim() ?? null;
}

function decodeXmlText(value: string): string | null {
  if (/&(?!(?:amp|lt|gt|quot|apos);)/.test(value)) return null;
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function taskSchedulerStateFromNumber(state: number, label: string): TaskSchedulerState {
  switch (state) {
    case -1: return 'absent';
    case 0: return 'unknown';
    case 1: return 'disabled';
    case 2: return 'queued';
    case 3: return 'ready';
    case 4: return 'running';
    default: throw new Error(`Invalid Task Scheduler state ${state} for ${label}`);
  }
}
