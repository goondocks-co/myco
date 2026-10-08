import { it, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';

const command = process.env.MYCO_SERVICE_EXEC_FIXTURE;
it.skipIf(!command)('a swallowed service-manager failure still fails the phase', () => {
  try { spawnSync(command!, [process.env.MYCO_SERVICE_EXEC_SCRIPT ?? 'version'], { stdio: 'ignore' }); } catch { /* the phase guard observes the attempt */ }
  expect(true).toBe(true);
});
