import { afterAll } from 'bun:test';
import { createTestTempRun } from '../../scripts/test-temp-root.mjs';

// Establish temp ownership before any sandbox or fixture resolves os.tmpdir().
const ownRun = process.env.MYCO_TEST_RUN_ROOT ? null : createTestTempRun();
export const TEST_TEMP_ROOT = process.env.MYCO_TEST_RUN_ROOT!;
function finish(): void {
  if (ownRun && ownRun.finish().length > 0) process.exitCode = 1;
}
afterAll(finish);
process.on('exit', finish);
