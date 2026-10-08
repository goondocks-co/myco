/** Compiled command harness using the production verbs and the service-manager stub. */
import fs from 'node:fs';
import path from 'node:path';
import { run as runner } from '@myco/cli/runner.js';
import { run as worker } from '@myco/cli/worker.js';
import { publishRunnerRecord, withRunnerLock, RUNNER_RECORD_VERSION } from '@myco/runner/runner-registry.js';
import { writeDeploymentMembership } from '@myco/member/registry.js';
import { recordingPlatform } from '../../helpers/fake-service-manager.js';

const serverUrl = 'https://compiled.invalid';
const mycoHome = process.env.MYCO_HOME!;
const stateFile = path.join(mycoHome, 'fixture-service-state.json');
const args = process.argv.slice(2);
if (args[0] === 'prepare') {
  const mode = args[1];
  if (mode !== 'runner-only') writeDeploymentMembership({ serverUrl, token: 'm'.repeat(43), machineId: 'fixture-member', joinedAt: 1, updatedAt: 1 }, { mycoHome });
  if (mode !== 'member-only') await withRunnerLock(serverUrl, (lock) => publishRunnerRecord(lock, { version: RUNNER_RECORD_VERSION, serverUrl, deploymentId: 'fixture-deployment', runnerId: 'fixture-runner', name: 'mini', token: `mycorun_${'r'.repeat(43)}`, refreshAfter: 99999999 }), mycoHome);
  fs.mkdirSync(path.join(mycoHome, 'member'), { recursive: true });
  fs.writeFileSync(path.join(mycoHome, 'member', 'capture-sentinel'), 'capture');
} else {
  const platform = recordingPlatform();
  if (fs.existsSync(stateFile)) {
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as { loaded: string[]; running: string[] };
    state.loaded.forEach((name) => platform.loaded.add(name)); state.running.forEach((name) => platform.running.add(name));
  }
  const deps = {
    mycoHome, home: process.env.HOME!, platform: 'darwin' as const, runner: platform.runner,
    binaryPath: path.join(mycoHome, 'bin', 'myco'), harnessDirs: () => [], lockDir: path.join(mycoHome, 'locks'),
    now: () => 1000, detect: () => [{ id: 'codex', installed: true, authenticated: true }],
    fetch: (async () => Response.json({ persisted: true, runner: { id: 'fixture-runner', name: 'mini', deploymentId: 'fixture-deployment', state: 'enabled' }, credential: { id: 'fixture-credential', expiresAt: 99999999, refreshAfter: 99999999 } })) as unknown as typeof fetch,
  };
  const ok = await (args.shift() === 'worker' ? worker : runner)(args, deps);
  fs.mkdirSync(mycoHome, { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({ loaded: [...platform.loaded], running: [...platform.running] }));
  process.exitCode = ok ? 0 : 1;
}
