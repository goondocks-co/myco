import { afterAll } from 'bun:test';
import { createTestTempRun, finishTestTempRun } from '../../scripts/test-temp-root.mjs';
import { installTestTempFence } from './filesystem-fence.js';

// Establish temp ownership before any sandbox or fixture resolves os.tmpdir().
const ownRun = !process.env.MYCO_TEST_RUN_ROOT || process.env.MYCO_TEST_CREATE_TEMP_RUN === '1' ? createTestTempRun() : null;
delete process.env.MYCO_TEST_CREATE_TEMP_RUN;
export const TEST_TEMP_ROOT = process.env.MYCO_TEST_RUN_ROOT!;
installTestTempFence(TEST_TEMP_ROOT);
function finish(): void {
  if (ownRun) finishTestTempRun(ownRun);
}
afterAll(finish);
process.on('exit', finish);
