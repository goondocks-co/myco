import { spawnSync } from 'node:child_process';

/** The process table's state column for `pid`, or null once the process is gone. */
function tableState(pid: number): string | null {
  const ps = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
  if (ps.error !== undefined) throw ps.error;
  // `ps -p` exits 1 with nothing printed when the process is not in the table.
  if (ps.status === 1 && ps.stdout.trim() === '') return null;
  if (ps.status !== 0) throw new Error(`ps -p ${pid} exited ${ps.status}: ${ps.stderr}`);
  return ps.stdout.trim();
}

/**
 * Whether `pid` is a live process. An exited orphan awaiting the platform's reaper counts as gone, and a process
 * reaped between the signal probe and the table lookup does too.
 */
export function processAlive(pid: number, state: (pid: number) => string | null = tableState): boolean {
  try { process.kill(pid, 0); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
  const stat = state(pid);
  return stat !== null && !stat.startsWith('Z');
}
