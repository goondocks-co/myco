import { afterAll } from 'bun:test';
import { createTestTempRun, finishTestTempRun } from '../../scripts/test-temp-root.mjs';

// Establish temp ownership before any sandbox or fixture resolves os.tmpdir().
const ownRun = process.env.MYCO_TEST_RUN_ROOT ? null : createTestTempRun();
export const TEST_TEMP_ROOT = process.env.MYCO_TEST_RUN_ROOT!;
function finish(): void {
  if (ownRun) finishTestTempRun(ownRun);
}
afterAll(finish);
process.on('exit', finish);
