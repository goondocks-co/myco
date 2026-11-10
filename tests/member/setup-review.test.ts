import { afterEach, expect, it, spyOn } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { recordProvision, updateProvisionRecord, provisionRecordPath } from '@myco/member/provision-record.js';
import { deploymentDashboardUrl } from '@myco/cli/open.js';
import { recordDefaultDeployment } from '@myco/member/default-deployment.js';
import { writeDeploymentMembership, acquireRegistryLock } from '@myco/member/registry.js';
import { exchangeJoinCode } from '@myco/member/join-code.js';
import { rootKeyFor, markLeft, leftForConnection } from '@myco/member/auto-join.js';
import { autoJoinHold, LEFT_ALONE } from '@myco/member/auto-join-hook.js';
import { cacheMachineSettings } from '@myco/member/machine-settings.js';
import { rawAnswerOf } from '@myco/member/transport.js';
import { windsurfAdapter } from '@myco/symbionts/windsurf.js';
import { planWritesInLines } from '@myco/member/plan-files.js';
import { removeLegacyRegistrations, scanLegacyRegistrations } from '@myco/symbionts/legacy-registrations.js';
import { allocateRunDirectory, recoverAbandonedRunDirectories, RUN_DIRECTORY_MANIFEST } from '@myco/runner/run-directory.js';
import { grantsCall } from '@myco/runner/drivers/grant.js';
import { writeApprovedProjectPin } from '../support/project-runtime-pin.js';
import { fakeDeployment, harnessHistory, withHarnessHome } from './helpers/history-fakes.js';
import { UNCAPTURED_STATE_PATH } from '@goondocks/myco-shared/member-protocol';

const IMPORT_PLAN = '/import/plan';

const roots: string[] = [];
const scratch = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-setup-review-'));
  roots.push(root);
  return root;
};
const restores: Array<() => void> = [];
afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const SERVER = 'https://fixture.invalid';

it('refuses provision mutations when an existing record cannot be read', () => {
  const home = scratch();
  recordProvision(home, { version: 'one', serverUrl: SERVER, agents: ['codex'], pendingLogout: { codex: [SERVER] } });
  const file = provisionRecordPath(home);
  const bytes = fs.readFileSync(file, 'utf8');
  for (const mutate of [() => recordProvision(home, { version: 'two', serverUrl: SERVER, agents: ['cursor'] }),
    () => updateProvisionRecord(home, () => null)]) {
    const read = fs.readFileSync;
    let failed = false;
    const injected = spyOn(fs, 'readFileSync').mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
      if (String(args[0]) === file && !failed) { failed = true; throw Object.assign(new Error('fixture EIO'), { code: 'EIO' }); }
      return read(...args);
    }) as typeof fs.readFileSync);
    try { expect(mutate).toThrow(); } finally { injected.mockRestore(); }
    expect(fs.readFileSync(file, 'utf8')).toBe(bytes);
  }
});

it('opens the membership selected by a folder home pin', () => {
  const root = scratch();
  const pinned = path.join(root, 'pinned');
  fs.mkdirSync(path.join(root, '.myco'));
  writeApprovedProjectPin(root, 'runtime.home', pinned);
  writeDeploymentMembership({ serverUrl: SERVER, token: 'mt_' + 'a'.repeat(40), machineId: 'machine', joinedAt: 1, updatedAt: 1 }, { mycoHome: pinned });
  recordDefaultDeployment(SERVER, { mycoHome: pinned });
  const before = process.env.MYCO_HOME;
  delete process.env.MYCO_HOME;
  try { expect(deploymentDashboardUrl({ cwd: root })).toBe(SERVER + '/'); }
  finally { process.env.MYCO_HOME = before; }
});

it('keeps invitation bodies at their original authority', async () => {
  const received: string[] = [];
  const destination = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async request => {
    received.push(await request.text()); return Response.json({ joined: false });
  } });
  const origin = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => Response.redirect(destination.url, 307) });
  try {
    const result = await exchangeJoinCode({ serverUrl: origin.url.origin, key: 'synthetic-invitation' }, { machineId: 'fixture', timeoutMs: 500 });
    expect(received).toEqual([]);
    expect(result).toMatchObject({ ok: false, code: 'redirect' });
  } finally { await origin.stop(true); await destination.stop(true); }
});

it('retains capture while an ordinary reconnect waits for the registry lease', () => {
  const base = scratch();
  const home = path.join(base, 'myco');
  const root = path.join(base, 'repo');
  fs.mkdirSync(root);
  execFileSync('git', ['init', '-q', root]);
  writeDeploymentMembership({ serverUrl: SERVER, token: 'mt_' + 'a'.repeat(40), machineId: 'machine', joinedAt: 1, updatedAt: 1 }, { mycoHome: home });
  recordDefaultDeployment(SERVER, { mycoHome: home });
  const key = rootKeyFor(root, home);
  markLeft(key, home, 1);
  cacheMachineSettings(SERVER, { leaves: { 'capture.auto_join_roots': [base], 'capture.connect_roots': { [key]: 'proj_fixture' } } }, home);
  const lock = acquireRegistryLock(home);
  expect(lock.acquired).toBe(true);
  if (!lock.acquired) return;
  try {
    const hold = autoJoinHold({ root, hookName: 'session-start', agent: 'claude-code', sessionId: 'fixture', mycoHome: home,
      now: 2, env: { ...process.env, MYCO_TEMPORARY_FOLDERS: path.join(home, 'elsewhere') }, later: () => {} });
    expect(hold).not.toBe(LEFT_ALONE);
    expect(hold !== null && typeof hold === 'object' && hold.spool !== null).toBe(true);
  } finally { lock.lock.release(); }
  expect(leftForConnection(key, home, 'proj_fixture')).toBe('ready');
});

