/**
 * Keeping the machine awake while its worker drives a run.
 *
 * A worker that holds a lease has told the Deployment it will finish the run,
 * and a machine that goes to sleep partway through breaks that: the lease lapses
 * while it sleeps and the run goes back to the queue with its harness session
 * spent. So for as long as a run is driven, the worker holds the platform's
 * assertion against sleep, and releases it when the run ends.
 *
 * On macOS that is `caffeinate`: `-i` holds off idle sleep, `-s` holds off
 * system sleep where the platform honours it (on mains power), and `-w` ends the
 * assertion with the worker's own process, so a worker that dies never leaves
 * the machine held awake. Other platforms hold nothing.
 *
 * It holds THIS machine only. A worker in a virtual machine holds its guest,
 * not the host the guest runs on: a host that sleeps suspends the guest with it,
 * and that worker is covered by the settle before a claim (`wake.ts`) and by
 * stopping a run whose lease lapsed while it slept, not by this.
 */
import { spawn as spawnChild, type ChildProcess } from 'node:child_process';

/** Hold the machine awake; the answer releases it. */
export type KeepAwake = () => () => void;

export const CAFFEINATE = '/usr/bin/caffeinate';

export interface KeepAwakeDeps {
  platform: NodeJS.Platform;
  /** This worker's process id, which the assertion ends with. */
  pid: number;
  spawn: (command: string, args: readonly string[]) => Pick<ChildProcess, 'on' | 'unref' | 'kill'>;
}

const NOTHING_HELD = (): void => {};

export function keepAwakeWith(deps: KeepAwakeDeps): KeepAwake {
  return () => {
    if (deps.platform !== 'darwin') return NOTHING_HELD;
    let child: Pick<ChildProcess, 'on' | 'unref' | 'kill'>;
    try {
      child = deps.spawn(CAFFEINATE, ['-i', '-s', '-w', String(deps.pid)]);
    } catch {
      return NOTHING_HELD;
    }
    // A machine without the binary still drives the run; it only sleeps as it would have.
    let ended = false;
    child.on('error', () => { ended = true; });
    child.on('exit', () => { ended = true; });
    child.unref();
    return () => {
      if (ended) return;
      ended = true;
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
    };
  };
}

export const keepMachineAwake: KeepAwake = keepAwakeWith({
  platform: process.platform,
  pid: process.pid,
  spawn: (command, args) => spawnChild(command, [...args], { stdio: 'ignore' }),
});
