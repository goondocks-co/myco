import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { testExecHelper } from './test-service-exec.mjs';

const REGISTRY_NAME = '.test-processes';
const PROCESS_QUERY_TIMEOUT_MS = 15_000;
const PROCESS_EXIT_TIMEOUT_MS = 10_000;

function windowsProcess(pid, action = '$p.StartTime.ToUniversalTime().ToFileTimeUtc().ToString()') {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('Test process PID must be positive');
  const command = `$ErrorActionPreference = 'Stop'; try { $p = [System.Diagnostics.Process]::GetProcessById(${pid}) } catch [System.ArgumentException] { exit 0 }; try { $null = $p.Handle; ${action} } finally { $p.Dispose() }`;
  const result = spawnSync(process.env.MYCO_TEST_PWSH_EXECUTABLE ?? 'pwsh', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', timeout: PROCESS_QUERY_TIMEOUT_MS });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Windows test process operation failed for PID ${pid} (exit ${result.status}): ${result.stderr}`);
  return result.stdout.trim();
}

function windowsIdentity(pid) {
  const identity = windowsProcess(pid);
  if (identity && !/^\d+$/.test(identity)) throw new Error('Invalid Windows test process identity');
  return identity || null;
}

let identityReader = windowsIdentity;

export function useTestProcessIdentityReader(reader) {
  const previous = identityReader;
  identityReader = reader ?? windowsIdentity;
  return () => { identityReader = previous; };
}

// Registration either records the live child or stops that child before failing.
export function registerTestProcess(child, root = process.env.MYCO_TEST_RUN_ROOT) {
  if (process.platform !== 'win32' || !child.pid) return;
  const pid = child.pid;
  try {
    if (!root) throw new Error('Test process registration requires a run root');
    const identity = identityReader(pid);
    if (identity === null) {
      try { process.kill(pid, 0); }
      catch (error) { if (error.code === 'ESRCH') return; throw error; }
      throw new Error(`Cannot register live Windows test process PID ${pid}`);
    }
    const dir = path.join(root, REGISTRY_NAME);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${pid}.json`);
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ pid, identity }));
    fs.renameSync(temporary, file);
  } catch (error) {
    child.kill('SIGKILL');
    throw error;
  }
}

export function stopRegisteredTestProcesses(root = process.env.MYCO_TEST_RUN_ROOT) {
  if (process.platform === 'win32') {
    const dir = path.join(root, REGISTRY_NAME);
    let files;
    try { files = fs.readdirSync(dir).filter((name) => name.endsWith('.json')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; files = []; }
    const errors = [];
    for (const file of files) {
      try {
        const record = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
        if (!/^\d+$/.test(record.identity)) throw new Error('Invalid registered Windows process identity');
        // Handle acquisition precedes identity validation and termination.
        windowsProcess(record.pid, `if ($p.StartTime.ToUniversalTime().ToFileTimeUtc().ToString() -eq '${record.identity}') { $p.Kill($true); if (!$p.WaitForExit(${PROCESS_EXIT_TIMEOUT_MS})) { throw 'Test process did not exit' } }`);
      } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Windows test process cleanup failed');
    return;
  }
}

export function stopTestProcessGroup(pid, signal, root = process.env.MYCO_TEST_RUN_ROOT) {
  if (process.platform === 'win32') return stopRegisteredTestProcesses(root);
  try { process.kill(-pid, signal); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
}

function processSample(pid, field, override) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('Test process PID must be positive');
  const native = process.platform === 'darwin' && !override;
  const command = override ?? (native ? testExecHelper('process-info', 'test-process-info.c', ['-lproc']) : 'ps');
  const format = { rss: 'rss=', state: 'stat=', pgid: 'pgid=', command: 'command=' }[field];
  const args = native ? [String(pid), ...(field === 'rss' ? [] : [field])] : ['-o', format, '-p', String(pid)];
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: PROCESS_QUERY_TIMEOUT_MS });
  if (result.error) throw result.error;
  if (field === 'state' && result.status === 1 && !result.stdout.trim() && !result.stderr.trim()) return null;
  if (result.status !== 0) throw new Error(`Test process ${field} probe failed for PID ${pid} (exit ${result.status}): ${result.stderr}`);
  return result.stdout.trim();
}

export function readTestProcessRssKiB(pid) {
  const rss = Number(processSample(pid, 'rss'));
  if (!Number.isFinite(rss) || rss < 0) throw new Error('Invalid test RSS sample');
  return rss;
}

export function readTestProcessGroupId(pid) {
  const group = Number(processSample(pid, 'pgid'));
  if (!Number.isInteger(group) || group <= 0) throw new Error('Invalid test process group');
  return group;
}

export function readTestProcessState(pid, override) {
  return processSample(pid, 'state', override) || null;
}

export function readTestProcessTable() {
  const command = process.platform === 'darwin' ? testExecHelper('process-info', 'test-process-info.c', ['-lproc']) : 'ps';
  const args = process.platform === 'darwin' ? ['list'] : ['-axo', 'pid=,ppid=,pgid=,lstart='];
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: PROCESS_QUERY_TIMEOUT_MS });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Test process table failed (exit ${result.status}): ${result.stderr}`);
  const table = new Map();
  for (const line of result.stdout.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
    if (match) table.set(Number(match[1]), { ppid: Number(match[2]), pgid: Number(match[3]), started: match[4].replace(/\s+/g, ' ') });
  }
  return table;
}

export function readTestProcessCommands(pids) {
  const table = readTestProcessTable();
  return pids.flatMap(pid => {
    const row = table.get(pid);
    if (!row) return [];
    const args = processSample(pid, 'command');
    const command = process.platform === 'darwin' ? args.replace(/^\d+\s*/, '') : args;
    return [`${pid} ${row.ppid} ${row.pgid} ${command}`];
  }).join('\n');
}
