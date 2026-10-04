import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const REGISTRY_NAME = '.test-processes';

function windowsIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('Test process PID must be positive');
  const command = `$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if ($p) { $p.CreationDate.ToUniversalTime().Ticks.ToString() }`;
  const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Cannot read Windows test process identity (exit ${result.status}): ${result.stderr}`);
  const identity = result.stdout.trim();
  if (identity && !/^\d+$/.test(identity)) throw new Error('Invalid Windows test process identity');
  return identity || null;
}

// Long-lived test descendants register while their process identity is live.
export function registerTestProcess(pid, root = process.env.MYCO_TEST_RUN_ROOT) {
  if (process.platform !== 'win32') return;
  if (!root) throw new Error('Test process registration requires a run root');
  const identity = windowsIdentity(pid);
  if (identity === null) return;
  const dir = path.join(root, REGISTRY_NAME);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${pid}.json`);
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ pid, identity }));
  fs.renameSync(temporary, file);
}

export function stopTestProcessGroup(pid, signal, root = process.env.MYCO_TEST_RUN_ROOT) {
  if (process.platform === 'win32') {
    const dir = path.join(root, REGISTRY_NAME);
    let files;
    try { files = fs.readdirSync(dir).filter((name) => name.endsWith('.json')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; files = []; }
    for (const file of files) {
      const record = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      if (windowsIdentity(record.pid) !== record.identity) continue;
      const result = spawnSync('taskkill', ['/PID', String(record.pid), '/T', '/F'], { stdio: 'ignore' });
      if (result.error) throw result.error;
      if (result.status !== 0 && windowsIdentity(record.pid) === record.identity) {
        throw new Error(`taskkill failed for test command PID ${record.pid} (exit ${result.status})`);
      }
    }
    return;
  }
  try { process.kill(-pid, signal); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
}