it('honors HTTP-date Retry-After as a nonnegative delay', async () => {
  const at = Date.now();
  const clock = spyOn(Date, 'now').mockReturnValue(at);
  try {
    const date = new Date(at + 120_000).toUTCString();
    expect((await rawAnswerOf(new Response('', { status: 503, headers: { 'retry-after': date } }))).retryAfterMs)
      .toBe(Date.parse(date) - at);
    expect((await rawAnswerOf(new Response('', { status: 503, headers: { 'retry-after': new Date(at - 1000).toUTCString() } }))).retryAfterMs).toBe(0);
  } finally { clock.mockRestore(); }
});

it('ignores malformed Windsurf fields and still parses subsequent valid turns', () => {
  expect(windsurfAdapter.parseTurns('{"type":"user_input","user_response":42}\n{"type":"user_input","text":"valid"}'))
    .toMatchObject([{ prompt: 'valid' }]);
});

it('discovers every plan written by a declared multi-file patch tool', () => {
  const root = scratch();
  expect(planWritesInLines('opencode', [{ type: 'tool', name: 'apply_patch', input: {
    patchText: '*** Begin Patch\n*** Add File: .opencode/plans/one.md\n+# One\n*** Update File: .opencode/plans/two.md\n@@\n-old\n+new\n*** End Patch',
  } }], root, ['.opencode/plans'])).toEqual([path.join(root, '.opencode/plans/one.md'), path.join(root, '.opencode/plans/two.md')]);
});

it('preserves unrelated TOML comments during legacy MCP removal', () => {
  const root = scratch();
  const file = path.join(root, '.codex/config.toml');
  const legacy = path.join(root, 'legacy');
  fs.mkdirSync(legacy);
  fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(file, '# user note\nmodel = "custom" # keep this\n\n[mcp_servers.myco]\ncommand = "' + legacy + '/bin/myco"\nargs = ["mcp"]\n\n# the staging server: keep this note\n[mcp_servers.other]\ncommand = "other" # other note\n');
  const scan = scanLegacyRegistrations({ homeDir: root, folders: [], legacyHomes: [legacy] });
  removeLegacyRegistrations(file, scan.findings, [legacy]);
  expect(fs.readFileSync(file, 'utf8')).toContain('# user note\nmodel = "custom" # keep this');
  expect(fs.readFileSync(file, 'utf8')).toContain('command = "other" # other note');
  expect(fs.readFileSync(file, 'utf8')).toContain('# the staging server: keep this note\n[mcp_servers.other]');
  expect(fs.readFileSync(file, 'utf8')).not.toContain('[mcp_servers.myco]');
});

it('keeps a refused recovery candidate without blocking independent candidates', () => {
  const root = scratch();
  const bad = path.join(root, 'bad');
  fs.mkdirSync(bad);
  const safe = allocateRunDirectory(root, { purpose: 'model-listing', harnessId: 'fixture' });
  const file = path.join(safe, RUN_DIRECTORY_MANIFEST);
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...manifest, pid: 2_147_483_647 }));
  const refused: string[] = [];
  const stat = fs.lstatSync;
  const injected = spyOn(fs, 'lstatSync').mockImplementation(((...args: Parameters<typeof fs.lstatSync>) => {
    if (String(args[0]) === bad) throw Object.assign(new Error('fixture unreadable'), { code: 'EACCES' });
    return stat(...args);
  }) as typeof fs.lstatSync);
  try { expect(recoverAbandonedRunDirectories(root, (at, error) => refused.push(at + ': ' + String(error)))).toMatchObject({ recovered: 1, preserved: 1 }); }
  finally { injected.mockRestore(); }
  expect(fs.existsSync(bad)).toBe(true);
  expect(fs.existsSync(safe)).toBe(false);
  expect(refused).toEqual([bad + ': Error: fixture unreadable']);
});

it('matches a scoped source grant with a whole quoted checkout path', () => {
  expect(grantsCall(['Bash(git -C "/scratch/a b/repository" log:*)'], 'Bash', 'git -C "/scratch/a b/repository" log --oneline')).toBe(true);
  expect(grantsCall(['Bash(git -C "/scratch/a b/repository" log:*)'], 'Bash', 'git -C "/scratch/a b/elsewhere" log')).toBe(false);
});

it('keeps a failed history import due until a later pass completes', async () => {
  const { joinPass } = await import('@myco/cli/member-auto-join.js');
  const { auto, home, server } = await historyFixture();
  let clock = Date.now();
  await joinPass(home, { now: () => clock, fetch: server.fetch })(clock + 1000, { force: false });
  expect(auto.listPendingImports(home)).toHaveLength(1);
  await joinPass(home, { now: () => clock, fetch: server.fetch })(clock + 1000, { force: false });
  expect(server.count(IMPORT_PLAN)).toBe(1);
  clock += 3_600_000;
  server.answers[IMPORT_PLAN] = IMPORT_DONE;
  await joinPass(home, { now: () => clock, fetch: server.fetch })(clock + 1000, { force: false });
  expect(auto.listPendingImports(home)).toEqual([]);
});

