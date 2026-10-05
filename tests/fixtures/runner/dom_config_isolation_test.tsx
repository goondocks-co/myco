import { expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

it.skipIf(!process.env.MYCO_RUNNER_CONFIG_READY_DIR)('runs with the DOM preload while the node phase is active', async () => {
  const dir = process.env.MYCO_RUNNER_CONFIG_READY_DIR!;
  expect(process.env.MYCO_TEST_RUN_ROOT).toBeTruthy();
  expect(process.env.MYCO_TEST_REAL_HOME).toBeUndefined();
  expect(typeof document).toBe('object');
  fs.writeFileSync(path.join(dir, 'dom'), 'ready');
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(path.join(dir, 'node')) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  expect(fs.existsSync(path.join(dir, 'node'))).toBe(true);
});
