/**
 * Child-process helper for the RC-8 stay-alive integration test.
 *
 * Installs the daemon's process guards, fires a genuinely unhandled
 * rejection, and — because the guard prevents Bun's default exit-on-
 * rejection — lives to print ALIVE and exit 0. Without the guards this
 * process exits 1 before the timeout fires.
 */
import { installProcessGuards } from '../../packages/myco/src/daemon/process-guards.js';

installProcessGuards({ stderr: () => {} });

void Promise.reject(new Error('orphan-helper-rejection'));

setTimeout(() => {
  process.stdout.write('ALIVE\n');
  process.exit(0);
}, 100);
