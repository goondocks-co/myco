/** Compiled command harness using the production verbs and the service-manager stub. */
import fs from 'node:fs';
import path from 'node:path';
import { run as runner } from '@myco/cli/runner.js';
import { run as worker } from '@myco/cli/worker.js';
import { run as login } from '@myco/cli/login.js';
import { runJoin, runProvision } from '@myco/cli/member.js';
import { run as server } from '@myco/cli/server.js';
import { registerEmbeddedNativeDeps } from '@myco/runtime/native-deps.js';
import { FEATURES_HEADER } from '@goondocks/myco-shared/member-protocol';
import { EXECUTION_PROFILE_FEATURE } from '@goondocks/myco-shared/execution-profile';
import { publishRunnerRecord, withRunnerLock, RUNNER_RECORD_VERSION } from '@myco/runner/runner-registry.js';
import { writeDeploymentMembership } from '@myco/member/registry.js';
import { recordingPlatform } from '../../helpers/fake-service-manager.js';

const serverUrl = 'https://compiled.invalid';
const mycoHome = process.env.MYCO_HOME!;
const stateFile = path.join(mycoHome, 'fixture-service-state.json');
const args = process.argv.slice(2);
if (args[0] === 'prepare') {
  const mode = args[1];
  fs.mkdirSync(mycoHome, { recursive: true }); fs.writeFileSync(path.join(mycoHome, 'fixture-mode'), mode!);
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
    admission: async () => 'admitted' as const, ownDeploymentUrls: async () => [],
    fetch: (async () => Response.json({ persisted: true, runner: { id: 'fixture-runner', name: 'mini', deploymentId: 'fixture-deployment', state: 'enabled' }, credential: { id: 'fixture-credential', expiresAt: 99999999, refreshAfter: 99999999 } })) as unknown as typeof fetch,
  };
  const command = args.shift();
  const answer = { joined: true, memberId: 'fixture-member', token: 'm'.repeat(43), tokenId: 'fixture-token', expiresAt: Date.now() + 100000, role: 'admin', projectId: null };
  const memberFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const pathname = new URL(request.url).pathname;
    if (pathname === '/auth/device/start') return Response.json({ device_code: 'd'.repeat(43), user_code: 'BCDF-2345', expires_in: 600, interval: 1 });
    if (pathname === '/auth/device/poll' || pathname === '/members/join') return Response.json(answer);
    if (pathname === '/members/settings') return Response.json({ leaves: {} });
    return Response.json({ healthy: true, context: [] });
  }) as typeof fetch;
  const memberDeps = { mycoHome, cwd: process.cwd(), packageRoot: process.env.MYCO_FIXTURE_PACKAGE_ROOT!, fetch: memberFetch, worker: deps, agents: () => ['codex'], sleep: async () => {} };
  let ok: boolean;
  if (command === 'login') ok = await login(args, memberDeps);
  else if (command === 'join') ok = await runJoin([serverUrl, '--project', 'proj_fixture', '--token-env', 'FIXTURE_TOKEN', ...args], { ...memberDeps, env: { FIXTURE_TOKEN: answer.token } }) !== null;
  else if (command === 'provision') ok = runProvision(['codex', '--root', process.cwd()], memberDeps);
  else if (command === 'server') {
    await registerEmbeddedNativeDeps({ libsqliteEmbed: process.env.MYCO_FIXTURE_LIBSQLITE!, vec0Embed: process.env.MYCO_FIXTURE_VEC0!, ripgrepEmbed: process.env.MYCO_FIXTURE_RG!, version: 'runner-command-fixture' });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      fs.writeFileSync(path.join(mycoHome, 'unexpected-executor-request'), new URL(request.url).pathname);
      return Response.json({ persisted: true, deploymentId: 'fixture-deployment', claimed: false, reason: 'no_work' }, { headers: { [FEATURES_HEADER]: EXECUTION_PROFILE_FEATURE } });
    }) as typeof fetch;
    const nativeUrl = `http://127.0.0.1:${process.env.MYCO_FIXTURE_PORT!}`;
    const mode = fs.readFileSync(path.join(mycoHome, 'fixture-mode'), 'utf8');
    if (mode !== 'runner-only') writeDeploymentMembership({ serverUrl: nativeUrl, token: answer.token, machineId: 'fixture-member', memberId: answer.memberId, joinedAt: 1, updatedAt: 1 }, { mycoHome });
    if (mode !== 'member-only') await withRunnerLock(nativeUrl, lock => publishRunnerRecord(lock, { version: RUNNER_RECORD_VERSION, serverUrl: nativeUrl, deploymentId: 'fixture-deployment', runnerId: 'native-runner', name: 'mini', token: `mycorun_${'r'.repeat(43)}` }), mycoHome);
    await server(['create', '--target', 'local', '--port', process.env.MYCO_FIXTURE_PORT!]);
    await server(['run', '--target', 'local']);
    ok = true;
  } else ok = await (command === 'worker' ? worker : runner)(args, deps);
  await new Promise<void>(resolve => setImmediate(resolve));
  fs.mkdirSync(mycoHome, { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({ loaded: [...platform.loaded], running: [...platform.running], commands: platform.commands }));
  process.exitCode = ok ? 0 : 1;
}