it('isolates an inaccessible harness configuration and reports its failure', async () => {
  const { detectHarnessesAsync } = await import('@myco/runner/detect.js');
  const fsp = await import('node:fs/promises');
  const root = scratch();
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  for (const name of ['claude', 'codex']) fs.writeFileSync(path.join(bin, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const before = process.env.PATH;
  process.env.PATH = bin + ':/usr/bin:/bin';
  const stat = fsp.stat;
  const denied = spyOn(fsp, 'stat').mockImplementation((async (...args: Parameters<typeof fsp.stat>) => {
    if (String(args[0]).includes('auth.json')) throw Object.assign(new Error('fixture denied'), { code: 'EACCES' });
    return stat(...args);
  }) as typeof fsp.stat);
  try {
    const detected = await detectHarnessesAsync(['claude-code', 'codex'], undefined, { credentialBytes: false });
    expect(detected.find(h => h.id === 'codex')).toMatchObject({ installed: true, authenticated: false, error: expect.stringContaining('fixture denied') });
    expect(detected.find(h => h.id === 'claude-code')).toMatchObject({ installed: true, authenticated: true });
  } finally { denied.mockRestore(); process.env.PATH = before; }
});

it('settles a failed session and advances the backlog cursor before continuing', async () => {
  const { MemberSpool } = await import('@myco/member/spool.js');
  const { drainBacklog, BACKLOG_CURSOR_FILE } = await import('@myco/member/backlog.js');
  const { deadlineBudget } = await import('@myco/member/budget.js');
  const { updateSessionState } = await import('@myco/member/session-state.js');
  const { ServerClient } = await import('@myco/member/transport.js');
  const home = scratch();
  const spool = new MemberSpool({ serverUrl: SERVER, projectId: 'proj_fixture' }, { mycoHome: home });
  const files = { a: path.join(home, 'transcript-a'), b: path.join(home, 'transcript-b') };
  for (const [id, file] of Object.entries(files)) {
    fs.writeFileSync(file, 'abc');
    updateSessionState(spool.dir, id, state => {
      state.agent = 'claude-code';
      state.transcript = { path: file, transcriptId: id, inode: fs.statSync(file).ino, nextOffset: 0, parsedSize: 3 };
    });
  }
  const open = fs.openSync;
  const denied = spyOn(fs, 'openSync').mockImplementation(((...args: Parameters<typeof fs.openSync>) => {
    if (String(args[0]) === files.a) throw Object.assign(new Error('fixture transcript denied'), { code: 'EACCES' });
    return open(...args);
  }) as typeof fs.openSync);
  const held = spyOn(process.stderr, 'write').mockImplementation(() => true);
  const client = new ServerClient({ serverUrl: SERVER, projectId: 'proj_fixture', token: 'fixture' },
    async () => Response.json({ stored: true, persisted: true }), { credentialSource: 'env' });
  try {
    const report = await drainBacklog(spool, client, deadlineBudget(Date.now() + 10_000), { machineId: 'machine' });
    expect(report.sessions.map(s => s.sessionId)).toEqual(['a', 'b']);
    expect(report.sessions[0]).toMatchObject({ error: expect.stringContaining('fixture transcript denied') });
    expect(spool.transcriptBacklogIds()).toContain('a');
    expect(fs.readFileSync(path.join(spool.dir, BACKLOG_CURSOR_FILE), 'utf8')).toBe('b');
  } finally { held.mockRestore(); denied.mockRestore(); }
});

it('owns download write errors until the failed stream closes', () => {
  const root = scratch();
  const script = path.join(root, 'download.ts');
  const module = path.resolve('packages/myco/src/upgrade/apply-binary.ts');
  fs.writeFileSync(script, `import { createBinaryUpdateDeps } from ${JSON.stringify(module)};
const update = createBinaryUpdateDeps({ fetch: async () => new Response('fixture') });
let failures = 0;
try { await update.download('https://fixture.invalid/download', ${JSON.stringify(root)}); }
catch { failures++; }
await Bun.sleep(20);
if (failures !== 1) process.exit(2);
`);
  expect(() => execFileSync(process.execPath, ['--no-env-file', '--tsconfig-override', path.resolve('tsconfig.json'), script],
    { env: process.env, stdio: 'pipe' })).not.toThrow();
});

it('renews registry credentials before requesting an account link', async () => {
  const { runLinkGithub } = await import('@myco/cli/member.js');
  const { writeRegistryEntry, REGISTRY_VERSION } = await import('@myco/member/registry.js');
  const home = scratch();
  const root = path.join(home, 'repo');
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  const old = 'mt_' + 'a'.repeat(40), fresh = 'mt_' + 'b'.repeat(40);
  writeRegistryEntry({ version: REGISTRY_VERSION, root, serverUrl: SERVER, projectId: 'proj_fixture', token: old,
    machineId: 'machine', joinedAt: 1, updatedAt: 1, expiresAt: 10, refreshAfter: 5 }, { mycoHome: home });
  const requests: string[] = [];
  const linked = await runLinkGithub([], { mycoHome: home, cwd: root, now: () => 20, stdout: () => {}, stderr: () => {},
    fetch: async (input, init) => {
      const route = new URL(String(input)).pathname;
      requests.push(route);
      if (route === '/tokens/refresh') return Response.json({ refreshed: true, token: fresh, tokenId: 'fresh', expiresAt: 1000, refreshAfter: 500 });
      return new Headers(init?.headers).get('authorization') === 'Bearer ' + fresh
        ? Response.json({ persisted: true, key: 'a'.repeat(43), expiresAt: 1000 }) : new Response('', { status: 401 });
    } });
  expect(linked).toContain('/link#');
  expect(requests).toEqual(['/tokens/refresh', '/members/link-github']);
  process.exitCode = 0;
});

it('refuses executable syntax in binary paths used by direct hook hosts', async () => {
  const { SymbiontInstaller } = await import('@myco/symbionts/installer.js');
  const { loadManifests, resolvePackageRoot } = await import('@myco/symbionts/detect.js');
  const root = scratch();
  const home = path.join(root, 'member;false');
  fs.mkdirSync(path.join(home, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(home, 'bin/myco'), '', { mode: 0o755 });
  const installer = new SymbiontInstaller(loadManifests().find(m => m.name === 'claude-code')!, root, resolvePackageRoot(), false, home);
  expect(() => installer.renderMemberHooks('registry')).toThrow();
});

it('encodes literal shell arguments without executing their contents', async () => {
  const { commandLine } = await import('@goondocks/myco-shared/shell-command');
  const root = scratch();
  const binary = path.join(root, 'echo;literal');
  fs.writeFileSync(binary, `#!/bin/sh\nprintf '%s\\n' "$@"\n`, { mode: 0o755 });
  const values = ['$(touch marker)', "one'two", 'space and ; syntax'];
  const output = execFileSync('/bin/sh', ['-c', commandLine([binary, ...values])], { cwd: root, env: process.env, encoding: 'utf8' });
  expect(output.trimEnd().split('\n')).toEqual(values);
  expect(fs.existsSync(path.join(root, 'marker'))).toBe(false);
});

it('finishes credential renewal before leave mutates the registry', () => {
  const home = scratch();
  const script = path.join(home, 'leave.ts');
  fs.writeFileSync(script, `import fs from 'node:fs';
import { runLeave } from ${JSON.stringify(path.resolve('packages/myco/src/cli/member.ts'))};
import { writeRegistryEntry, readRegistryEntry, REGISTRY_VERSION } from ${JSON.stringify(path.resolve('packages/myco/src/member/registry.ts'))};
const root = ${JSON.stringify(home)};
fs.mkdirSync(root + '/.git');
const old = 'mt_' + 'a'.repeat(40), fresh = 'mt_' + 'b'.repeat(40);
writeRegistryEntry({ version: REGISTRY_VERSION, root, serverUrl: 'https://fixture.invalid', projectId: 'proj_fixture', token: old, machineId: 'machine', joinedAt: 1, updatedAt: 1, expiresAt: 10, refreshAfter: 5 }, { mycoHome: root });
const requests: string[] = [];
const result = await runLeave([], { mycoHome: root, cwd: root, now: () => 20, stdout: () => {}, stderr: () => {}, fetch: async (input, init) => {
  const route = new URL(String(input)).pathname;
  requests.push(route);
  await Bun.sleep(5);
  if (route === '/tokens/refresh') return Response.json({ refreshed: true, token: fresh, tokenId: 'fresh', expiresAt: 1000, refreshAfter: 500 });
  if (new Headers(init?.headers).get('authorization') !== 'Bearer ' + fresh) throw new Error('stale credential');
  return Response.json({ persisted: true });
} });
console.log(JSON.stringify({ result, requests, entry: readRegistryEntry(root, root) }));
`);
  const result = execFileSync(process.execPath, ['--no-env-file', '--tsconfig-override', path.resolve('tsconfig.json'), script],
    { env: process.env, encoding: 'utf8', timeout: 10_000 });
  expect(JSON.parse(result.trim())).toMatchObject({ result: true, entry: null });
  expect(JSON.parse(result.trim()).requests).toContain('/tokens/refresh');
}, 15_000);

it('admits Unicode and internal tildes in direct paths and reports metacharacter refusal', async () => {
  const { SymbiontInstaller, MemberProvisionConflictError } = await import('@myco/symbionts/installer.js');
  const { loadManifests } = await import('@myco/symbionts/detect.js');
  const { hookCommands } = await import('@myco/symbionts/member-hooks.js');
  for (const name of ['josé', 'dev🚀', 'user~1', 'name(1)']) {
    const root = scratch(), home = path.join(root, name);
    fs.mkdirSync(path.join(home, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(home, 'bin', process.platform === 'win32' ? 'myco.exe' : 'myco'), '', { mode: 0o755 });
    const install = new SymbiontInstaller(loadManifests().find(m => m.name === 'claude-code')!, root, path.resolve('packages/myco'), false, home);
    if (name === 'name(1)') expect(() => install.renderMemberHooks('registry')).toThrow(MemberProvisionConflictError);
    else {
      expect(hookCommands(install.renderMemberHooks('registry'))[0]).toContain(home.replaceAll('\\', '/'));
      const manifest = loadManifests().find(m => m.registration?.memberMcpHeadersHelperKey !== undefined)!;
      const tools = new SymbiontInstaller(manifest, root, path.resolve('packages/myco'), false, home).forDeployment(SERVER);
      expect(JSON.stringify(tools.renderMemberMcp('registry', SERVER))).toContain(name);
    }
  }
});

it('round trips systemd literals and keeps a running service when only quoted PATH changes', async () => {
  const { defaultSpec, renderUnit, servicePaths, assertServiceTargetHome, installService } = await import('@myco/server/service.js');
  const { workerServiceSpec, installedRunnerTarget, listWorkerUnits } = await import('@myco/runner/service.js');
  const home = scratch(), binary = path.join(home, 'bin(1)', 'myco');
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, '', { mode: 0o755 });
  const spec = { ...defaultSpec(binary, home, 'linux', path.join(home, 'josé(1)&amp;')), pathEnv: '/a path:/bin',
    env: { MYCO_HOME: path.join(home, 'josé(1)&amp;'), TOKEN_PATH: '/home/u/a$b%q' },
    unit: { ...defaultSpec(binary, home, 'linux').unit, args: ['server', 'run', '--value', 'a$b%q'] } };
  const paths = servicePaths(spec, 'linux');
  const unit = renderUnit(spec, paths, 'linux');
  expect(unit).toContain(`ExecStart="${binary}" server run --value "a$$b%%q"`);
  expect(unit).toContain('Environment="TOKEN_PATH=/home/u/a$b%%q"');
  fs.mkdirSync(path.dirname(paths.unitFile), { recursive: true });
  fs.writeFileSync(paths.unitFile, unit);
  expect(() => assertServiceTargetHome(spec, { platform: 'linux' })).not.toThrow();
  const calls: string[][] = [];
  const outcome = installService({ ...spec, pathEnv: '/another path:/bin' }, { platform: 'linux', keepRunning: true,
    runner: (command, args) => { calls.push([command, ...args]); return { status: 0, stdout: '', stderr: '' }; } });
  expect(outcome).toMatchObject({ running: true, changed: false });
  expect(calls.every(args => args.includes('is-enabled') || args.includes('is-active'))).toBe(true);
  const target = { home, mycoHome: spec.env.MYCO_HOME, binaryPath: binary, serverUrl: 'http://[::1]:8787', platform: 'linux' as const };
  const worker = workerServiceSpec(target, []);
  const workerPaths = servicePaths(worker, 'linux');
  fs.writeFileSync(workerPaths.unitFile, renderUnit(worker, workerPaths, 'linux'));
  expect(installedRunnerTarget(target).binaryPath).toBe(binary);
  expect(listWorkerUnits(home, 'linux', true).find(unit => unit.unitFile === workerPaths.unitFile))
    .toMatchObject({ mycoHome: target.mycoHome, serverUrl: target.serverUrl });
});

it('keeps renewal and membership publication independent of unreadable provision cleanup', async () => {
  const { readDeploymentMembership } = await import('@myco/member/registry.js');
  const { refreshMembership } = await import('@myco/member/refresh.js');
  const home = scratch(), old = 'mt_' + 'a'.repeat(40), fresh = 'mt_' + 'b'.repeat(40);
  writeDeploymentMembership({ serverUrl: SERVER, token: old, machineId: 'machine', joinedAt: 1, updatedAt: 1, expiresAt: 10, refreshAfter: 5 }, { mycoHome: home });
  recordProvision(home, { version: 'fixture', serverUrl: SERVER, agents: ['codex'], pendingLogout: { codex: [SERVER] } });
  const file = provisionRecordPath(home);
  const readable = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, '{ torn');
  const warning = spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    expect(() => writeDeploymentMembership({ serverUrl: 'https://other.invalid', token: 'mt_' + 'c'.repeat(40), machineId: 'machine', joinedAt: 1, updatedAt: 1 }, { mycoHome: home })).not.toThrow();
    expect(await refreshMembership(SERVER, { mycoHome: home, now: () => 20, force: false, budget: { connectTimeoutMs: 500, requestTimeoutMs: 500 },
      fetch: async () => Response.json({ refreshed: true, token: fresh, tokenId: 'fresh', expiresAt: 1000, refreshAfter: 500 }) })).toMatchObject({ status: 'refreshed' });
    expect(readDeploymentMembership(SERVER, home)?.token).toBe(fresh);
    expect(fs.readFileSync(file, 'utf8')).toBe('{ torn');
    expect(warning).toHaveBeenCalled();
    fs.writeFileSync(file, readable);
    const rename = fs.renameSync;
    const denied = spyOn(fs, 'renameSync').mockImplementation((...args: Parameters<typeof fs.renameSync>) => {
      if (String(args[1]) === file) throw Object.assign(new Error('fixture write denied'), { code: 'EACCES' });
      return rename(...args);
    });
    try {
      expect(() => writeDeploymentMembership({ serverUrl: SERVER, token: fresh, machineId: 'machine', joinedAt: 1, updatedAt: 20 }, { mycoHome: home })).not.toThrow();
      expect(fs.readFileSync(file, 'utf8')).toBe(readable);
    } finally { denied.mockRestore(); }
  } finally { warning.mockRestore(); }
});

/**
 * A connected repository with one queued history import, one finished harness session recorded in it, and a fake
 * Deployment whose import plan answers 503 until a test changes `server.answers`.
 */
async function historyFixture() {
  const auto = await import('@myco/member/auto-join.js');
  const registry = await import('@myco/member/registry.js');
  const home = scratch(), root = path.join(home, 'repo');
  fs.mkdirSync(root);
  execFileSync('git', ['init', '-q', root]);
  registry.writeRegistryEntry({ version: registry.REGISTRY_VERSION, root, serverUrl: SERVER, projectId: 'proj_fixture', token: 'mt_' + 'a'.repeat(40), machineId: 'machine', joinedAt: 1, updatedAt: 1, expiresAt: 1e15, refreshAfter: 1e15 }, { mycoHome: home });
  const pending = { root, rootKey: auto.rootKeyFor(root, home), serverUrl: SERVER, projectId: 'proj_fixture', at: 1 };
  auto.queueImport(pending, home);
  auto.markSweepDone(home, 1);
  harnessHistory(home, root);
  restores.push(withHarnessHome(home));
  const server = fakeDeployment({ [IMPORT_PLAN]: new Response('{}', { status: 503 }) });
  return { auto, home, root, pending, server };
}

/** The import plan's answer once the Deployment holds everything the member offered. */
const IMPORT_DONE = Response.json({ persisted: true, candidates: [] });

it('wakes a due import from a connected hook after the helper ends idle, with increasing retry gaps', async () => {
  const { joinPass } = await import('@myco/cli/member-auto-join.js');
  const { runHelper } = await import('@myco/member/helper.js');
  const { auto, home, root, server } = await historyFixture();
  const start = Date.now();
  let clock = start, starts = 0;
  expect(await runHelper({ projectId: auto.JOIN_BUCKET, mycoHome: home, pass: joinPass(home, { now: () => clock, fetch: server.fetch }),
    now: () => clock, sleep: async ms => { clock += ms; }, deadlineMs: 1000, lingerMs: 1, pollMs: 1 })).toMatchObject({ endedBy: 'idle', passes: 1 });
  const first = auto.listPendingImports(home)[0]!;
  const firstGap = first.retryAt! - start;
  clock = first.retryAt!;
  const { runHook } = await import('./helpers/hooks.js');
  const previousHome = process.env.MYCO_HOME;
  process.env.MYCO_HOME = home;
  try {
    for (const hook of ['session-start', 'user-prompt-submit', 'stop'] as const) {
      const result = await runHook(hook, { cwd: root, session_id: 'connected-' + hook, prompt: 'hello' }, {
        now: () => clock, fetch: async () => Response.json({ persisted: true }),
      });
      expect(result.starts.some(args => args.includes('--join'))).toBe(true);
      starts++;
    }
  } finally {
    if (previousHome === undefined) delete process.env.MYCO_HOME; else process.env.MYCO_HOME = previousHome;
  }
  expect(starts).toBe(3);
  await joinPass(home, { now: () => clock, fetch: server.fetch })(clock + 1000, { force: false });
  expect(server.count(IMPORT_PLAN)).toBe(2);
  expect(auto.listPendingImports(home)[0]!.retryAt! - clock).toBeGreaterThan(firstGap);
});

it('retains terminal history dispositions without rescanning them automatically', async () => {
  const { joinPass, settleConnection } = await import('@myco/cli/member-auto-join.js');
  const { readRegistryEntry } = await import('@myco/member/registry.js');
  const refusals: Record<string, () => Response> = {
    refused: () => Response.json({ persisted: false, code: 'fixture_refusal', reason: 'fixture refusal' }),
    unauthorized: () => new Response('{}', { status: 401 }),
    protocol: () => Response.json({ server_protocol: 99 }, { status: 409 }),
  };
  for (const [endedBy, answer] of Object.entries(refusals)) {
    const { auto, home, root, pending, server } = await historyFixture();
    fs.writeFileSync(path.join(auto.autoJoinDir(home), 'imports', pending.rootKey + '.json'), JSON.stringify(pending));
    server.answers[IMPORT_PLAN] = answer;
    const at = Date.now(), later = at + 86_400_000;
    await joinPass(home, { now: () => at, fetch: server.fetch })(at + 1000, { force: false });
    expect(auto.listPendingImports(home)[0]?.terminal, endedBy).toMatchObject({ at, reason: expect.any(String) });
    await joinPass(home, { now: () => later, fetch: server.fetch })(later + 1000, { force: false });
    expect(server.count(IMPORT_PLAN)).toBe(1);
    const deferred: Array<() => void> = [];
    autoJoinHold({ root, hookName: 'session-end', agent: 'claude-code', sessionId: 'terminal', mycoHome: home, now: later, later: step => deferred.push(step) });
    expect(deferred).toEqual([]);
    const starts: string[][] = [];
    await settleConnection(readRegistryEntry(root, home)!, { mycoHome: home, now: () => later, tell: true, explicitJoin: true,
      spawn: (_command, args) => { starts.push([...args]); return { started: false }; }, fetch: async () => new Response('{}', { status: 503 }) });
    expect(starts.some(args => args.includes('--join'))).toBe(true);
    expect(auto.listPendingImports(home)[0]?.terminal).toBeUndefined();
    server.answers[IMPORT_PLAN] = IMPORT_DONE;
    await joinPass(home, { now: () => later, fetch: server.fetch })(later + 1000, { force: false });
    expect(auto.listPendingImports(home)).toEqual([]);
  }
});

it('retains an unreadable opt-out candidate while importing independent history', async () => {
  const { joinPass } = await import('@myco/cli/member-auto-join.js');
  const { auto, home, server } = await historyFixture();
  server.answers[IMPORT_PLAN] = IMPORT_DONE;
  const bad = path.join(home, 'bad');
  fs.mkdirSync(path.join(bad, '.git'), { recursive: true });
  recordDefaultDeployment(SERVER, { mycoHome: home });
  const key = auto.rootKeyFor(bad, home);
  auto.requestJoin(bad, key, SERVER, home, 1);
  auto.markLeft(key, home, 1);
  const marker = path.join(auto.autoJoinDir(home), 'left', key + '.json');
  fs.writeFileSync(marker, '{ torn');
  const now = Date.now();
  await joinPass(home, { now: () => now, fetch: server.fetch })(now + 1000, { force: false });
  expect(server.count(IMPORT_PLAN)).toBe(1);
  expect(auto.listPendingImports(home)).toEqual([]);
  expect(auto.listJoinRequests(home)).toHaveLength(1);
  expect(fs.readFileSync(marker, 'utf8')).toBe('{ torn');
});

it('retains a join request while reconnect reconciliation is busy', async () => {
  const { joinPass } = await import('@myco/cli/member-auto-join.js');
  const { rootKeyFor, markLeft, requestJoin, listJoinRequests, markSweepDone } = await import('@myco/member/auto-join.js');
  const home = scratch(), root = path.join(home, 'repo');
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  writeDeploymentMembership({ serverUrl: SERVER, token: 'mt_' + 'a'.repeat(40), machineId: 'machine', joinedAt: 1, updatedAt: 1 }, { mycoHome: home });
  recordDefaultDeployment(SERVER, { mycoHome: home });
  const key = rootKeyFor(root, home);
  markLeft(key, home, 1);
  markSweepDone(home, 1);
  cacheMachineSettings(SERVER, { leaves: { 'capture.connect_roots': { [key]: 'proj_fixture' } } }, home);
  requestJoin(root, key, SERVER, home, 1);
  const lock = acquireRegistryLock(home);
  if (!lock.acquired) throw new Error('fixture lock unavailable');
  try {
    await joinPass(home, { now: () => 100 })(1000, { force: false });
    expect(listJoinRequests(home)).toHaveLength(1);
  } finally { lock.lock.release(); }
});

it('settles every opt-out report before leave resumes registry mutations', async () => {
  const { runLeave } = await import('@myco/cli/member.js');
  const registry = await import('@myco/member/registry.js');
  const home = scratch(), root = path.join(home, 'repo');
  fs.mkdirSync(root);
  execFileSync('git', ['init', '-q', root]);
  registry.writeRegistryEntry({ version: registry.REGISTRY_VERSION, root, serverUrl: SERVER, projectId: 'proj_fixture',
    token: 'mt_' + 'a'.repeat(40), machineId: 'machine', joinedAt: 1, updatedAt: 1, expiresAt: 10_000, refreshAfter: 5_000 }, { mycoHome: home });
  const answered: Array<{ connected: boolean }> = [];
  const server = fakeDeployment({ [UNCAPTURED_STATE_PATH]: async () => {
    await new Promise(resolve => setTimeout(resolve, 20));
    answered.push({ connected: registry.readRegistryEntry(root, home) !== null });
    if (answered.length === 1) throw new Error('fixture report failed');
    return Response.json({ persisted: true });
  } });
  expect(await runLeave([], { mycoHome: home, cwd: root, now: () => 100, stdout: () => {}, stderr: () => {}, fetch: server.fetch })).toBe(true);
  expect(answered.length).toBeGreaterThan(0);
  expect(answered.every(report => report.connected)).toBe(true);
  expect(registry.readRegistryEntry(root, home)).toBeNull();
});

it('keeps a durable opt-out intact during background connection repair', async () => {
  const { settleConnection } = await import('@myco/cli/member-auto-join.js');
  const { readRegistryEntry } = await import('@myco/member/registry.js');
  const { auto, home, root, pending } = await historyFixture();
  auto.markLeft(pending.rootKey, home, 1, { explicitJoinOnly: true, repository: { root } });
  const entry = readRegistryEntry(root, home)!;
  const deps = { mycoHome: home, now: () => 100, tell: false, fetch: async () => new Response('{}', { status: 503 }) };
  await expect(settleConnection(entry, deps)).rejects.toThrow('was left');
  expect(auto.isLeft(pending.rootKey, home)).toBe(true);
  await settleConnection(entry, { ...deps, explicitJoin: true });
  expect(auto.isLeft(pending.rootKey, home)).toBe(false);
});

it('does not wake history the join pass cannot act on', async () => {
  const { registryEntryPath, deploymentKeyFor } = await import('@myco/member/registry.js');
  for (const failure of ['unreadable-binding', 'changed-identity']) {
    const { auto, home, root, pending } = await historyFixture();
    if (failure === 'unreadable-binding') fs.writeFileSync(registryEntryPath(root, home), '{ torn');
    else {
      const file = path.join(auto.autoJoinDir(home), 'imports', deploymentKeyFor(SERVER), pending.projectId, pending.rootKey + '.json');
      fs.writeFileSync(file, JSON.stringify({ ...pending, rootKey: 'f'.repeat(32) }));
      fs.renameSync(file, path.join(path.dirname(file), 'f'.repeat(32) + '.json'));
    }
    expect(auto.pendingImportsDue(home, 100)).toBe(false);
  }
});

it('renews a queued history credential before importing and retains transient renewal failures', async () => {
  const { joinPass } = await import('@myco/cli/member-auto-join.js');
  const registry = await import('@myco/member/registry.js');
  const { auto, home, root, pending, server } = await historyFixture();
  const fresh = 'mt_' + 'b'.repeat(40);
  const now = Date.now();
  const expire = () => registry.writeRegistryEntry({ ...registry.readRegistryEntry(root, home)!, refreshAfter: 1, expiresAt: now - 10 }, { mycoHome: home });
  expire();
  const bearers: Array<string | null> = [];
  server.answers['/tokens/refresh'] = () => Response.json({ refreshed: true, token: fresh, tokenId: 'fresh', expiresAt: 1e15, refreshAfter: 1e15 });
  server.answers[IMPORT_PLAN] = request => { bearers.push(request.headers.get('authorization')); return IMPORT_DONE.clone(); };
  await joinPass(home, { now: () => now, fetch: server.fetch })(now + 1000, { force: false });
  expect(server.requests).toEqual(['/tokens/refresh', IMPORT_PLAN]);
  expect(bearers).toEqual(['Bearer ' + fresh]);
  expect(auto.listPendingImports(home)).toEqual([]);
  expire(); auto.queueImport(pending, home);
  const down = fakeDeployment({ '/tokens/refresh': new Response('{}', { status: 503 }) });
  await joinPass(home, { now: () => now, fetch: down.fetch })(now + 1000, { force: false });
  expect(down.count(IMPORT_PLAN)).toBe(0);
  expect(auto.listPendingImports(home)[0]).toMatchObject({ attempts: 1 });
  expect(auto.listPendingImports(home)[0]?.terminal).toBeUndefined();
});

it('reads quoted Windows runner programs and URLs from the task it writes', async () => {
  const { renderUnit, servicePaths } = await import('@myco/server/service.js');
  const { workerServiceSpec, installedRunnerTarget, listWorkerUnits } = await import('@myco/runner/service.js');
  for (const binaryPath of ['/opt\\bin\\myco.exe', ...(process.platform === 'win32' ? ['C:\\Users\\josé\\bin\\myco.exe'] : [])]) {
    const home = scratch();
    const target = { executor: 'runner' as const, home, mycoHome: path.join(home, 'josé(1)'), binaryPath, serverUrl: 'http://[::1]:8787', platform: 'win32' as const };
    const spec = workerServiceSpec(target, []), paths = servicePaths(spec, 'win32');
    fs.mkdirSync(path.dirname(paths.unitFile), { recursive: true });
    fs.writeFileSync(paths.unitFile, renderUnit(spec, paths, 'win32'));
    expect(installedRunnerTarget({ ...target, binaryPath: '/candidate/myco.exe' }).binaryPath).toBe(binaryPath);
    expect(listWorkerUnits(home, 'win32', true).find(unit => unit.unitFile === paths.unitFile))
      .toMatchObject({ serverUrl: target.serverUrl, mycoHome: target.mycoHome });
    const legacy = workerServiceSpec({ ...target, executor: 'legacy-member' }, []), legacyPaths = servicePaths(legacy, 'win32');
    fs.writeFileSync(legacyPaths.unitFile, renderUnit(legacy, legacyPaths, 'win32'));
    expect(listWorkerUnits(home, 'win32').find(unit => unit.unitFile === legacyPaths.unitFile))
      .toMatchObject({ serverUrl: target.serverUrl, mycoHome: target.mycoHome, executor: 'legacy-member' });
    fs.writeFileSync(paths.unitFile, renderUnit(spec, paths, 'win32').replaceAll(target.mycoHome, path.join(home, 'foreign')));
    expect(() => installedRunnerTarget(target)).toThrow();
  }
});

it('surfaces a held history import through member status and doctor', async () => {
  const { runStatus } = await import('@myco/cli/member.js');
  const { homeReport } = await import('@myco/cli/member-doctor.js');
  const { auto, home, root, pending } = await historyFixture();
  auto.queueImport({ ...pending, terminal: { at: 100, reason: 'unauthorized' } }, home);
  const lines: string[] = [];
  runStatus([], { mycoHome: home, cwd: root, now: () => 200, stdout: line => lines.push(line), stderr: () => {} });
  const warning = lines.find(line => line.includes('history') && line.includes('unauthorized'));
  expect(warning).toContain('myco member join');
  const checks = await homeReport(home, { mycoHome: home, cwd: root, now: () => 200, fetch: async () => new Response('{}', { status: 503 }) });
  expect(checks.find(check => check.detail === warning)?.status).toBe('warn');
});
