import { spawnSync } from 'node:child_process';

export function stopTestProcessGroup(pid, signal) {
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      try { process.kill(pid, 0); }
      catch (error) { if (error.code === 'ESRCH') return; throw error; }
      throw new Error(`taskkill failed for test command PID ${pid} (exit ${result.status})`);
    }
    return;
  }
  try { process.kill(-pid, signal); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
}
