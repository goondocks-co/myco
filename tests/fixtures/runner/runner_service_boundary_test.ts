import { it, expect } from 'bun:test';
import path from 'node:path';
import { run } from '@myco/cli/runner.js';
import { publishRunnerRecord, withRunnerLock, RUNNER_RECORD_VERSION } from '@myco/runner/runner-registry.js';
import { recordingPlatform } from '../../helpers/fake-service-manager.js';

it('runner installation requires the service-manager stub', async () => {
  const serverUrl = 'https://runner-boundary.invalid';
  const mycoHome = process.env.MYCO_HOME!;
  await withRunnerLock(serverUrl, (lock) => publishRunnerRecord(lock, {
    version: RUNNER_RECORD_VERSION, serverUrl, deploymentId: 'boundary-deployment', runnerId: 'boundary-runner', name: 'boundary', token: `mycorun_${'b'.repeat(43)}`,
  }), mycoHome);
  const stub = process.env.MYCO_RUNNER_SERVICE_STUB === '1' ? recordingPlatform().runner : undefined;
  expect(await run(['install', '--server', serverUrl], {
    mycoHome, home: process.env.HOME!, binaryPath: path.join(mycoHome, 'bin', 'myco'), platform: 'darwin',
    runner: stub, harnessDirs: () => [], lockDir: path.join(mycoHome, 'locks'), stdout: () => {}, stderr: () => {},
  })).toBe(true);
});
