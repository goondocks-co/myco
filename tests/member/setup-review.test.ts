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

const roots: string[] = [];
const scratch = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-setup-review-'));
  roots.push(root);
  return root;
};
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
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
  fs.writeFileSync(path.join(root, '.myco/runtime.home'), pinned);
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
  fs.writeFileSync(file, '# user note\nmodel = "custom" # keep this\n\n[mcp_servers.myco]\ncommand = "' + legacy + '/bin/myco"\nargs = ["mcp"]\n\n[mcp_servers.other]\ncommand = "other" # other note\n');
  const scan = scanLegacyRegistrations({ homeDir: root, folders: [], legacyHomes: [legacy] });
  removeLegacyRegistrations(file, scan.findings, [legacy]);
  expect(fs.readFileSync(file, 'utf8')).toContain('# user note\nmodel = "custom" # keep this');
  expect(fs.readFileSync(file, 'utf8')).toContain('command = "other" # other note');
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
  const imports = await import('@myco/member/import.js');
  const { queueImport, listPendingImports, markSweepDone } = await import('@myco/member/auto-join.js');
  const { writeRegistryEntry, REGISTRY_VERSION } = await import('@myco/member/registry.js');
  const home = scratch();
  const root = path.join(home, 'repo');
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  writeRegistryEntry({ version: REGISTRY_VERSION, root, serverUrl: SERVER, projectId: 'proj_fixture',
    token: 'mt_' + 'a'.repeat(40), machineId: 'machine', joinedAt: 1, updatedAt: 1 }, { mycoHome: home });
  queueImport({ root, rootKey: rootKeyFor(root, home), serverUrl: SERVER, projectId: 'proj_fixture', at: 1 }, home);
  markSweepDone(home, 1);
  let clock = 100;
  const report = { projects: [{ projectId: 'proj_fixture', root, agents: [], endedBy: 'retry' }], unbound: 0,
    unattributable: 0, active: 0, dropped: 0, excluded: 0, unboundDirectories: {} };
  const run = spyOn(imports, 'runImport').mockResolvedValue(report);
  try {
    await joinPass(home, { now: () => clock })(1000, { force: false });
    expect(listPendingImports(home)).toHaveLength(1);
    await joinPass(home, { now: () => clock })(1000, { force: false });
    expect(run).toHaveBeenCalledTimes(1);
    clock += 3_600_000;
    run.mockResolvedValue({ ...report, projects: [{ projectId: 'proj_fixture', root, agents: [] }] });
    await joinPass(home, { now: () => clock })(clock + 1000, { force: false });
    expect(listPendingImports(home)).toEqual([]);
  } finally { run.mockRestore(); }
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
  const file = path.join(home, 'transcript');
  fs.writeFileSync(file, 'abc');
  for (const id of ['a', 'b']) updateSessionState(spool.dir, id, state => {
    state.agent = 'claude-code';
    state.transcript = { path: file, transcriptId: id, inode: fs.statSync(file).ino, nextOffset: 0, parsedSize: 3 };
  });
  const lease = spool.withSessionLease.bind(spool);
  const failure = spyOn(spool, 'withSessionLease').mockImplementation((id, fn) => {
    if (id === 'a') throw new Error('fixture transcript denied');
    return lease(id, fn);
  });
  const client = new ServerClient({ serverUrl: SERVER, projectId: 'proj_fixture', token: 'fixture' },
    async () => Response.json({ stored: true, persisted: true }), { credentialSource: 'env' });
  try {
    const report = await drainBacklog(spool, client, deadlineBudget(Date.now() + 10_000), { machineId: 'machine' });
    expect(report.sessions.map(s => s.sessionId)).toEqual(['a', 'b']);
    expect(report.sessions[0]).toMatchObject({ error: 'fixture transcript denied' });
    expect(spool.transcriptBacklogIds()).toContain('a');
    expect(fs.readFileSync(path.join(spool.dir, BACKLOG_CURSOR_FILE), 'utf8')).toBe('b');
  } finally { failure.mockRestore(); }
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
