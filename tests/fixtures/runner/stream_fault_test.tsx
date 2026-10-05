/**
 * A DOM-config test that keeps writing output, for the runner's exit gate
 * (`tests/scripts/run-bun-tests-guards.test.ts`). The `_test.tsx` suffix
 * matches Bun's test pattern but not the runner's `*.test.*` discovery, so
 * only an explicit target runs it, which the runner does with the DOM bunfig.
 * It runs only when the gate sets MYCO_RUNNER_STREAM_FAULT_FIXTURE.
 *
 * It writes its pid to MYCO_RUNNER_STREAM_FAULT_READY_FILE, then prints a line
 * every 100ms until it is killed. When the gate closes the runner's stdout,
 * the runner's next write of that output fails in its stream callback, and
 * the runner dies of the uncaught error mid-group.
 */
import fs from 'node:fs';
import { it } from 'bun:test';

it.skipIf(process.env.MYCO_RUNNER_STREAM_FAULT_FIXTURE !== '1')('writes output until it is killed', async () => {
  fs.writeFileSync(process.env.MYCO_RUNNER_STREAM_FAULT_READY_FILE!, `${process.pid}\n`);
  await new Promise(() => { setInterval(() => console.log('still writing'), 100); });
});
