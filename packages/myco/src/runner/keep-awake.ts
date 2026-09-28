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
 * the machine held awake. Other platforms hold nothing; a worker there relies on
 * its lease alone.
 */
import { spawn } from 'node:child_process';

/** Hold the machine awake; the answer releases it. */
export type KeepAwake = () => () => void;

const NOTHING_HELD = (): void => {};

export const keepMachineAwake: KeepAwake = () => {
  if (process.platform !== 'darwin') return NOTHING_HELD;
  try {
    const child = spawn('/usr/bin/caffeinate', ['-i', '-s', '-w', String(process.pid)], { stdio: 'ignore' });
    // A machine without the binary still drives the run; it only sleeps as it would have.
    child.on('error', () => {});
    child.unref();
    return () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); };
  } catch {
    return NOTHING_HELD;
  }
};
