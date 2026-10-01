/**
 * A test that reads its own stdin to EOF, for the runner's stdin gate
 * (`tests/scripts/run-bun-tests-guards.test.ts`). The `_test.ts` suffix
 * matches Bun's test pattern but not the runner's `*.test.*` discovery, so
 * only an explicit target runs it, and it reads only when the gate sets
 * MYCO_RUNNER_STDIN_FIXTURE.
 */
import fs from 'node:fs';
import { expect, it } from 'bun:test';

it.skipIf(process.env.MYCO_RUNNER_STDIN_FIXTURE !== '1')('finds its stdin already at EOF', () => {
  expect(fs.readFileSync(0).length).toBe(0);
});
