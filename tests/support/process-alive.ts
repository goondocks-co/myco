import { readTestProcessState } from '../../scripts/test-process-tree.mjs';

/**
 * Whether `pid` is a live process. An exited orphan awaiting the platform's reaper counts as gone, and a process
 * reaped between the signal probe and the table lookup does too.
 */
export function processAlive(pid: number, state: (pid: number) => string | null = readTestProcessState): boolean {
  try { process.kill(pid, 0); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
  const stat = state(pid);
  return stat !== null && !stat.startsWith('Z');
}
