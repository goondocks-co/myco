/**
 * A test that blocks its thread forever, for the runner's group-budget gate
 * (`tests/scripts/run-bun-tests-guards.test.ts`). The `_test.ts` suffix
 * matches Bun's test pattern but not the runner's `*.test.*` discovery, so only an
 * explicit target runs it, and it blocks only when the gate sets
 * MYCO_RUNNER_HANG_FIXTURE.
 */
import { expect, it } from 'bun:test';

it.skipIf(process.env.MYCO_RUNNER_HANG_FIXTURE !== '1')('blocks synchronously, beyond the reach of a per-test timeout', () => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  expect.unreachable();
});
