/**
 * A test that blocks its thread forever, for the runner's group-budget gate
 * (`tests/scripts/run-bun-tests-guards.test.ts`). The `_test.ts` suffix
 * matches Bun's test pattern but not the runner's `*.test.*` discovery, so only an
 * explicit target runs it, and it blocks only when the gate sets
 * MYCO_RUNNER_HANG_FIXTURE.
 *
 * Before blocking it starts two long-lived children and writes their pids to
 * MYCO_RUNNER_HANG_PIDS_FILE: one in the group's process group, and one in a
 * session of its own that only the group's parent-pid tree reaches. The second
 * ignores SIGTERM, so it outlives this process and is reparented away from the
 * tree before anything but SIGKILL can end it.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { expect, it } from 'bun:test';

it.skipIf(process.env.MYCO_RUNNER_HANG_FIXTURE !== '1')('blocks synchronously, beyond the reach of a per-test timeout', () => {
  const inGroup = spawn('sleep', ['600'], { stdio: 'ignore' });
  const ownSession = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1 << 30);"], { stdio: 'ignore', detached: true });
  try {
    console.log(`FIXTURE_CHILD_PIDS ${inGroup.pid} ${ownSession.pid}`);
    fs.writeFileSync(process.env.MYCO_RUNNER_HANG_PIDS_FILE!, `${inGroup.pid} ${ownSession.pid}\n`);
  } catch (error) {
    for (const child of [inGroup, ownSession]) child.kill('SIGKILL');
    throw error;
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  expect.unreachable();
});
