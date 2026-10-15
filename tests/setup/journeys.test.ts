import { renderSetupStatus } from '@myco/cli/setup-status.js';
import { rootSlug } from '@myco/symbionts/transcript-attribution.js';
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sandboxChildEnv } from '../../scripts/test-environment.mjs';
import { run, parseSetupOptions } from '@myco/cli/setup.js';
import { run as login } from '@myco/cli/login.js';
import { runRunnerService } from '@myco/cli/runner-service.js';
import { executorServiceTarget } from '@myco/cli/worker-service.js';
import { homeReport } from '@myco/cli/member-doctor.js';
import { consentToPlan, cutoverConsentPlan, type SetupDeps } from '@myco/setup/steps.js';
import { observeSetup } from '@myco/setup/observe.js';
import { planFingerprint, readSetupFile, saveSetupFile, setupFilePath } from '@myco/setup/answers.js';
import { readDeploymentMembership, readRegistryEntry, writeDeploymentMembership, writeRegistryEntry, deploymentPath, deploymentKeyFor, machineSettingsPath } from '@myco/member/registry.js';
import { legacyMigrationState, type LegacyMigrationState } from '@myco/member/legacy-migration.js';
import { legacyVaultStamp } from '@myco/member/legacy-sources.js';
import { readVaultContent } from '@myco/member/legacy-backup.js';
import { MemberSpool } from '@myco/member/spool.js';
import { mintId, promptEvent } from '@myco/member/envelope.js';
import { bufferLockPath, sessionStatePath, updateSessionState } from '@myco/member/session-state.js';
import { installWorkerService } from '@myco/runner/service.js';
import { workerLockPath } from '@myco/runner/instance.js';
import { recordDefaultDeployment, readDefaultDeployment } from '@myco/member/default-deployment.js';
import { readRunnerRecord, recordRunnerContact, runnerRecordPath } from '@myco/runner/runner-registry.js';
import { LifecycleLock } from '@myco/utils/lifecycle-lock.js';
import { recordingPlatform } from '../helpers/fake-service-manager.js';
import { enrolledBeforeInstall } from './fixtures/interrupted-state.js';
import { legacyFixtureHome } from './fixtures/legacy-home.js';
import { fakeGitHub, SETUP_APP } from './fixtures/github.js';
import { createBunHandler, type BunHandler } from '@myco-server-worker/entry/bun.js';
import { createServer } from '@myco-server-worker/pipeline.js';
import { sqliteEnv } from '../myco-server/helpers/fixtures.js';
import { seededSqlite } from '../myco-server/helpers/d1.js';
import { SESSION_SECRET } from '../myco-server/helpers/owner.js';
import { OAUTH_STATE_COOKIE } from '@myco-server-worker/auth/owner/github.js';
import { SESSION_COOKIE } from '@myco-server-worker/auth/owner/cookie.js';
import { ownerDeployment, ACCOUNT, HOSTED_URL } from './fixtures/owner-deployment.js';
import { createCloudflareDeployment, planCloudflareDeployment } from '@myco/server/cloudflare-lifecycle.js';
import { prepareLocal } from '@myco/server/local-lifecycle.js';
import { registerGitHubApp, convertManifestCode, writeSignInPending, signInPendingPath } from '@myco/server/github-app.js';
import { peekDeploymentRecord, writeDeploymentRecord } from '@myco/server/cloudflare.js';
import { peekLocalPaths, readLocalSecrets, createLocalDeployment, DEFAULT_LOCAL_RECORD } from '@myco/server/local.js';
import { runJoin } from '@myco/cli/member.js';
import { cloudflareOwnerLinked } from '@myco/server/cloudflare-owner.js';
import { SERVER_SCHEMA_VERSION } from '@myco-server-worker/constants.js';
import { legacyJourney, LEGACY_URLS } from './fixtures/legacy-journey.js';
import { planCutover, runCutover, run as cutoverRun } from '@myco/cli/cutover.js';
import { readCutoverState } from '@myco/member/legacy-migration.js';
import { legacyHistoryCompletionGroups, readLegacyVault } from '@myco/member/legacy-import.js';

const URL = 'https://setup.invalid';
const fakeFetch = (fn: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>): typeof fetch => Object.assign(fn, { preconnect: () => {} });
let root: string;
let home: string;
let project: string;
let lines: string[];
let errors: string[];
const closers: (() => void | Promise<void>)[] = [];
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-setup-journey-'));
  home = path.join(root, 'myco'); project = path.join(root, 'repo');
  fs.mkdirSync(project);
  execFileSync('git', ['init', '-q'], { cwd: project });
  lines = []; errors = [];
});
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  fs.rmSync(root, { recursive: true, force: true });
  process.exitCode = 0;
});
const base = (): SetupDeps => ({ mycoHome: home, cwd: project, ask: async () => null, agents: () => [], stdout: line => lines.push(line), stderr: line => errors.push(line) });

function holdRunnerLock(lockDir: string): void {
  const held = LifecycleLock.acquire(workerLockPath(lockDir, URL), { command: 'fixture runner' });
  if (!held.acquired) throw new Error('Fixture runner lock already held');
  closers.push(() => held.lock.release());
}

/** Names, contents, modes and mtimes cover status's filesystem contract. */
function snapshot(directory: string): unknown {
  if (!fs.existsSync(directory)) return null;
  return fs.readdirSync(directory).sort().map((name) => {
    const file = path.join(directory, name);
    const stat = fs.lstatSync(file);
    return [name, stat.mode, stat.mtimeMs, stat.isDirectory() ? snapshot(file) : stat.isSymbolicLink() ? fs.readlinkSync(file) : fs.readFileSync(file).toString('base64')];
  });
}

describe('legacy journey (e)', () => {
  const flags = ['--join', LEGACY_URLS[0], '--cutover', '--no-agents', '--no-runner', '--yes'];
  const rig = async (options: { multi?: boolean; missing?: boolean; secondMembership?: boolean; agents?: string[] } = {}) => {
    const fixture = await legacyJourney(path.join(root, 'journey-e'), options);
    closers.push(fixture.close);
    home = fixture.legacy.mycoHome;
    return { ...fixture, deps: { ...fixture.deps, stdout: (line: string) => lines.push(line), stderr: (line: string) => errors.push(line) } };
  };

  it('completes from the repository routed to the other Deployment and reruns cleanly', async () => {
    const fixture = await rig({ multi: true });
    const deps = { ...fixture.deps, cwd: fixture.legacy.projects[1]!.root };
    expect({ code: await run(flags, deps), errors }).toEqual({ code: 0, errors: [] });
    expect(lines.filter(line => line.startsWith('Moved to 2.0.'))).toHaveLength(1);
    expect(readRegistryEntry(deps.cwd, home)?.serverUrl).toBe(LEGACY_URLS[1]);
    expect(lines.at(-1)).toContain(`then open ${LEGACY_URLS[1]}.`);
    expect(await run([], deps)).toBe(0);
    expect(lines.at(-1)).toContain(`then open ${LEGACY_URLS[1]}.`);
  });

  it('discloses fallback placement before consent and requires choices with two memberships', async () => {
    const fixture = await rig({ secondMembership: true });
    const bytes = fs.readFileSync(fixture.legacy.vault);
    expect(await run(flags, fixture.deps)).toBe(2);
    expect(lines.join('\n')).toContain('(default Deployment; no repository route)');
    expect(readSetupFile(home).consented.cutover).toBeUndefined();
    expect(readCutoverState(home).migrations).toBeUndefined();
    expect(errors.join('\n')).toContain(`--route ${fixture.legacy.projects[0]!.id}=<url> or --skip`);
    const [a, b] = fixture.legacy.projects;
    expect(await run(['--yes', '--route', `${a!.id}=${LEGACY_URLS[0]}`], fixture.deps)).toBe(2);
    expect(await run(['--yes', '--skip', b!.id], fixture.deps)).toBe(0);
    expect(fs.readFileSync(fixture.legacy.vault)).toEqual(bytes);
  });

  it('asks about every fallback project with two memberships', async () => {
    const fixture = await rig({ secondMembership: true });
    const questions: string[] = [];
    expect(await run(flags, { ...fixture.deps, ask: async question => {
      questions.push(question);
      return question.includes(fixture.legacy.projects[0]!.id) ? LEGACY_URLS[0] : LEGACY_URLS[1];
    } })).toBe(0);
    expect(questions).toHaveLength(2);
    for (const [index, p] of fixture.legacy.projects.entries()) expect(readRegistryEntry(p.root, home)?.serverUrl).toBe(LEGACY_URLS[index]);
  });

  it('prints the moved summary before a later setup step fails', async () => {
    const fixture = await rig();
    expect(await run([...flags, '--project', fixture.legacy.projects[0]!.id], { ...fixture.deps, join: async () => null })).toBe(2);
    expect(legacyMigrationState(home).state).toBe('moved');
    expect(lines.filter(line => line.startsWith('Moved to 2.0.'))).toHaveLength(1);
    expect(errors.join('\n')).toContain('Project connection did not finish');
  });

  function transcriptOnDisk(fixture: Awaited<ReturnType<typeof legacyJourney>>, sessionId: string, stamp: Date): string {
    const project = fixture.legacy.projects[0]!;
    let file = '';
    for (const base of new Set([path.join(fixture.legacy.home, '.claude'), process.env.CLAUDE_CONFIG_DIR!])) {
      file = path.join(base, 'projects', `-${rootSlug(project.root)}`, `${sessionId}.jsonl`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, [
        { type: 'user', cwd: project.root, sessionId, message: { content: 'Retained transcript ' + 'x'.repeat(5000) }, timestamp: stamp.toISOString() },
        { type: 'assistant', cwd: project.root, sessionId, message: { content: [{ type: 'text', text: 'Retained response' }] }, timestamp: new Date(stamp.getTime() + 1000).toISOString() },
      ].map(row => JSON.stringify(row) + '\n').join(''));
      fs.utimesSync(file, stamp, stamp);
    }
    return file;
  }

  for (const evidence of ['confirmed', 'malformed', 'archived', 'transcript', 'transcript-held', 'archived-transcript', 'deleted-transcript', 'receipt-archived-transcript', 'title-only', 'confirmed-dry-run', 'confirmed-setup', 'absent', 'growth', 'deleted', 'denied', 'unreachable'] as const) it(`recovers alpha backup-only moves only with Deployment evidence: ${evidence}`, async () => {
    const fixture = await rig();
    if (evidence === 'malformed') {
      const source = new Database(fixture.legacy.vault);
      try { source.run("INSERT INTO resolution_events (id, project_id, agent_id, spore_id, action, reason, created_at) VALUES ('bad-lineage', ?, 'user', ?, 'supersede', 'Missing successor', 1700000060)", [fixture.legacy.projects[0]!.id, 'spore_' + fixture.legacy.projects[0]!.id]); }
      finally { source.close(); }
    }
    if (evidence === 'title-only') {
      const source = new Database(fixture.legacy.vault);
      try { source.run('DELETE FROM prompt_batches'); } finally { source.close(); }
    }
    if (evidence === 'transcript' || evidence === 'transcript-held') {
      const project = fixture.legacy.projects[0]!;
      const id = crypto.randomUUID();
      const stamp = new Date(Date.now() - 3 * 86_400_000);
      const transcript = transcriptOnDisk(fixture, id, stamp);
      const source = new Database(fixture.legacy.vault);
      try {
        source.run('PRAGMA foreign_keys = OFF');
        source.run('UPDATE sessions SET id = ?, transcript_path = ?, started_at = ?, ended_at = ? WHERE id = ?', [id, transcript, stamp.getTime() / 1000, stamp.getTime() / 1000 + 60, project.sessionId]);
        source.run('UPDATE prompt_batches SET session_id = ?, started_at = ? WHERE session_id = ?', [id, stamp.getTime() / 1000, project.sessionId]);
      } finally { source.close(); }
    }
    const before = fs.readFileSync(fixture.legacy.vault);
    expect(await run(flags, fixture.deps)).toBe(0);
    const state = readCutoverState(home);
    if (evidence === 'transcript-held') {
      const source = readLegacyVault(fixture.legacy.vault)[0]!;
      const id = source.sessions[0]!.id;
      for (const base of new Set([path.join(fixture.legacy.home, '.claude'), process.env.CLAUDE_CONFIG_DIR!]))
        fs.unlinkSync(path.join(base, 'projects', `-${rootSlug(fixture.legacy.projects[0]!.root)}`, `${id}.jsonl`));
    }
    const file = path.join(home, 'member', 'cutover.json');
    if (evidence === 'absent' || evidence === 'growth') fs.unlinkSync(file);
    else if (evidence === 'receipt-archived-transcript' || evidence === 'deleted-transcript') {
      for (const receipt of Object.values(state.migrations!)) for (const project of Object.values(receipt.projects)) {
        delete project.transcripts;
        delete project.destinations;
      }
      fs.writeFileSync(file, JSON.stringify(state));
    } else fs.writeFileSync(file, JSON.stringify({ backups: state.backups }));
    if (evidence.endsWith('-transcript')) transcriptOnDisk(fixture, crypto.randomUUID(), new Date(Date.now() - 2 * 86_400_000));
    if (evidence === 'growth') {
      const source = new Database(fixture.legacy.vault);
      try { source.run("INSERT INTO sessions (id, project_id, agent, started_at, ended_at, status, created_at) VALUES ('new-unmoved', ?, 'claude-code', 1700000100, 1700000200, 'completed', 1700000100)", [fixture.legacy.projects[0]!.id]); }
      finally { source.close(); }
    }
    const sourceBytes = fs.readFileSync(fixture.legacy.vault);
    const destination = new Database(path.join(root, 'journey-e', 'deployment-0.sqlite'));
    try {
      if (['archived', 'archived-transcript', 'receipt-archived-transcript'].includes(evidence)) destination.run('UPDATE projects SET archived_at = 1');
      if (evidence === 'denied') destination.run("UPDATE events SET producer_adapter = 'claude-code'");
      if (evidence === 'title-only') for (const source of readLegacyVault(fixture.legacy.vault)) {
        const titleId = legacyHistoryCompletionGroups(source, 'machine_1', home)[0]![1]!;
        destination.run("UPDATE events SET producer_adapter = 'claude-code', channel = 'cli' WHERE project_id = ? AND event_id <> ?", [source.projectId, titleId]);
      }
      if (evidence === 'deleted' || evidence === 'deleted-transcript') {
        destination.run('PRAGMA foreign_keys = OFF');
        for (const project of fixture.legacy.projects) destination.run('DELETE FROM projects WHERE project_id = ?', [project.id]);
      }
    } finally { destination.close(); }
    const deps = evidence === 'unreachable' ? { ...fixture.deps, fetch: fakeFetch(async () => { throw new Error('offline'); }) } : fixture.deps;
    const requests = fixture.calls.length;
    if (evidence === 'confirmed-dry-run') expect(await cutoverRun(['--dry-run'], { ...fixture.deps.cutoverDeps, mycoHome: home, fetch: deps.fetch, stdout: line => lines.push(line), stderr: line => errors.push(line) })).toBe(true);
    if (evidence === 'confirmed-setup') expect(await run(flags, { ...fixture.deps, ask: async question => { throw new Error(`Unexpected prompt: ${question}`); } })).toBe(0);
    const observations = await observeSetup(home, {}, { fetch: deps.fetch, agents: () => [], status: true });
    if (['confirmed', 'malformed', 'archived', 'transcript', 'transcript-held', 'archived-transcript', 'deleted-transcript', 'receipt-archived-transcript', 'title-only', 'confirmed-dry-run', 'confirmed-setup', 'absent'].includes(evidence)) {
      const terminal = ['confirmed-setup', 'archived', 'archived-transcript', 'deleted-transcript', 'receipt-archived-transcript'].includes(evidence);
      expect(legacyMigrationState(home).state).toBe(terminal ? 'moved' : 'partial');
      if (!['receipt-archived-transcript', 'deleted-transcript'].includes(evidence)) expect(readCutoverState(home)).toMatchObject({ version: 2, migrations: { [fixture.legacy.vault]: { projects: {
        [fixture.legacy.projects[0]!.id]: { evidence: { kind: 'deployment', machineId: 'machine_1' } },
      } } } });
      if (evidence === 'malformed') {
        expect(legacyMigrationState(home).ignoredLineage).toBe(1);
        expect(renderSetupStatus(observations).join('\n')).toContain('Skipped 1 malformed 1.4 lineage event');
      }
      const plan = planCutover(home, { homeDir: fixture.legacy.home, dryRun: true }, fixture.deps.cutoverDeps);
      expect(plan.projects.map(project => project.destination.kind)).toEqual(terminal ? ['moved', 'moved'] : ['destination', 'destination']);
      expect(await run(flags, { ...fixture.deps, ask: async question => { throw new Error(`Unexpected prompt: ${question}`); } })).toBe(0);
      expect(fixture.calls.slice(requests).filter(call => ['/events', '/spores/save', '/members/projects/resolve'].includes(call.route))).toEqual([]);
      if (terminal && evidence !== 'confirmed-setup') {
        expect(lines.join('\n') + errors.join('\n')).not.toContain('unarchive');
        for (const project of fixture.legacy.projects) expect(renderSetupStatus(observations).join('\n')).toContain(`${path.basename(project.root)} has been moved; its project is ${evidence === 'deleted-transcript' ? 'deleted' : 'archived'} on the Deployment.`);
        expect(readCutoverState(home).migrations![fixture.legacy.vault]!.projects[fixture.legacy.projects[0]!.id]!.transcripts).toMatchObject({ state: 'none', endedBy: evidence === 'deleted-transcript' ? 'project_deleted' : 'project_archived' });
      }
      const receipt = fs.readFileSync(file);
      await observeSetup(home, {}, { fetch: fakeFetch(async () => { throw new Error('terminal receipts must stay offline'); }), agents: () => [], status: true });
      expect(fs.readFileSync(file)).toEqual(receipt);
    } else {
      expect(legacyMigrationState(home).state).toBe('needs-destination');
      if (evidence === 'growth') expect(readCutoverState(home).migrations?.[fixture.legacy.vault]?.projects[fixture.legacy.projects[0]!.id]?.destination).toBeUndefined();
      else expect(readCutoverState(home).migrations).toBeUndefined();
      if (evidence !== 'growth') expect(observations.find(fact => fact.id === 'legacy')?.hint).toContain(evidence === 'unreachable' ? 'online' : evidence === 'deleted' ? 'no longer on' : 'destination');
    }
    expect(fs.readFileSync(fixture.legacy.vault)).toEqual(sourceBytes);
    if (evidence !== 'growth') expect(sourceBytes).toEqual(before);
  });

  it('finishes transcripts terminally when the destination is archived immediately after the vault checkpoint', async () => {
    const fixture = await rig();
    const project = fixture.legacy.projects[0]!;
    transcriptOnDisk(fixture, crypto.randomUUID(), new Date(Date.now() - 2 * 86_400_000));
    const before = fs.readFileSync(fixture.legacy.vault);
    const cutoverDeps = { ...fixture.deps.cutoverDeps, onCheckpoint: (label: string) => {
      if (label !== `vault:${project.id}`) return;
      const db = new Database(path.join(root, 'journey-e', 'deployment-0.sqlite'));
      try { db.run('UPDATE projects SET archived_at = 1 WHERE project_id = ?', [project.id]); }
      finally { db.close(); }
    } };
    expect(await run(flags, { ...fixture.deps, cutoverDeps })).toBe(0);
    expect(legacyMigrationState(home).state).toBe('moved');
    expect(readCutoverState(home).migrations![fixture.legacy.vault]!.projects[project.id]!.transcripts).toMatchObject({ state: 'none', endedBy: 'project_archived' });
    expect(lines.join('\n') + errors.join('\n')).not.toContain('unarchive');
    expect(lines.join('\n')).toContain(`${path.basename(project.root)} has been moved; its project is archived on the Deployment.`);
    expect(fs.readFileSync(fixture.legacy.vault)).toEqual(before);
  });

  it('confirms each candidate once across an entire setup run and retries only transcripts after vault evidence', async () => {
    const fixture = await rig();
    expect(await run(flags, fixture.deps)).toBe(0);
    const state = readCutoverState(home);
    fs.writeFileSync(path.join(home, 'member', 'cutover.json'), JSON.stringify({ backups: state.backups }));
    const requests = fixture.calls.length;
    expect(await run(flags, fixture.deps)).toBe(0);
    const calls = fixture.calls.slice(requests);
    for (const project of fixture.legacy.projects) {
      expect(calls.filter(call => call.route === '/import/legacy-history' && call.project === project.id)).toHaveLength(3);
      expect(readCutoverState(home).migrations?.[fixture.legacy.vault]?.projects[project.id]).toMatchObject({ vault: { state: 'complete' }, transcripts: { state: 'complete' } });
    }
    expect(lines.join('\n')).toContain('only the transcript pass remains');
    expect(calls.filter(call => ['/events', '/spores/save', '/spores/resolve'].includes(call.route))).toEqual([]);
  });

  it('sends one denied confirmation pass per candidate across setup observations and conductLegacy', async () => {
    const fixture = await rig();
    expect(await run(flags, fixture.deps)).toBe(0);
    const state = readCutoverState(home);
    fs.writeFileSync(path.join(home, 'member', 'cutover.json'), JSON.stringify({ backups: state.backups }));
    const counts = new Map<string, number>();
    const fetch = fakeFetch(async (input, init) => {
      const request = new Request(input, init);
      if (new globalThis.URL(request.url).pathname === '/import/legacy-history') {
        const project = request.headers.get('x-myco-project')!;
        counts.set(project, (counts.get(project) ?? 0) + 1);
        return Response.json({ persisted: true, confirmed: false });
      }
      return fixture.deps.fetch!(input, init);
    });
    expect({ code: await run(flags, { ...fixture.deps, fetch }), errors }).toEqual({ code: 0, errors: [] });
    expect([...counts.values()]).toEqual([1, 1]);
    expect(fs.readFileSync(fixture.legacy.vault)).toEqual(fs.readFileSync(path.join(root, 'journey-e', 'vault-before')));
  });

  for (const version of [2, 1, undefined] as const) for (const disposition of ['archived', 'deleted'] as const) {
    it(`keeps ${disposition} destinations moved with ${version ?? 'unversioned'} completion receipts`, async () => {
      const fixture = await rig();
      const before = fs.readFileSync(fixture.legacy.vault);
      expect(await run(flags, fixture.deps)).toBe(0);
      const state = readCutoverState(home);
      if (version !== 2) {
        state.version = version;
        for (const receipt of Object.values(state.migrations!)) for (const project of Object.values(receipt.projects)) delete project.destinations;
        fs.writeFileSync(path.join(home, 'member', 'cutover.json'), JSON.stringify(state));
      }
      const destination = new Database(path.join(root, 'journey-e', 'deployment-0.sqlite'));
      try {
        destination.run('PRAGMA foreign_keys = OFF');
        for (const project of fixture.legacy.projects) {
          destination.query(disposition === 'archived'
            ? 'UPDATE projects SET archived_at = 1 WHERE project_id = ?'
            : 'DELETE FROM projects WHERE project_id = ?').run(project.id);
        }
      } finally { destination.close(); }
      const requests = fixture.calls.length;
      expect(legacyMigrationState(home).state).toBe('moved');
      const plan = planCutover(home, { homeDir: fixture.legacy.home, dryRun: true }, fixture.deps.cutoverDeps);
      expect(plan.blockers).toEqual([]);
      expect(plan.projects.map(project => project.destination.kind)).toEqual(fixture.legacy.projects.map(() => 'moved'));
      lines = [];
      expect((await runCutover(plan, { ...fixture.deps.cutoverDeps, stdout: line => lines.push(line), fetch: fixture.deps.fetch })).ok).toBe(true);
      expect(lines.join('\n')).not.toContain('would then import');
      expect(fixture.calls).toHaveLength(requests);
      lines = [];
      expect(await run(flags, { ...fixture.deps, ask: async question => { throw new Error(`Unexpected cutover prompt: ${question}`); } })).toBe(0);
      expect(lines.join('\n')).not.toContain('cutover preview');
      expect(fixture.calls.slice(requests).filter(call => ['/events', '/spores/save', '/members/projects/resolve'].includes(call.route))).toEqual([]);
      expect(legacyMigrationState(home).state).toBe('moved');
      expect(fs.readFileSync(fixture.legacy.vault)).toEqual(before);
    });
  }

  for (const multi of [false, true]) it(`moves the coherent 1.4 home to ${multi ? 'two destinations' : 'one destination'} and resumes without duplicates`, async () => {
    const fixture = await rig({ multi });
    expect(JSON.parse(fs.readFileSync(path.join(root, 'journey-e', 'legacy-fixture.json'), 'utf8'))).not.toHaveProperty('env');
    const before = fs.readFileSync(fixture.legacy.vault);
    const userFile = fs.readFileSync(path.join(home, 'unmanaged.txt'));
    const binary = fs.readFileSync(fixture.legacy.binary);
    expect({ code: await run(flags, fixture.deps), errors }).toEqual({ code: 0, errors: [] });
    expect(errors).toEqual([]);
    expect(legacyMigrationState(home).state).toBe('moved');
    const receipts = readCutoverState(home).migrations![fixture.legacy.vault]!;
    for (const [index, project] of fixture.legacy.projects.entries()) {
      const destination = multi ? LEGACY_URLS[index]! : LEGACY_URLS[0];
      expect(receipts.projects[project.id]!.destination).toMatchObject({ serverUrl: destination });
      expect(readRegistryEntry(project.root, home)?.serverUrl).toBe(destination);
    }
    const posts = fixture.calls.filter(call => call.route === '/events' || call.route === '/spores/save').length;
    expect(posts).toBeGreaterThan(0);
    expect(await run(['--yes'], fixture.deps)).toBe(0);
    expect(fixture.calls.filter(call => call.route === '/events' || call.route === '/spores/save')).toHaveLength(posts);
    expect(fs.readFileSync(fixture.legacy.vault)).toEqual(before);
    expect(fs.readFileSync(fixture.legacy.binary)).toEqual(binary);
    expect(fs.readFileSync(path.join(home, 'unmanaged.txt'))).toEqual(userFile);
    expect(lines.join('\n')).toContain('cutover preview (dry run)');
    if (!multi) expect(lines.join('\n').indexOf('(default Deployment; no repository route)')).toBeLessThan(lines.join('\n').indexOf('Move now?'));
    expect(lines.join('\n')).toContain('1.4 data kept');
    expect(lines.join('\n')).toContain('already-open session');
    const snapshotBefore = snapshot(root);
    expect(await run(['--status', '--json'], fixture.deps)).toBe(0);
    expect(snapshot(root)).toEqual(snapshotBefore);
  });

  for (const choice of ['route', 'skip', 'interactive'] as const) it(`requires an explicit destination for an absent project, then accepts ${choice}`, async () => {
    const fixture = await rig({ missing: true });
    const pending = fixture.legacy.projects[1]!;
    const vault = fs.readFileSync(fixture.legacy.vault);
    const skippedSpool = new MemberSpool({ serverUrl: LEGACY_URLS[0], projectId: pending.id }, { mycoHome: home });
    const retainedId = mintId();
    skippedSpool.append('retained-skip', { envelope: { eventId: retainedId, sessionId: 'retained-skip', kind: 'prompt', createdAt: 1, channel: 'cli', producer: { adapter: 'claude-code', version: 'fixture' }, payload: { promptId: mintId(), text: 'Keep skipped capture', origin: 'user' } } });
    const spoolBytes = snapshot(skippedSpool.dir);
    expect(await run(flags, fixture.deps)).toBe(2);
    expect(snapshot(skippedSpool.dir)).toEqual(spoolBytes);
    expect(errors.join('\n')).toContain(`--route ${pending.id}=<url> or --skip ${pending.id}`);
    expect(lines.join('\n')).toContain(`${pending.id}: undecided`);
    expect(readCutoverState(home).migrations).toBeUndefined();
    expect(fs.readFileSync(fixture.legacy.vault)).toEqual(vault);
    const extra = choice === 'route' ? ['--route', `${pending.id}=${LEGACY_URLS[1]}`] : choice === 'skip' ? ['--skip', pending.id] : [];
    expect(await run(['--yes', ...extra], { ...fixture.deps, ...(choice === 'interactive' ? { ask: async () => LEGACY_URLS[1] } : {}) })).toBe(0);
    const destination = readCutoverState(home).migrations![fixture.legacy.vault]!.projects[pending.id]!.destination;
    expect(destination).toMatchObject(choice === 'skip' ? { skip: true } : { serverUrl: LEGACY_URLS[1] });
    expect(fs.readFileSync(fixture.legacy.vault)).toEqual(vault);
    expect(skippedSpool.readRecords('retained-skip')).toHaveLength(0);
    const deployment = new Database(path.join(root, 'journey-e', 'deployment-0.sqlite'), { readonly: true });
    try {
      const retained = deployment.query('SELECT project_id, session_id, payload FROM events WHERE event_id = ?').get(retainedId) as { project_id: string; session_id: string; payload: string };
      expect(retained).toMatchObject({ project_id: pending.id, session_id: 'retained-skip' });
      expect(JSON.parse(retained.payload)).toMatchObject({ text: 'Keep skipped capture' });
    } finally {
      deployment.close();
    }
  });

  it('a saved cutover choice grants no consent, and a declined preview changes no legacy data', async () => {
    const fixture = await rig();
    const args = flags.filter(flag => flag !== '--yes');
    const bytes = fs.readFileSync(fixture.legacy.vault);
    expect(await run(args, fixture.deps)).toBe(2);
    expect(errors.join('\n')).toContain('--yes or an interactive terminal');
    expect(readSetupFile(home).consented.cutover).toBeUndefined();
    expect(await run([], { ...fixture.deps, ask: async () => 'no' })).toBe(2);
    expect(readCutoverState(home).migrations).toBeUndefined();
    expect(fs.readFileSync(fixture.legacy.vault)).toEqual(bytes);
    expect(await run(['--yes'], fixture.deps)).toBe(0);
  });

  it('keeps a terminal refusal partial and resumes without uploading the completed destination again', async () => {
    const fixture = await rig({ multi: true, agents: ['claude-code', 'codex'] });
    const bytes = fs.readFileSync(fixture.legacy.vault);
    const refusing = fakeFetch(async (input, init) => {
      const request = new Request(input, init);
      const url = new globalThis.URL(request.url);
      if (url.origin === LEGACY_URLS[1] && url.pathname === '/events') return Response.json({ error: 'forbidden' }, { status: 403 });
      return fixture.deps.fetch!(input, init);
    });
    expect(await run(flags.filter(flag => flag !== '--no-agents'), { ...fixture.deps, fetch: refusing })).toBe(2);
    expect(legacyMigrationState(home).state).toBe('partial');
    expect(errors.join('\n')).toContain('migration remains partial');
    fixture.calls.length = 0;
    expect(await run(['--yes'], fixture.deps)).toBe(0);
    expect(fixture.calls.filter(call => call.url === LEGACY_URLS[0] && (call.route === '/events' || call.route === '/spores/save'))).toEqual([]);
    expect(fs.readFileSync(fixture.legacy.vault)).toEqual(bytes);
  });

  for (const state of ['unmoved', 'needs-destination', 'handover-pending', 'partial', 'changed', 'moved'] as const) it(`handles coherent migration state ${state} and keeps source bytes`, async () => {
    const fixture = await rig();
    if (state !== 'unmoved') {
      expect(await run(flags, fixture.deps)).toBe(0);
      const record = readCutoverState(home);
      if (state === 'needs-destination') delete record.migrations;
      if (state === 'handover-pending') delete record.handover;
      if (state === 'partial') record.migrations![fixture.legacy.vault]!.projects[fixture.legacy.projects[0]!.id]!.transcripts!.state = 'partial';
      fs.writeFileSync(path.join(home, 'member', 'cutover.json'), JSON.stringify(record), { mode: 0o600 });
      if (state === 'partial') {
        const receipt = record.migrations![fixture.legacy.vault]!.projects[fixture.legacy.projects[0]!.id]!;
        receipt.destinations![deploymentKeyFor(LEGACY_URLS[0])]!.transcripts!.state = 'partial';
        fs.writeFileSync(path.join(home, 'member', 'cutover.json'), JSON.stringify(record));
      }
      if (state === 'changed') {
        const db = new Database(fixture.legacy.vault);
        try { db.run("UPDATE spores SET content = 'Changed 1.4 capture'"); } finally { db.close(); }
        const stat = fs.statSync(fixture.legacy.vault);
        fs.utimesSync(fixture.legacy.vault, stat.atime, new Date(stat.mtimeMs + 1000));
      }
    }
    expect(legacyMigrationState(home).state).toBe(state);
    const before = fs.readFileSync(fixture.legacy.vault);
    const snapshotBefore = snapshot(root);
    expect(await run(['--status', '--json'], fixture.deps)).toBe(state === 'moved' ? 0 : 3);
    if (state === 'needs-destination') expect(legacyMigrationState(home).state).toBe('partial');
    else expect(snapshot(root)).toEqual(snapshotBefore);
    lines = []; errors = [];
    const result = await run(flags, fixture.deps);
    expect({ result, errors }).toEqual({ result: state === 'changed' ? 2 : 0, errors: expect.any(Array) });
    if (state === 'changed') {
      expect(lines.join('\n')).toContain('Keep the 1.4 files');
      expect(errors.join('\n')).toContain('changed plans require fresh consent');
      expect(await run(['--cutover'], { ...fixture.deps, ask: async () => 'yes' })).toBe(0);
    }
    expect(legacyMigrationState(home).state).toBe('moved');
    expect(fs.readFileSync(fixture.legacy.vault)).toEqual(before);
  });

  it('declining leaves migration pending and an unreadable receipt stops before a remote flow', async () => {
    const fixture = await rig();
    const before = snapshot(home);
    expect(await run(['--status', '--json'], fixture.deps)).toBe(3);
    expect(snapshot(home)).toEqual(before);
    expect(await run([...flags.filter(flag => flag !== '--cutover'), '--no-cutover'], fixture.deps)).toBe(2);
    expect(readCutoverState(home).migrations).toBeUndefined();
    expect(errors.join('\n')).toContain('myco setup --cutover');
    fs.writeFileSync(path.join(home, 'member', 'cutover.json'), '{', { mode: 0o600 });
    fixture.calls.length = 0;
    const unavailable = snapshot(home);
    expect(await run(flags, fixture.deps)).toBe(2);
    expect(fixture.calls).toEqual([]);
    expect(snapshot(home)).toEqual(unavailable);
  });

  it('signs in with agent provisioning deferred before previewing cutover, without executing 1.x', async () => {
    const fixture = await rig();
    const membership = readDeploymentMembership(LEGACY_URLS[0], home)!;
    fs.unlinkSync(deploymentPath(LEGACY_URLS[0], home));
    const sentinel = path.join(root, 'executed-legacy');
    fs.writeFileSync(fixture.legacy.binary, `#!/bin/sh\ntouch '${sentinel}'\n`, { mode: 0o755 });
    fs.chmodSync(fixture.legacy.binary, 0o755);
    let signedIn = false;
    const deps = { ...fixture.deps, login: async (_args: readonly string[], loginDeps?: Parameters<typeof login>[1]) => {
      expect(loginDeps?.provision).toBe('defer');
      writeDeploymentMembership(membership, { mycoHome: home });
      signedIn = true;
      throw new DOMException('interrupted after sign-in', 'AbortError');
    }, planCutover: (...args: Parameters<typeof planCutover>) => { expect(signedIn).toBe(true); return planCutover(...args); } };
    const bytes = fs.readFileSync(fixture.legacy.vault);
    expect(await run(flags, deps)).toBe(2);
    expect(signedIn).toBe(true);
    expect(readCutoverState(home).migrations).toBeUndefined();
    expect(await run(['--yes'], deps)).toBe(0);
    expect(fs.existsSync(sentinel)).toBe(false);
    expect(fs.readFileSync(fixture.legacy.vault)).toEqual(bytes);
  });

  it('creates a native Deployment with G before conducting the legacy move', async () => {
    const fixture = await rig();
    const address = 'http://127.0.0.1:8787';
    const owner = ownerDeployment(root, home, 'local', address);
    closers.unshift(owner.close);
    const deps = { ...fixture.deps, ...owner.deps, stdout: (line: string) => lines.push(line), stderr: (line: string) => errors.push(line), sleep: async () => {} };
    const bytes = fs.readFileSync(fixture.legacy.vault);
    expect({ code: await run(['--create', 'local', '--serve', 'service', '--default', '--cutover', ...fixture.legacy.projects.flatMap(p => ['--route', `${p.id}=${address}`]), '--no-agents', '--no-runner', '--yes'], deps), errors }).toEqual({ code: 0, errors: [] });
    expect(legacyMigrationState(home).state).toBe('moved');
    expect(readRegistryEntry(fixture.legacy.projects[0]!.root, home)?.serverUrl).toBe(address);
    expect(fs.readFileSync(fixture.legacy.vault)).toEqual(bytes);
  });

  for (const noAgents of [true, false]) it(`${noAgents ? 'respects declined' : 'conducts retained'} agent provisioning during legacy handover`, async () => {
    const fixture = await rig({ agents: ['claude-code', 'codex'] });
    let provisioned = 0;
    const deps = { ...fixture.deps, cutoverDeps: { ...fixture.deps.cutoverDeps, onCheckpoint: (boundary: string) => { if (boundary.startsWith('action:3:')) provisioned++; } } };
    expect({ code: await run(noAgents ? flags : flags.filter(flag => flag !== '--no-agents'), deps), errors }).toEqual({ code: 0, errors: [] });
    expect(provisioned).toBe(noAgents ? 0 : 2);
    expect(legacyMigrationState(home).state).toBe('moved');
  });

  it('refuses source changes between consent and execution at the lease', async () => {
    const fixture = await rig();
    const mutate = () => {
      const db = new Database(fixture.legacy.vault);
      try { db.run("UPDATE spores SET content = content || ' changed'"); } finally { db.close(); }
    };
    expect(await run(flags, { ...fixture.deps, runCutover: async (plan, deps) => { mutate(); return runCutover(plan, deps); } })).toBe(2);
    expect(errors.join('\n')).toContain('changed after the preview');
    expect(fixture.calls.filter(call => call.route === '/events')).toEqual([]);
    expect(readCutoverState(home).migrations).toBeUndefined();
  });

  for (const interrupt of [false, true]) it(`moves final 1.4 capture during handover without reasking${interrupt ? ' across interruption' : ''}`, async () => {
    const fixture = await rig();
    let written: ReturnType<typeof fs.readFileSync> | undefined;
    let interrupted = false;
    let beforeConsent: string | undefined;
    const deps = { ...fixture.deps, cutoverDeps: { ...fixture.deps.cutoverDeps,
      stopDaemon: async () => {
        if (!written) {
          beforeConsent = readSetupFile(home).consented.cutover;
          const db = new Database(fixture.legacy.vault);
          try { db.run("INSERT INTO sessions (id, agent, project_root, project_id, started_at, ended_at, status, created_at) SELECT 'final_capture', agent, project_root, project_id, started_at, ended_at, status, created_at FROM sessions LIMIT 1"); } finally { db.close(); }
          written = fs.readFileSync(fixture.legacy.vault);
          expect(legacyMigrationState(home).state).not.toBe('changed');
        }
        return 'none' as const;
      },
      onCheckpoint: (boundary: string) => { if (interrupt && !interrupted && boundary.startsWith('stopped-source:') && written) { interrupted = true; throw new Error('interrupted before consent promotion'); } },
    } };
    expect({ code: await run(flags, deps), errors }).toMatchObject({ code: interrupt ? 2 : 0 });
    expect(legacyMigrationState(home).state).toBe(interrupt ? 'handover-pending' : 'moved');
    expect(await run(['--yes'], { ...deps, ask: async () => { throw new Error('must not ask again'); } })).toBe(0);
    expect(readSetupFile(home).consented.cutover).not.toBe(beforeConsent);
    expect(readSetupFile(home).consented.cutover).toBe(planFingerprint(cutoverConsentPlan(planCutover(home, { dryRun: true, requireSourceMatch: true, homeDir: fixture.legacy.home }, { ...fixture.deps.cutoverDeps, agents: () => [] }))));
    expect(lines.join('\n')).toContain('1.4 captured 1 more session before it stopped; they moved too');
    expect(readCutoverState(home).migrations![fixture.legacy.vault]!.digest).toBe(readVaultContent(fixture.legacy.vault).digest);
    expect(fs.readFileSync(fixture.legacy.vault).toString('base64')).toBe(written!.toString('base64'));
    const accepted = fixture.calls.filter(call => call.route === '/events').length;
    expect(await run(['--yes'], fixture.deps)).toBe(0);
    expect(fixture.calls.filter(call => call.route === '/events')).toHaveLength(accepted);
  });

  it('resumes consent after capture grows across two stop actions', async () => {
    const fixture = await rig();
    let captures = 0;
    let interrupted = false;
    const capture = () => {
      const db = new Database(fixture.legacy.vault);
      try { db.run("INSERT INTO sessions (id, agent, project_root, project_id, started_at, ended_at, status, created_at) SELECT ?, agent, project_root, project_id, started_at, ended_at, status, created_at FROM sessions LIMIT 1", [`final_${++captures}`]); } finally { db.close(); }
    };
    const deps = { ...fixture.deps, cutoverDeps: { ...fixture.deps.cutoverDeps,
      onAction: (outcome: string) => { if (outcome.startsWith('unit ') && captures === 0) capture(); },
      stopDaemon: async () => { if (captures === 1) capture(); return 'none' as const; },
      onCheckpoint: (boundary: string) => { if (captures === 2 && !interrupted && boundary.startsWith('stopped-source:')) { interrupted = true; throw new Error('interrupted after second stop'); } },
    } };
    expect(await run(flags, deps)).toBe(2);
    expect(captures).toBe(2);
    const bytes = fs.readFileSync(fixture.legacy.vault);
    expect(await run(['--yes'], { ...deps, ask: async () => { throw new Error('must not ask again'); } })).toBe(0);
    expect(lines.join('\n')).toContain('1.4 captured 2 more sessions before it stopped; they moved too');
    expect(fs.readFileSync(fixture.legacy.vault)).toEqual(bytes);
  });

  it('pins the stopped source through the copy boundary', async () => {
    const fixture = await rig();
    let changed = false;
    const deps = { ...fixture.deps, cutoverDeps: { ...fixture.deps.cutoverDeps, onCheckpoint: (boundary: string) => {
      if (boundary === 'quiescent' && !changed) {
        changed = true;
        const db = new Database(fixture.legacy.vault);
        try { db.run("UPDATE spores SET content = 'capture after the stopped-source receipt'"); } finally { db.close(); }
      }
    } } };
    expect(await run(flags, deps)).toBe(2);
    expect(errors.join('\n')).toContain('changed after the stop');
    expect(fixture.calls.filter(call => call.route === '/events' || call.route === '/spores/save')).toEqual([]);
    expect(legacyMigrationState(home).state).toBe('partial');
    const bytes = fs.readFileSync(fixture.legacy.vault);
    expect(await run(['--yes'], fixture.deps)).toBe(2);
    expect(errors.join('\n')).toContain('changed plans require fresh consent');
    expect(fs.readFileSync(fixture.legacy.vault)).toEqual(bytes);
  });

  it('refuses capture growth on resume when only an earlier run stopped 1.4', async () => {
    const fixture = await rig();
    const interrupted = { ...fixture.deps, cutoverDeps: { ...fixture.deps.cutoverDeps, onCheckpoint: (boundary: string) => {
      if (boundary === 'quiescent') throw new Error('interrupted after handover');
    } } };
    expect(await run(flags, interrupted)).toBe(2);
    expect(legacyMigrationState(home).state).toBe('partial');
    const plan = planCutover(home, { requireSourceMatch: true, homeDir: fixture.legacy.home }, { ...fixture.deps.cutoverDeps, agents: () => [] });
    expect(plan.handover.find(step => step.step === 6)?.actions).toEqual([]);
    const consent = readSetupFile(home).consented.cutover;
    fixture.calls.length = 0;
    errors = [];
    let written: ReturnType<typeof fs.readFileSync> | undefined;
    let reachedFinalSource = false;
    const resumed = { ...fixture.deps, cutoverDeps: { ...fixture.deps.cutoverDeps,
      stopDaemon: async () => { throw new Error('this run must stop no service'); },
      onCheckpoint: (boundary: string) => {
        if (boundary === 'destinations') {
          const db = new Database(fixture.legacy.vault);
          try { db.run("INSERT INTO sessions (id, agent, project_root, project_id, started_at, ended_at, status, created_at) SELECT 'capture_after_prior_stop', agent, project_root, project_id, started_at, ended_at, status, created_at FROM sessions LIMIT 1"); } finally { db.close(); }
          written = fs.readFileSync(fixture.legacy.vault);
        }
        if (boundary === 'stopped-source:final') reachedFinalSource = true;
      },
    } };
    expect(await run(['--yes'], resumed)).toBe(2);
    expect(written).toBeDefined();
    expect(errors.join('\n')).toContain('the stopped source changed after consent');
    expect(reachedFinalSource).toBe(false);
    expect(readSetupFile(home).consented.cutover).toBe(consent);
    expect(fixture.calls.filter(call => call.route === '/events' || call.route === '/spores/save')).toEqual([]);
    expect(fs.readFileSync(fixture.legacy.vault).toString('base64')).toBe(written!.toString('base64'));
  });

  it('reasks when stopped-source reconciliation matches the plan but consent belongs to an unrelated plan', async () => {
    const fixture = await rig();
    expect(await run(flags, { ...fixture.deps, cutoverDeps: { ...fixture.deps.cutoverDeps, onCheckpoint: (boundary: string) => {
      if (boundary === 'quiescent') throw new Error('interrupted before import');
    } } })).toBe(2);
    const reconciliation = readCutoverState(home).handover!.reconciliation!;
    const plan = planCutover(home, { requireSourceMatch: true, homeDir: fixture.legacy.home }, { ...fixture.deps.cutoverDeps, agents: () => [] });
    expect(planFingerprint(cutoverConsentPlan(plan))).toBe(planFingerprint(JSON.parse(reconciliation.after)));
    const file = readSetupFile(home);
    file.consented.cutover = planFingerprint({ url: 'https://unrelated.invalid' });
    expect(file.consented.cutover).not.toBe(planFingerprint(JSON.parse(reconciliation.before)));
    saveSetupFile(home, file);
    const bytes = fs.readFileSync(fixture.legacy.vault);
    fixture.calls.length = 0;
    errors = [];
    expect(await run(['--yes'], fixture.deps)).toBe(2);
    expect(errors.join('\n')).toContain('changed plans require fresh consent');
    expect(readSetupFile(home).consented.cutover).toBe(file.consented.cutover);
    expect(fixture.calls.filter(call => call.route === '/events' || call.route === '/spores/save')).toEqual([]);
    expect(fs.readFileSync(fixture.legacy.vault)).toEqual(bytes);
    expect(await run(['--yes'], { ...fixture.deps, ask: async () => 'yes' })).toBe(0);
  });

  for (const change of ['project', 'destination'] as const) it(`requires fresh consent for a changed ${change} after the stop`, async () => {
    const fixture = await rig({ secondMembership: change === 'destination' });
    const routes = fixture.legacy.projects.flatMap(p => ['--route', `${p.id}=${LEGACY_URLS[0]}`]);
    let changed = false;
    const deps = { ...fixture.deps, cutoverDeps: { ...fixture.deps.cutoverDeps, stopDaemon: async () => {
      if (!changed) {
        changed = true;
        if (change === 'project') {
          const db = new Database(fixture.legacy.vault);
          try { db.run("INSERT INTO sessions (id, agent, project_root, project_id, started_at, ended_at, status, created_at) SELECT 'new_project_session', agent, NULL, 'proj_new', started_at, ended_at, status, created_at FROM sessions LIMIT 1"); } finally { db.close(); }
        } else {
          const project = fixture.legacy.projects[1]!;
          const membership = readDeploymentMembership(LEGACY_URLS[1], home)!;
          writeRegistryEntry({ ...membership, version: 2, root: project.root, projectId: project.id }, { mycoHome: home });
        }
      }
      return 'none' as const;
    } } };
    expect(await run([...flags, ...routes], deps)).toBe(2);
    expect(errors.join('\n')).toContain('changed during handover');
    expect(errors.join('\n')).toContain('myco setup --cutover');
    expect(errors.join('\n')).not.toContain('Stop Myco 1.4');
    expect(fixture.calls.filter(call => call.route === '/events' || call.route === '/spores/save')).toEqual([]);
    expect(legacyMigrationState(home).state).not.toBe('changed');
    const bytes = fs.readFileSync(fixture.legacy.vault);
    errors = [];
    const choice = change === 'project' ? ['--skip', 'proj_new'] : ['--route', `${fixture.legacy.projects[1]!.id}=${LEGACY_URLS[1]}`];
    expect(await run(['--yes', ...choice], fixture.deps)).toBe(2);
    expect(errors.join('\n')).toContain('changed plans require fresh consent');
    expect(await run(['--yes'], { ...fixture.deps, ask: async () => 'yes' })).toBe(0);
    expect(fs.readFileSync(fixture.legacy.vault)).toEqual(bytes);
  });

  it('invalidates consent when a route changes, including with --yes', async () => {
    const fixture = await rig({ missing: true });
    const id = fixture.legacy.projects[1]!.id;
    let calls = 0;
    const deps = { ...fixture.deps, runCutover: async () => { calls++; return { ok: false }; } };
    expect(await run([...flags, '--route', `${id}=${LEGACY_URLS[0]}`], deps)).toBe(2);
    expect(calls).toBe(1);
    expect(await run(['--yes', '--route', `${id}=${LEGACY_URLS[1]}`], deps)).toBe(2);
    expect(calls).toBe(1);
    expect(errors.join('\n')).toContain('changed plans require fresh consent');
    expect(await run(['--yes'], { ...deps, ask: async () => 'yes' })).toBe(2);
    expect(calls).toBe(2);
  });

  it('requires fresh consent when the capture agent set changes before handover', async () => {
    const fixture = await rig({ agents: ['claude-code'] });
    let executions = 0;
    const deps = { ...fixture.deps, runCutover: async () => { executions++; return { ok: false }; } };
    expect(await run(flags.filter(flag => flag !== '--no-agents'), deps)).toBe(2);
    expect(executions).toBe(1);
    expect(await run(['--yes'], { ...deps, agents: () => ['claude-code', 'codex'] })).toBe(2);
    expect(executions).toBe(1);
    expect(errors.join('\n')).toContain('changed plans require fresh consent');
  });

  it('merges repeated routing choices and refuses conflicting or invalid flags', () => {
    const choices = parseSetupOptions(['--cutover', '--route', 'one=https://a.invalid/', '--route', 'two=https://b.invalid', '--skip', 'three', '--skip', 'four']);
    expect(choices.answers).toMatchObject({ cutover: true, routes: { one: 'https://a.invalid', two: 'https://b.invalid' }, skips: ['three', 'four'] });
    for (const args of [
      ['--cutover', '--no-cutover'], ['--route', 'one=https://a.invalid', '--skip', 'one'],
      ['--route', 'one=https://a.invalid', '--route', 'one=https://b.invalid'],
      ['--route', 'one=https://a.invalid/path'], ['--route', 'one=https://name:password@a.invalid'],
    ]) expect(() => parseSetupOptions(args)).toThrow();
  });

  it('resumes across SIGKILL at every observed cutover mutation boundary and preserves 1.4 data', async () => {
    const initial = await rig({ multi: true, agents: ['claude-code', 'codex'] });
    expect(await run(flags.filter(flag => flag !== '--no-agents'), initial.deps)).toBe(0);
    const boundaries = ['consent', ...new Set(initial.checkpoints)];
    expect(boundaries).toContain('destinations');
    expect(boundaries).toContain('handover');
    expect(boundaries).toContain('stopped-source:0');
    expect(boundaries).toContain('stopped-source:1');
    expect(boundaries).toContain('stopped-source:final');
    expect(boundaries).toContain('copy');
    expect(boundaries).toContain('action:3:0');
    expect(boundaries).toContain('action:3:1');
    expect(boundaries).toContain('vault:proj_legacy_a');
    expect(boundaries).toContain('transcripts:proj_legacy_b');
    const repo = fileURLToPath(new globalThis.URL('../../', import.meta.url));
    const args = ['test', '--preload', path.join(repo, 'tests/setup/sandbox-preload.ts'), '--tsconfig-override', path.join(repo, 'tsconfig.json'), path.join(repo, 'tests/setup/fixtures/legacy_journey_interruption_test.ts')];
    for (const growth of [false, true]) for (const [index, boundary] of boundaries.entries()) {
      const childRoot = path.join(root, `kill-${growth}-${index}`);
      fs.mkdirSync(childRoot);
      const env = sandboxChildEnv(childRoot, { MYCO_SETUP_FIXTURE_ROOT: childRoot, ...(growth ? { MYCO_SETUP_GROW: '1' } : {}) });
      const child = spawn(process.execPath, args, { env: { ...env, MYCO_SETUP_STOP_AFTER: boundary }, cwd: childRoot, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      const capture = (chunk: Buffer) => { output += chunk.toString(); };
      child.stdout.on('data', capture); child.stderr.on('data', capture);
      const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
      try {
        const deadline = Date.now() + 15_000;
        while (!fs.existsSync(path.join(childRoot, 'reached')) && child.exitCode === null && Date.now() < deadline) await Bun.sleep(20);
        expect({ boundary, reached: fs.existsSync(path.join(childRoot, 'reached')), output }).toMatchObject({ reached: true });
      } finally { if (child.exitCode === null) child.kill('SIGKILL'); await exited; }
      const fixture = JSON.parse(fs.readFileSync(path.join(childRoot, 'legacy-fixture.json'), 'utf8')) as ReturnType<typeof legacyFixtureHome>;
      expect(fs.readFileSync(fixture.vault)).toEqual(fs.readFileSync(path.join(childRoot, 'vault-before')));
      const result = Bun.spawnSync([process.execPath, ...args], { env: { ...env, MYCO_SETUP_RESUME: '1' }, cwd: childRoot, stdout: 'pipe', stderr: 'pipe' });
      expect({ boundary, code: result.exitCode, output: result.stderr.toString() }).toMatchObject({ code: 0 });
      expect(fs.readFileSync(fixture.vault)).toEqual(fs.readFileSync(path.join(childRoot, 'vault-before')));
      expect(fs.readFileSync(path.join(fixture.mycoHome, 'unmanaged.txt'), 'utf8')).toBe('Keep this user file byte for byte.\n');
      const resumed = JSON.parse(fs.readFileSync(path.join(childRoot, 'resumed'), 'utf8')) as { calls: { route: string; url: string }[] };
      if (boundary === 'vault:proj_legacy_b' || boundary.startsWith('settings:')) expect(resumed.calls.filter(call => call.route === '/events' || call.route === '/spores/save')).toEqual([]);
    }
  }, 180_000);

  it('resumes after an exception at every observed cutover mutation boundary without duplicated imports', async () => {
    const captureFlags = flags.filter(flag => flag !== '--no-agents');
    const initial = await rig({ multi: true, agents: ['claude-code', 'codex'] });
    expect(await run(captureFlags, initial.deps)).toBe(0);
    const accepted = initial.calls.filter(call => call.route === '/events' || call.route === '/spores/save').length;
    for (const [index, boundary] of [...new Set(initial.checkpoints)].entries()) {
      const fixture = await legacyJourney(path.join(root, `exception-${index}`), { multi: true, agents: ['claude-code', 'codex'] });
      const bytes = fs.readFileSync(fixture.legacy.vault);
      let interrupted = false;
      const deps = { ...fixture.deps, stdout: () => {}, stderr: () => {}, cutoverDeps: { ...fixture.deps.cutoverDeps, onCheckpoint: (at: string) => {
        if (!interrupted && at === boundary) { interrupted = true; throw new DOMException(`interrupted at ${at}`, 'AbortError'); }
      } } };
      try {
        expect({ boundary, code: await run(captureFlags, deps), interrupted }).toMatchObject({ code: 2, interrupted: true });
        expect(fs.readFileSync(fixture.legacy.vault)).toEqual(bytes);
        expect({ boundary, code: await run(['--yes'], deps) }).toMatchObject({ code: 0 });
        expect(legacyMigrationState(fixture.legacy.mycoHome).state).toBe('moved');
        expect(fixture.calls.filter(call => call.route === '/events' || call.route === '/spores/save')).toHaveLength(accepted);
        expect(fs.readFileSync(fixture.legacy.vault)).toEqual(bytes);
      } finally { await fixture.close(); }
    }
  }, 60_000);
});

describe('new owner journeys (a) and (b)', () => {
  const affirmative = async (question: string) => question.includes('already have') ? 'no' : 'yes';
  for (const target of ['cloudflare', 'local'] as const) {
    const address = target === 'local' ? 'http://127.0.0.1:8787' : HOSTED_URL;
    const flags = () => ['--create', target, ...(target === 'local' ? ['--port', '8787', '--serve', 'service'] : ['--account-id', ACCOUNT]), '--new', 'Owner project', '--no-agents', '--no-runner', '--yes'];
    it(`creates ${target}, links through fake GitHub OAuth, signs in and connects once`, async () => {
      const server = ownerDeployment(root, home, target, address);
      closers.push(server.close);
      const deps = { ...base(), ...server.deps, sleep: async () => {}, loginDeps: { machineId: `owner-${target}` } };
      expect(await run(flags(), deps)).toBe(0);
      expect(errors).toEqual([]);
      const membership = readDeploymentMembership(address, home);
      expect(membership?.memberId).toBeTruthy();
      expect(readRegistryEntry(project, home)?.serverUrl).toBe(address);
      expect(server.links).toHaveLength(1);
      expect(server.github.calls.filter(call => call.url.includes('/conversions'))).toHaveLength(1);
      expect(server.github.calls.filter(call => call.url.includes('/access_token'))).toHaveLength(1);
      expect(server.calls.filter(route => route === '/auth/device/start')).toHaveLength(1);
      expect(server.commands.filter(command => command === 'auth token --json')).toHaveLength(target === 'cloudflare' ? 1 : 0);
      expect(lines.filter(line => line.startsWith('Setup connected'))).toHaveLength(1);
      expect(lines.filter(line => line.includes('/link#'))).toHaveLength(1);
      expect(lines.join('\n')).toContain('works once; keep it private');
      expect(errors.join('\n')).not.toContain('/link#');
      const saved = fs.readFileSync(setupFilePath(home), 'utf8');
      expect(saved).not.toContain('/link#');
      expect(saved).not.toContain(SETUP_APP.clientSecret);
      expect(saved).not.toContain('complete');
      const created = server.commands.filter(command => command.startsWith('d1 create') || command.startsWith('deploy ')).length;
      expect(await run([], deps)).toBe(0);
      expect(server.commands.filter(command => command.startsWith('d1 create') || command.startsWith('deploy '))).toHaveLength(created);
      expect(server.links).toHaveLength(1);
      expect(server.calls.filter(route => route === '/auth/device/start')).toHaveLength(1);
      expect(readDeploymentMembership(address, home)?.token).toBe(membership?.token);
      const before = snapshot(root);
      const commandCount = server.commands.length;
      expect(await run(['--status', '--json'], { ...deps, fetch: fakeFetch(async () => { throw new Error('status network'); }) })).toBe(0);
      expect(snapshot(root)).toEqual(before);
      expect(server.commands).toHaveLength(commandCount);
      fs.unlinkSync(setupFilePath(home));
      const withoutAnswers = snapshot(root);
      const beforeRemoteStatus = server.commands.length;
      expect(await run(['--status', '--json', '--create', target, '--check-remote'], deps)).toBe(0);
      const observed = JSON.parse(lines.at(-1)!).observations as Awaited<ReturnType<typeof observeSetup>>;
      for (const id of ['journey', 'deployment.health', 'deployment.signin', 'machine.signin', 'project']) expect(observed.find(fact => fact.id === id)?.state).toBe('complete');
      expect(observed.find(fact => fact.id === 'deployment.owner')).toMatchObject(target === 'cloudflare' ? { state: 'incomplete', informational: true } : { state: 'complete' });
      expect(server.commands).toHaveLength(beforeRemoteStatus);
      expect(snapshot(root)).toEqual(withoutAnswers);
      expect(await run(['--status', '--create', target], deps)).toBe(0);
      expect(lines.join('\n')).toContain('This machine manages this Deployment.');
      expect(lines.join('\n')).not.toContain('This machine runs work for this Deployment.');
      expect(await run(['--status', '--json', '--check-remote'], deps)).toBe(0);
      const discovered = JSON.parse(lines.at(-1)!).observations as Awaited<ReturnType<typeof observeSetup>>;
      expect(discovered.find(fact => fact.id === 'deployment.create' && fact.target === target)?.state).toBe('complete');
      expect(discovered.find(fact => fact.id === 'deployment.owner' && fact.target === target)?.state).toBe(target === 'cloudflare' ? 'incomplete' : 'complete');
      expect(snapshot(root)).toEqual(withoutAnswers);
      expect(await run(['--create', target, ...(target === 'local' ? ['--serve', 'service'] : []), '--yes', '--no-runner', '--no-agents'], deps)).toBe(0);
      expect(server.github.calls.filter(call => call.url.includes('/conversions'))).toHaveLength(1);
      expect(server.links).toHaveLength(1);
      const stale = readSetupFile(home);
      stale.answers.url = 'https://stale.invalid';
      saveSetupFile(home, stale);
      expect(await run(['--status', '--create', target, '--json', '--check-remote'], deps)).toBe(0);
      const current = JSON.parse(lines.at(-1)!).observations as Awaited<ReturnType<typeof observeSetup>>;
      expect(current.find(fact => fact.id === 'machine.signin')?.scope).toBe(address);
      expect(current.find(fact => fact.id === 'deployment.health')?.scope).toBe(address);
      expect(current.find(fact => fact.id === 'journey')?.deployment).toBe(address);
      expect(server.github.calls.filter(call => call.url.includes('/conversions'))).toHaveLength(1);
    });

    for (const boundary of ['create', 'conversion', 'signin', 'owner-mint', 'owner-link', 'machine', 'project'] as const) {
      it(`resumes ${target} after interruption at ${boundary} without duplicated resources or lost state`, async () => {
        const server = ownerDeployment(root, home, target, address);
        closers.push(server.close);
        let interrupted = false;
        const interrupt = () => { if (!interrupted) { interrupted = true; throw new DOMException(`interrupted after ${boundary}`, 'AbortError'); } };
        const deps: SetupDeps = { ...base(), ...server.deps, sleep: async () => {}, ask: affirmative, loginDeps: { machineId: `interrupted-${target}` },
          createCloudflare: async options => { const result = await createCloudflareDeployment(options); if (boundary === 'create') interrupt(); return result; },
          registerApp: async options => {
            if (boundary === 'create' && target === 'local') interrupt();
            if (boundary === 'conversion' && !interrupted) {
              const savedRunner = options.runner;
              if (target === 'cloudflare') options = { ...options, runner: { run: async (command, args, opts) => { if (args.includes('bulk')) interrupt(); return savedRunner!.run(command, args, opts); } } };
            }
            const result = await registerGitHubApp(options);
            if (boundary === 'signin') interrupt();
            return result;
          },
          prepareLocal: async (localHome, plan, localDeps) => { const result = await prepareLocal(localHome, plan, localDeps); if (boundary === 'owner-mint') interrupt(); return result; },
          openUrl: async url => {
            if (new globalThis.URL(url).hash && boundary === 'owner-mint' && target === 'cloudflare') interrupt();
            await server.openUrl(url);
            if (new globalThis.URL(url).hash && boundary === 'owner-link') interrupt();
          },
          login: async (args, loginDeps) => { const result = await login(args, loginDeps); if (boundary === 'machine') interrupt(); return result; },
          join: async (args, joinDeps) => { const result = await runJoin(args, joinDeps); if (boundary === 'project') interrupt(); return result; },
        };
        if (boundary === 'conversion' && target === 'local') {
          const original = deps.registerApp!;
          deps.registerApp = async options => {
            if (!interrupted) { await writeSignInPending(options.target, await convertManifestCode('setup-conversion', server.github.registrationFetch), options.url); interrupt(); }
            return original(options);
          };
        }
        expect(await run(flags(), deps)).toBe(2);
        expect(interrupted).toBe(true);
        const keys = target === 'local' ? readLocalSecrets(peekLocalPaths(home)) : null;
        const databaseId = peekDeploymentRecord(home)?.databaseId;
        const resumed = await run([], deps);
        expect({ code: resumed, errors }).toEqual({ code: 0, errors: expect.any(Array) });
        expect(readDeploymentMembership(address, home)).not.toBeNull();
        expect(readRegistryEntry(project, home)).not.toBeNull();
        if (target === 'local') {
          const after = readLocalSecrets(peekLocalPaths(home));
          for (const key of ['SESSION_SECRET', 'SECRET_WRAP_KEY'] as const) expect(after[key]).toBe(keys![key]);
        } else expect(peekDeploymentRecord(home)?.databaseId).toBe(databaseId);
        expect(server.commands.filter(command => command.startsWith('d1 create '))).toHaveLength(target === 'local' ? 0 : 1);
        expect(server.github.calls.filter(call => call.url.includes('/conversions')).length).toBeLessThanOrEqual(1);
        expect(server.calls.filter(route => route === '/auth/device/start')).toHaveLength(1);
        expect(await run([], deps)).toBe(0);
      });
    }
  }

  it('offers the custom domain before registration, selects the one account and asks before Cloudflare login', async () => {
    const address = 'https://myco.custom.invalid';
    const server = ownerDeployment(root, home, 'cloudflare', address);
    closers.push(server.close);
    server.signOutWrangler();
    const questions: string[] = [];
    const deps: SetupDeps = { ...base(), ...server.deps, sleep: async () => {}, ask: async question => {
      questions.push(question);
      if (question.includes('already have')) return 'no';
      if (question.startsWith('Choose the address')) return '2';
      if (question.startsWith('What is the custom domain')) return address;
      return 'yes';
    } };
    expect(await run(['--create', 'cloudflare', '--new', 'Custom', '--no-agents', '--no-runner'], deps)).toBe(0);
    expect(errors).toEqual([]);
    expect(questions.findIndex(question => question.startsWith('Choose the address'))).toBeLessThan(questions.findIndex(question => question.startsWith('Do you already have')));
    expect(lines.join('\n')).toContain('Cloudflare zone security rules');
    expect(lines.join('\n')).toContain('Myco (myco.custom.invalid)');
    expect(server.commands.filter(command => command === 'login')).toHaveLength(1);
    expect(readSetupFile(home).answers.accountId).toBe(ACCOUNT);
    expect(peekDeploymentRecord(home)?.url).toBe(address);
  });

  it('requires creation consent despite saved answers, and re-asks for a changed app plan even with --yes', async () => {
    const server = ownerDeployment(root, home, 'cloudflare');
    closers.push(server.close);
    const file = readSetupFile(home);
    saveSetupFile(home, { ...file, answers: { role: 'create', target: 'cloudflare', accountId: ACCOUNT, addressChoice: 'workers.dev', runWork: false, noAgents: true } });
    expect(await run([], { ...base(), ...server.deps })).toBe(2);
    expect(errors.at(-1)).toContain('pass --yes');
    expect(server.commands.filter(command => command.startsWith('d1 create'))).toEqual([]);
    let calls = 0;
    const deps: SetupDeps = { ...base(), ...server.deps, registerApp: async () => { calls++; throw new Error('registration interrupted'); } };
    expect(await run(['--yes', '--app-name', 'First app'], deps)).toBe(2);
    expect(calls).toBe(1);
    expect(await run(['--yes', '--app-name', 'Changed app'], deps)).toBe(2);
    expect(calls).toBe(1);
    expect(errors.at(-1)).toContain('changed plans require fresh consent');
    expect(lines.join('\n')).toContain('This plan changed; its previous consent no longer applies.');
  });

  for (const [flags, refusal] of [
    [[], 'Choose 1, 2 or 3; run myco setup --help for the available choices.'],
    [['--create', 'local', '--port', '8787'], 'Choose 1 or 2; pass --serve service|terminal.'],
    [['--create', 'cloudflare', '--account-id', ACCOUNT], 'Choose 1 or 2; pass --url https://<host> for a custom domain.'],
  ] as const) it(`pins invalid prompted choice ${flags.join(' ') || 'role'}`, async () => {
    const server = ownerDeployment(root, home, flags.some(flag => flag === 'local') ? 'local' : 'cloudflare');
    closers.push(server.close);
    expect(await run([...flags], { ...base(), ...server.deps, ask: async () => 'invalid' })).toBe(2);
    expect(errors.at(-1)).toBe(`myco setup: ${refusal}`);
  });

  it('pins an invalid hosting target choice', async () => {
    expect(await run([], { ...base(), ask: async question => question.startsWith('What should') ? '1' : 'invalid' })).toBe(2);
    expect(errors.at(-1)).toBe('myco setup: Choose 1 or 2; pass --create cloudflare or --create local.');
  });

  it('pins an account choice outside the listed Cloudflare accounts', async () => {
    const server = ownerDeployment(root, home, 'cloudflare');
    closers.push(server.close);
    const runner = { run: async (...args: Parameters<typeof server.runner.run>) => {
      const result = await server.runner.run(...args);
      return args[1].includes('whoami') ? { ...result, stdout: `${result.stdout}\n│ Other │ ${'b'.repeat(32)} │` } : result;
    } };
    expect(await run(['--create', 'cloudflare'], { ...base(), ...server.deps, cloudflare: { ...server.deps.cloudflare, runner }, ask: async () => 'c'.repeat(32) })).toBe(2);
    expect(errors.at(-1)).toBe('myco setup: Choose a listed Cloudflare account with --account-id <id>.');
    expect(server.commands.some(command => command.startsWith('d1 create'))).toBe(false);
  });

  it('pins malformed Cloudflare records before any provider command', async () => {
    writeDeploymentRecord({ accountId: ACCOUNT, workerName: '', databaseName: 'myco-server', bucketName: 'myco-server-blobs', versionId: null, deployedAt: 'then' }, home);
    expect(await run(['--create', 'cloudflare', '--yes'], base())).toBe(2);
    expect(errors.at(-1)).toBe(`myco setup: deployment.create (${home}) unavailable: Cloudflare record is malformed; restore it before running myco setup again. Restore access, then run myco setup again.`);
  });

  it('pins unavailable Cloudflare owner state before requesting credentials', async () => {
    await expect(cloudflareOwnerLinked({ accountId: ACCOUNT, mycoHome: home })).rejects.toThrow('Cloudflare owner state unavailable; check myco server status --target cloudflare for the selected account.');
  });

  it('pins the address move recovery without replacing sign-in', async () => {
    const server = ownerDeployment(root, home, 'cloudflare');
    closers.push(server.close);
    await createCloudflareDeployment({ ...server.deps.cloudflare, mycoHome: home, accountId: ACCOUNT });
    const before = peekDeploymentRecord(home);
    const deps = { ...base(), ...server.deps, sleep: async () => {} };
    expect(await run(['--create', 'cloudflare', '--account-id', ACCOUNT, '--url', 'https://new.invalid', '--yes', '--new', 'Kept address', '--no-agents', '--no-runner'], deps)).toBe(2);
    expect(errors.at(-1)).toBe(`myco setup: This Deployment's address is ${HOSTED_URL}; rerun myco setup without --url, or move it with myco server create --target cloudflare --account-id ${ACCOUNT} --url <new>, then register sign-in again.`);
    expect(peekDeploymentRecord(home)).toEqual(before);
    expect(server.github.calls).toHaveLength(0);
    expect(readSetupFile(home).answers.customUrl).toBeUndefined();
    expect(await run(['--yes'], deps)).toBe(0);
    expect(peekDeploymentRecord(home)?.url).toBe(HOSTED_URL);
    expect(server.commands.filter(command => command.startsWith('deploy '))).toHaveLength(1);
  });

  it('refuses a behind native schema before creation consent', async () => {
    const server = ownerDeployment(root, home, 'local', 'http://127.0.0.1:8787');
    closers.push(server.close);
    const paths = peekLocalPaths(home);
    createLocalDeployment(DEFAULT_LOCAL_RECORD, { library: null, vec0: null }, paths);
    const db = new Database(paths.databasePath);
    try { db.query("UPDATE schema_meta SET value = ? WHERE key = 'version'").run(String(SERVER_SCHEMA_VERSION - 1)); } finally { db.close(); }
    const before = snapshot(paths.root);
    expect(await run(['--create', 'local', '--serve', 'service', '--yes'], { ...base(), ...server.deps })).toBe(2);
    expect(errors.at(-1)).toBe('myco setup: native Deployment data needs update; run myco server update --target local before setup');
    expect(lines.join('\n')).not.toContain('Create your Myco on this machine?');
    expect(snapshot(paths.root)).toEqual(before);
  });

  it('refuses incompatible prompted choices before saving them', async () => {
    expect(await run(['--port', '8787'], { ...base(), ask: async () => '2' })).toBe(2);
    expect(errors.at(-1)).toBe('myco setup: Creation options require --create cloudflare or --create local.');
    expect(fs.existsSync(setupFilePath(home))).toBe(false);
    expect(readSetupFile(home).answers).toEqual({});
  });

  it('accepts Enter for the advertised native port default', async () => {
    const server = ownerDeployment(root, home, 'local', 'http://127.0.0.1:8787');
    closers.push(server.close);
    const deps = { ...base(), ...server.deps, sleep: async () => {}, ask: async (question: string) => question.startsWith('Only this machine can reach it.') ? '' : question.includes('already have') ? 'no' : 'yes' };
    expect(await run(['--create', 'local', '--serve', 'service', '--new', 'Default port', '--no-agents', '--no-runner'], deps)).toBe(0);
    expect(readSetupFile(home).answers.port).toBe(8787);
    expect(errors).toEqual([]);
  });

  it('names --port when the native port question has no terminal', async () => {
    const server = ownerDeployment(root, home, 'local', 'http://127.0.0.1:8787');
    closers.push(server.close);
    expect(await run(['--create', 'local', '--serve', 'service'], { ...base(), ...server.deps })).toBe(2);
    expect(errors.at(-1)).toBe('myco setup: no terminal to ask "Only this machine can reach it. Port [8787]:"; pass --port <n>');
    expect(fs.existsSync(peekLocalPaths(home).databasePath)).toBe(false);
  });

  for (const answer of ['', 'maybe']) it(`local runner choice refuses ${JSON.stringify(answer)} with no default`, async () => {
    const server = ownerDeployment(root, home, 'local', 'http://127.0.0.1:8787');
    closers.push(server.close);
    const deps = { ...base(), ...server.deps, sleep: async () => {}, ask: async () => answer };
    expect(await run(['--create', 'local', '--serve', 'service', '--yes', '--new', 'Local', '--no-agents'], deps)).toBe(2);
    expect(errors.at(-1)).toBe(answer === '' ? 'myco setup: an answer is required; pass --run-work or --no-runner' : 'myco setup: Answer yes or no; pass --run-work or --no-runner.');
    expect(readSetupFile(home).answers.runWork).toBeUndefined();
    expect(await run(['--no-runner'], deps)).toBe(0);
  });

  for (const target of ['cloudflare', 'local'] as const) it(`offers an existing GitHub app recovery command for ${target}`, async () => {
    const address = target === 'local' ? 'http://127.0.0.1:8787' : HOSTED_URL;
    const server = ownerDeployment(root, home, target, address);
    closers.push(server.close);
    const deps = { ...base(), ...server.deps, ask: async () => 'yes' };
    expect(await run(['--create', target, ...(target === 'local' ? ['--port', '8787', '--serve', 'service'] : ['--account-id', ACCOUNT, '--url', HOSTED_URL]), '--no-agents', '--no-runner'], deps)).toBe(2);
    expect(errors.at(-1)).toBe(`myco setup: ${target === 'local' ? 'Run myco server create --target local first. ' : ''}Use myco server github-app --target ${target} --url ${address} --existing --client-id <id> --client-secret-stdin with its regenerated secret, then run myco setup again.`);
    expect(server.github.calls).toHaveLength(0);
  });

  it('requires fresh consent for a changed URL after partial creation with --yes and no TTY', async () => {
    const server = ownerDeployment(root, home, 'cloudflare');
    closers.push(server.close);
    let interrupted = false;
    const runner = { run: async (...args: Parameters<typeof server.runner.run>) => {
      if (!interrupted && args[1].includes('deploy')) { interrupted = true; throw new Error('interrupted before deploy'); }
      return server.runner.run(...args);
    } };
    const deps = { ...base(), ...server.deps, cloudflare: { ...server.deps.cloudflare, runner } };
    expect(await run(['--create', 'cloudflare', '--account-id', ACCOUNT, '--yes'], deps)).toBe(2);
    expect(peekDeploymentRecord(home)).toMatchObject({ databaseId: expect.any(String), versionId: null });
    expect(readSetupFile(home).consented.create).toBeTruthy();
    server.commands.splice(0);
    expect(await run(['--url', 'https://changed.invalid', '--yes'], deps)).toBe(2);
    expect(errors.at(-1)).toContain('changed plans require fresh consent');
    expect(server.commands.filter(command => /\b(create|deploy)\b/.test(command))).toEqual([]);
  });

  for (const identity of ['account', 'step name'] as const) it(`requires fresh consent for a changed ${identity} before any record with --yes and no TTY`, async () => {
    const server = ownerDeployment(root, home, 'cloudflare');
    closers.push(server.close);
    let createCalls = 0;
    let changeName = false;
    const deps: SetupDeps = { ...base(), ...server.deps,
      planCloudflare: async options => {
        const plan = await planCloudflareDeployment(options);
        if (changeName) plan.steps[0].name += '-changed';
        return plan;
      },
      createCloudflare: async () => { createCalls++; throw new Error('interrupted after consent, before record'); },
    };
    expect(await run(['--create', 'cloudflare', '--account-id', ACCOUNT, '--yes'], deps)).toBe(2);
    expect(peekDeploymentRecord(home)).toBeNull();
    expect(readSetupFile(home).consented.create).toBeTruthy();
    server.commands.splice(0);
    changeName = identity === 'step name';
    expect(await run(identity === 'account' ? ['--account-id', 'b'.repeat(32), '--yes'] : ['--yes'], deps)).toBe(2);
    expect(errors.at(-1)).toContain('changed plans require fresh consent');
    expect(createCalls).toBe(1);
    expect(server.commands.filter(command => /\b(create|deploy)\b/.test(command))).toEqual([]);
    expect(peekDeploymentRecord(home)).toBeNull();
  });

  for (const boundary of ['vectorize create', 'deploy'] as const) for (const interactive of [false, true]) it(`resumes partial Cloudflare creation at ${boundary} with ${interactive ? 'interactive' : 'no-TTY'} consent`, async () => {
    const server = ownerDeployment(root, home, 'cloudflare');
    closers.push(server.close);
    let interrupted = false;
    const runner = { run: async (...args: Parameters<typeof server.runner.run>) => {
      if (!interrupted && args[1].slice(2).join(' ').startsWith(boundary)) { interrupted = true; throw new Error('mid-create interruption'); }
      return server.runner.run(...args);
    } };
    const questions: string[] = [];
    const deps = { ...base(), ...server.deps, cloudflare: { ...server.deps.cloudflare, runner }, sleep: async () => {},
      ask: async (question: string) => { questions.push(question); return interactive ? 'yes' : null; } };
    expect(await run(['--create', 'cloudflare', '--account-id', ACCOUNT, '--yes', '--new', 'Partial', '--no-agents', '--no-runner'], deps)).toBe(2);
    expect(peekDeploymentRecord(home)?.databaseId).toBeTruthy();
    expect(peekDeploymentRecord(home)?.versionId).toBeNull();
    const resumed = await run(['--yes'], deps);
    expect({ code: resumed, errors }).toMatchObject({ code: 0 });
    expect(server.commands.filter(command => command.startsWith('deploy '))).toHaveLength(1);
    expect(peekDeploymentRecord(home)).toMatchObject({ url: HOSTED_URL, versionId: expect.any(String) });
    expect(questions.some(question => question.startsWith('Approve this plan?'))).toBe(false);
    expect(lines.join('\n')).not.toContain('This plan changed');
  });

  for (const target of ['local', 'cloudflare'] as const) it(`resumes a ${target === 'local' ? 'native' : 'hosted'} pending registration even when its secrets are already configured`, async () => {
    const server = ownerDeployment(root, home, target, target === 'local' ? 'http://127.0.0.1:8787' : HOSTED_URL);
    closers.push(server.close);
    let registrations = 0;
    const deps: SetupDeps = { ...base(), ...server.deps, sleep: async () => {}, registerApp: async options => {
      registrations++;
      const result = await registerGitHubApp(options);
      if (registrations === 1) { await writeSignInPending(options.target, SETUP_APP, options.url); throw new Error('interrupted after secrets, before journal cleanup'); }
      return result;
    } };
    const flags = ['--create', target, ...(target === 'local' ? ['--serve', 'service'] : ['--account-id', ACCOUNT]), '--yes', '--new', 'Pending', '--no-agents', '--no-runner'];
    expect(await run(flags, deps)).toBe(2);
    if (target === 'local') expect(readLocalSecrets(peekLocalPaths(home)).GITHUB_CLIENT_ID).toBe(SETUP_APP.clientId);
    const pending = signInPendingPath(target === 'local' ? { kind: 'local', paths: peekLocalPaths(home) } : { kind: 'cloudflare', record: peekDeploymentRecord(home)!, mycoHome: home });
    expect(fs.existsSync(pending)).toBe(true);
    const result = await run(['--yes'], deps);
    expect({ code: result, errors }).toMatchObject({ code: 0 });
    expect(registrations).toBe(2);
    expect(fs.existsSync(pending)).toBe(false);
    expect(server.github.calls.filter(call => call.url.includes('/conversions'))).toHaveLength(1);
  });

  it('shows the private owner link only on stdout, never in setup.json or logs, when the opener is missing', async () => {
    const logs: string[] = [];
    const log = spyOn(console, 'log').mockImplementation((...args) => { logs.push(args.join(' ')); });
    closers.push(() => { log.mockRestore(); });
    const server = ownerDeployment(root, home, 'cloudflare');
    closers.push(server.close);
    const deps = { ...base(), ...server.deps, sleep: async () => {}, openUrl: async (url: string) => {
      if (!new globalThis.URL(url).hash) return server.openUrl(url);
      await server.openUrl(url);
      throw new Error('fixture missing opener');
    } };
    expect(await run(['--create', 'cloudflare', '--account-id', ACCOUNT, '--yes', '--new', 'Opener', '--no-agents', '--no-runner'], deps)).toBe(0);
    expect(lines.filter(line => line.includes('/link#'))).toHaveLength(1);
    expect(lines.join('\n')).toContain('works once; keep it private');
    expect(lines.join('\n')).toMatch(/Expires: \d{4}-/);
    expect(errors.join('\n')).not.toContain('/link#');
    expect(logs.join('\n')).not.toContain('/link#');
    expect(fs.readFileSync(setupFilePath(home), 'utf8')).not.toContain('/link#');
  });

  it('asks for each Cloudflare login occurrence instead of saving standing consent', async () => {
    const server = ownerDeployment(root, home, 'cloudflare');
    closers.push(server.close);
    const questions: string[] = [];
    const deps = { ...base(), ...server.deps, sleep: async () => {}, ask: async (question: string) => { questions.push(question); return 'yes'; } };
    expect(await run(['--create', 'cloudflare', '--account-id', ACCOUNT, '--yes', '--new', 'Login', '--no-agents', '--no-runner'], deps)).toBe(0);
    for (let occurrence = 0; occurrence < 2; occurrence++) {
      server.signOutWrangler();
      expect(await run([], deps)).toBe(0);
    }
    expect(questions.filter(question => question.startsWith('Sign in to Cloudflare'))).toHaveLength(2);
    expect(readSetupFile(home).consented['cloudflare.login']).toBeUndefined();
  });

  it('asks for each native service stop occurrence instead of saving standing consent', async () => {
    const server = ownerDeployment(root, home, 'local', 'http://127.0.0.1:8787');
    closers.push(server.close);
    const questions: string[] = [];
    const deps: SetupDeps = { ...base(), ...server.deps, sleep: async () => {}, ask: async question => { questions.push(question); return 'yes'; } };
    expect(await run(['--create', 'local', '--serve', 'service', '--yes', '--new', 'Stop', '--no-agents', '--no-runner'], deps)).toBe(0);
    server.platform.dispose();
    await writeSignInPending({ kind: 'local', paths: peekLocalPaths(home) }, SETUP_APP, 'http://127.0.0.1:8787');
    for (let occurrence = 0; occurrence < 2; occurrence++) {
      expect(await run([], { ...deps, registerApp: async () => { throw new Error('fixture registration still pending'); } })).toBe(2);
    }
    expect(questions.filter(question => question.startsWith('This stops your Myco'))).toHaveLength(2);
    expect(readSetupFile(home).consented['local.stop']).toBeUndefined();
  });

  it('pins the missing hosted address refusal while keeping provisioned resources', async () => {
    const server = ownerDeployment(root, home, 'cloudflare');
    closers.push(server.close);
    const runner = { run: async (...args: Parameters<typeof server.runner.run>) => {
      const result = await server.runner.run(...args);
      return args[1].includes('deploy') ? { ...result, stdout: result.stdout.replace(HOSTED_URL, '') } : result;
    } };
    expect(await run(['--create', 'cloudflare', '--account-id', ACCOUNT, '--yes'], { ...base(), ...server.deps, cloudflare: { ...server.deps.cloudflare, runner } })).toBe(2);
    expect(errors.at(-1)).toBe('myco setup: Cloudflare has not reported your Myco’s address; run myco server status --target cloudflare, then myco setup again.');
    expect(peekDeploymentRecord(home)?.databaseId).toBeTruthy();
    expect(server.github.calls).toHaveLength(0);
  });

  it('pins delayed GitHub verification and resumes the installed app without registering again', async () => {
    const server = ownerDeployment(root, home, 'cloudflare');
    closers.push(server.close);
    const deps = { ...base(), ...server.deps, sleep: async () => {}, registerApp: async (options: Parameters<typeof registerGitHubApp>[0]) => ({ ...await registerGitHubApp(options), verified: { ok: false as const, reason: 'fixture propagation' } }) };
    expect(await run(['--create', 'cloudflare', '--account-id', ACCOUNT, '--new', 'Delayed', '--no-agents', '--no-runner', '--yes'], deps)).toBe(2);
    expect(errors.at(-1)).toBe('myco setup: GitHub sign-in is not answering yet; check myco server status --target cloudflare, then run myco setup again.');
    expect(await run(['--yes'], { ...deps, registerApp: registerGitHubApp })).toBe(0);
    expect(server.github.calls.filter(call => call.url.includes('/conversions'))).toHaveLength(1);
  });

  it('stops on unavailable hosted sign-in without recreating resources or registering an app', async () => {
    const server = ownerDeployment(root, home, 'cloudflare');
    closers.push(server.close);
    const deps: SetupDeps = { ...base(), ...server.deps, createCloudflare: async options => { await createCloudflareDeployment(options); throw new Error('interrupted before sign-in'); } };
    expect(await run(['--create', 'cloudflare', '--account-id', ACCOUNT, '--yes'], deps)).toBe(2);
    const record = peekDeploymentRecord(home);
    expect(await run(['--yes'], { ...deps, fetch: fakeFetch(async (input, init) => {
      if (new globalThis.URL(new Request(input, init).url).pathname === '/auth/login') throw new Error('fixture sign-in unavailable');
      return server.fetchImpl(input, init);
    }) })).toBe(2);
    expect(errors.at(-1)).toBe(`myco setup: deployment.signin (${HOSTED_URL}) unavailable: ${HOSTED_URL} did not answer: fixture sign-in unavailable. Restore access, then run myco setup again.`);
    expect(peekDeploymentRecord(home)).toEqual(record);
    expect(server.commands.filter(command => command.startsWith('deploy '))).toHaveLength(1);
    expect(server.github.calls).toHaveLength(0);
  });

  it('pins account mismatch before running any Cloudflare command', async () => {
    const server = ownerDeployment(root, home, 'cloudflare');
    closers.push(server.close);
    writeDeploymentRecord({ accountId: 'b'.repeat(32), workerName: 'myco-server', databaseName: 'myco-server', bucketName: 'myco-server-blobs', versionId: null, deployedAt: new Date(0).toISOString() }, home);
    const recordFile = path.join(home, 'server', 'cloudflare', 'record.json');
    const before = fs.readFileSync(recordFile);
    expect(await run(['--create', 'cloudflare', '--account-id', ACCOUNT, '--yes'], { ...base(), ...server.deps })).toBe(2);
    expect(errors.at(-1)).toBe(`myco setup: deployment.create (${home}) unavailable: Selected Cloudflare account does not match the Deployment record; keep its --account-id. Restore access, then run myco setup again.`);
    expect(server.commands).toEqual([]);
    expect(peekDeploymentRecord(home)?.accountId).toBe('b'.repeat(32));
    expect(fs.readFileSync(recordFile)).toEqual(before);
  });

  it('pins the refusal to change an existing native port and keeps its keys', async () => {
    const server = ownerDeployment(root, home, 'local', 'http://127.0.0.1:8787');
    closers.push(server.close);
    createLocalDeployment(DEFAULT_LOCAL_RECORD, { library: null, vec0: null }, peekLocalPaths(home));
    const keys = readLocalSecrets(peekLocalPaths(home));
    expect(await run(['--create', 'local', '--port', '8788', '--serve', 'terminal', '--yes'], { ...base(), ...server.deps })).toBe(2);
    expect(errors.at(-1)).toBe('myco setup: This Deployment uses port 8787; run myco setup --port 8787.');
    expect(readLocalSecrets(peekLocalPaths(home))).toEqual(keys);
    expect(server.platform.commands).toEqual([]);
  });

  it('pins missing Wrangler guidance and keeps the selected target', async () => {
    const runner = { run: async () => ({ code: 1, stdout: '', stderr: 'fixture absent' }) };
    expect(await run(['--create', 'cloudflare', '--yes'], { ...base(), cloudflare: { runner } })).toBe(2);
    expect(errors.at(-1)).toBe('myco setup: wrangler is not installed; `npm install -g wrangler`, then `wrangler login`, and retry');
    expect(readSetupFile(home).answers.target).toBe('cloudflare');
    expect(peekDeploymentRecord(home)).toBeNull();
  });

  it('pins the refusal to guide a shared native Deployment', async () => {
    const server = ownerDeployment(root, home, 'local', 'http://127.0.0.1:8787');
    closers.push(server.close);
    createLocalDeployment({ ...DEFAULT_LOCAL_RECORD, origin: 'https://existing.invalid' }, { library: null, vec0: null }, peekLocalPaths(home));
    const data = fs.readFileSync(peekLocalPaths(home).databasePath);
    expect(await run(['--create', 'local', '--serve', 'service', '--yes'], { ...base(), ...server.deps })).toBe(2);
    expect(errors.at(-1)).toBe('myco setup: Guided local setup is loopback only. Keep this Myco’s configuration and use myco server status --target local.');
    expect(fs.readFileSync(peekLocalPaths(home).databasePath)).toEqual(data);
    expect(server.platform.commands).toEqual([]);
  });

  for (const refusal of ['pending', 'missing'] as const) it(`pins the ${refusal} native owner link refusal`, async () => {
    const server = ownerDeployment(root, home, 'local', 'http://127.0.0.1:8787');
    closers.push(server.close);
    const deps: SetupDeps = { ...base(), ...server.deps, sleep: async () => {},
      ask: async question => question.includes('already have') || (refusal === 'pending' && question.startsWith('Make a fresh link?')) ? 'no' : 'yes',
      prepareLocal: async (localHome, plan, localDeps) => ({ ...await prepareLocal(localHome, plan, localDeps), ownerLink: null }),
      ...(refusal === 'missing' ? { recoverLocal: async () => ({ url: 'http://127.0.0.1:8787', ownerLink: null }) } : {}),
    };
    expect(await run(['--create', 'local', '--port', '8787', '--serve', 'service', '--new', 'Owner', '--no-agents', '--no-runner'], deps)).toBe(2);
    expect(errors.at(-1)).toBe(refusal === 'pending' ? 'myco setup: Owner linking is pending; run myco setup again when ready.' : 'myco setup: No owner link was issued; run myco server setup-owner, then myco setup again.');
  });

  it('pins an expired owner link refusal and keeps the first owner for a rerun', async () => {
    const server = ownerDeployment(root, home, 'cloudflare');
    closers.push(server.close);
    let expired = false;
    const deps: SetupDeps = { ...base(), ...server.deps, sleep: async () => {}, now: () => Date.now() + (expired ? 16 * 60_000 : 0),
      ask: async question => question.includes('already have') || question.startsWith('The owner link expired.') ? 'no' : 'yes',
      openUrl: async url => { if (new globalThis.URL(url).hash) { expired = true; return; } await server.openUrl(url); },
    };
    expect(await run(['--create', 'cloudflare', '--account-id', ACCOUNT, '--url', HOSTED_URL, '--new', 'Expired', '--no-agents', '--no-runner'], deps)).toBe(2);
    expect(errors.at(-1)).toBe('myco setup: Owner link expired; run myco setup again to make a fresh link.');
    expect((server.sqlite.query('SELECT count(*) AS count FROM members').get() as { count: number }).count).toBe(1);
    expect(await run(['--yes'], { ...deps, now: Date.now, openUrl: server.openUrl })).toBe(0);
  });

  for (const target of ['cloudflare', 'local'] as const) it(`an expired ${target} owner link is replaced with consent and completes`, async () => {
    const address = target === 'local' ? 'http://127.0.0.1:8787' : HOSTED_URL;
    const server = ownerDeployment(root, home, target, address);
    closers.push(server.close);
    let expired = false;
    let opens = 0;
    const deps: SetupDeps = { ...base(), ...server.deps, now: () => Date.now() + (expired ? 16 * 60_000 : 0), sleep: async () => {},
      openUrl: async url => {
        if (new globalThis.URL(url).hash && ++opens === 1) { expired = true; return; }
        expired = false;
        await server.openUrl(url);
      },
    };
    expect(await run(['--create', target, ...(target === 'local' ? ['--serve', 'service'] : ['--account-id', ACCOUNT]), '--yes', '--new', 'Expiry', '--no-agents', '--no-runner'], deps)).toBe(0);
    expect(errors).toEqual([]);
    expect(opens).toBe(2);
    expect(server.links).toHaveLength(1);
    if (target === 'local') expect(server.platform.commands.some(command => command.includes('unload'))).toBe(true);
  });

  for (const expire of [false, 'wait', 'resume'] as const) it(`terminal setup ${expire ? `recovers an expired link during ${expire}` : 'asks the user to serve'} and never starts a service`, async () => {
    const address = 'http://127.0.0.1:8787';
    const server = ownerDeployment(root, home, 'local', address);
    closers.push(server.close);
    let serves = 0;
    let expired = false;
    let opens = 0;
    let terminal: (() => void)[] = [];
    closers.unshift(() => { terminal.forEach(release => release()); });
    const deps: SetupDeps = { ...base(), ...server.deps, cwd: root, sleep: async () => {}, now: () => Date.now() + (expired ? 16 * 60_000 : 0), openUrl: async url => {
      if (new globalThis.URL(url).hash && ++opens === 1 && expire) {
        expired = true;
        if (expire === 'resume') throw new DOMException('interrupted with the terminal server still running', 'AbortError');
        return;
      }
      expired = false;
      await server.openUrl(url);
    }, stdout: line => {
      lines.push(line);
      if (line.startsWith('Stop your Myco')) { terminal.forEach(release => release()); terminal = []; return; }
      if (!line.startsWith('In another terminal, run:') && !line.startsWith('Start it again:')) return;
      if (terminal.length > 0) return;
      serves++;
      const paths = peekLocalPaths(home);
      for (const [name, mode] of [[`${paths.root}.serve.lock`, 'exclusive'], [`${paths.root}.lock`, 'shared']] as const) {
        const held = LifecycleLock.acquire(name, { command: 'fixture separate terminal', mode });
        if (!held.acquired) throw new Error('fixture terminal lease unavailable');
        terminal.push(() => held.lock.release());
      }
    } };
    const result = await run(['--create', 'local', '--serve', 'terminal', '--yes', '--no-agents', '--no-runner'], deps);
    expect(result).toBe(expire === 'resume' ? 2 : 0);
    if (expire === 'resume') {
      expect(errors.pop()).toBe('myco setup: interrupted with the terminal server still running');
      expect(await run(['--yes'], deps)).toBe(0);
    }
    expect(errors).toEqual([]);
    expect(serves).toBe(expire ? 2 : 1);
    expect(server.platform.commands).toEqual([]);
    expect(lines).toContain('In another terminal, run: myco server run --target local');
    expect(lines.at(-1)).toContain('from a git repository');
  });

  for (const target of ['local', 'cloudflare'] as const) it(`create ${target} status on an absent home is file-only, read-only and never runs tools`, async () => {
    const before = snapshot(root);
    expect(await run(['--status', '--json', '--create', target], { ...base(), fetch: fakeFetch(async () => { throw new Error('network forbidden'); }), cloudflare: { runner: { run: async () => { throw new Error('wrangler forbidden'); } } }, local: { native: { library: null, vec0: null }, service: { runner: () => { throw new Error('service forbidden'); } } } })).toBe(3);
    expect(snapshot(root)).toEqual(before);
    const observations = JSON.parse(lines.at(-1)!).observations as Awaited<ReturnType<typeof observeSetup>>;
    expect(observations.find(fact => fact.id === 'deployment.create')?.state).toBe('absent');
  });

  for (const [flags, refusal] of [
    [['--create', 'other'], '--create needs cloudflare or local'],
    [['--create', 'local', '--url', 'https://example.invalid'], 'Local setup is loopback only; use --port and --serve, without --url, --account-id or --org.'],
    [['--create', 'cloudflare', '--port', '8787'], 'Cloudflare setup uses --account-id and --url, without --port or --serve.'],
    [['--account-id', 'wrong'], '--account-id needs 32 hexadecimal characters'],
    [['--url', 'http://remote.invalid'], '--url needs an https Deployment origin, with no path, query or fragment'],
    [['--org', 'bad org'], '--org needs a GitHub organization name'],
    [['--app-name', 'x'.repeat(35)], '--app-name needs 1 to 34 characters'],
    [['--port', '0'], '--port needs an integer from 1 to 65535'],
    [['--port', '1.5'], '--port needs an integer from 1 to 65535'],
    [['--serve', 'foreground'], '--serve needs service or terminal'],
    [['--create', 'local', '--join', URL], '--create and --join cannot be combined'],
    [['--create', 'local', '--runner', URL], '--create and --runner cannot be combined'],
  ] as const) it(`pins the refusal for ${flags.join(' ')}`, () => {
    expect(() => parseSetupOptions(flags)).toThrow(refusal);
  });
});

describe('create journeys across SIGKILL', () => {
  const repo = fileURLToPath(new globalThis.URL('../../', import.meta.url));
  for (const target of ['cloudflare', 'local']) for (const boundary of ['create', 'conversion', 'signin', 'owner-mint', 'owner-link', 'machine', 'project', ...(target === 'cloudflare' ? ['cloudflare-login', 'partial-create', 'before-deploy', 'installed'] : ['service'])]) {
    it(`${target}: resumes after SIGKILL at ${boundary}`, async () => {
      const childRoot = path.join(root, 'child');
      fs.mkdirSync(childRoot);
      fs.renameSync(project, path.join(childRoot, 'repo'));
      const args = ['test', '--preload', path.join(repo, 'tests/setup/sandbox-preload.ts'), '--tsconfig-override', path.join(repo, 'tsconfig.json'), path.join(repo, 'tests/setup/fixtures/create_journey_interruption_test.ts')];
      const env = sandboxChildEnv(childRoot, { MYCO_SETUP_FIXTURE_ROOT: childRoot, MYCO_SETUP_TARGET: target });
      const child = spawn(process.execPath, args, { env: { ...env, MYCO_SETUP_STOP_AFTER: boundary }, cwd: childRoot, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      const capture = (chunk: Buffer) => { output += chunk.toString(); };
      child.stdout.on('data', capture);
      child.stderr.on('data', capture);
      const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
      try {
        const deadline = Date.now() + 15_000;
        while (!fs.existsSync(path.join(childRoot, 'reached')) && child.exitCode === null && Date.now() < deadline) await Bun.sleep(20);
        expect({ reached: fs.existsSync(path.join(childRoot, 'reached')), output: output.replace(/\/link#[^\s]+/g, '/link#[redacted]') }).toMatchObject({ reached: true });
      } finally { if (child.exitCode === null) child.kill('SIGKILL'); await exited; }
      const childHome = path.join(childRoot, 'myco');
      const keys = target === 'local' ? readLocalSecrets(peekLocalPaths(childHome)) : null;
      const record = peekDeploymentRecord(childHome);
      const result = Bun.spawnSync([process.execPath, ...args], { env: { ...env, MYCO_SETUP_RESUME: '1' }, cwd: childRoot, stdout: 'pipe', stderr: 'pipe' });
      expect({ code: result.exitCode, output: result.stderr.toString() }).toMatchObject({ code: 0 });
      const resumed = JSON.parse(fs.readFileSync(path.join(childRoot, 'resumed'), 'utf8'));
      expect(resumed.commands.filter((command: string) => command.startsWith('d1 create'))).toHaveLength(boundary === 'cloudflare-login' ? 1 : 0);
      expect(resumed.conversions).toBe(['create', 'cloudflare-login', 'partial-create', 'before-deploy'].includes(boundary) ? 1 : 0);
      if (target === 'cloudflare') {
        expect(resumed.totalConversions).toBe(1);
        expect(peekDeploymentRecord(childHome)).toMatchObject({ versionId: expect.any(String), url: HOSTED_URL });
        expect(resumed.commands.filter((command: string) => command.startsWith('deploy '))).toHaveLength(['cloudflare-login', 'partial-create', 'before-deploy'].includes(boundary) ? 1 : 0);
        expect(fs.existsSync(path.join(childHome, 'server/cloudflare/sign-in-pending.json'))).toBe(false);
      }
      const address = target === 'cloudflare' ? HOSTED_URL : 'http://127.0.0.1:8787';
      expect(readDeploymentMembership(address, childHome)).not.toBeNull();
      expect(readRegistryEntry(path.join(childRoot, 'repo'), childHome)).not.toBeNull();
      if (target === 'cloudflare') {
        if (record) expect(peekDeploymentRecord(childHome)?.databaseId).toBe(record.databaseId);
        else expect(peekDeploymentRecord(childHome)?.databaseId).toBeTruthy();
      }
      else for (const key of ['SESSION_SECRET', 'SECRET_WRAP_KEY'] as const) expect(readLocalSecrets(peekLocalPaths(childHome))[key]).toBe(keys![key]);
    }, 30_000);
  }
});

function migrationFixture(state: LegacyMigrationState['state'], owner?: 'unit' | 'registration') {
  const user = path.join(root, 'user');
  const env = {
    HOME: user, CODEX_HOME: path.join(user, '.codex'), CLAUDE_CONFIG_DIR: path.join(user, '.claude'),
    XDG_CONFIG_HOME: path.join(user, '.config'), MYCO_HOME: home,
    MYCO_LAUNCH_AGENTS_DIR: path.join(root, 'units'),
  };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  closers.push(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  fs.mkdirSync(user, { recursive: true });
  const record = path.join(home, 'member', 'cutover.json');
  if (state === 'none') return { record };
  const vault = path.join(home, 'groves', 'legacy', 'myco.db');
  fs.mkdirSync(path.dirname(vault), { recursive: true });
  const db = new Database(vault);
  try { db.run('CREATE TABLE sessions (body TEXT)'); db.run("INSERT INTO sessions VALUES ('retained')"); } finally { db.close(); }
  if (state !== 'unmoved') {
    const receipt = { ...legacyVaultStamp(vault), digest: readVaultContent(vault).digest, projects: {
      proj_legacy: {
        destination: { serverUrl: URL, key: deploymentKeyFor(URL) },
        vault: { state: state === 'partial' ? 'partial' : 'complete', at: 1 },
        transcripts: { state: 'none', at: 1 },
      },
    } };
    fs.mkdirSync(path.dirname(record), { recursive: true });
    fs.writeFileSync(record, state === 'unavailable' ? '{' : JSON.stringify({
      version: 2, backups: { [vault]: {} },
      ...(state === 'needs-destination' ? {} : { migrations: { [vault]: receipt } }),
      ...(['partial', 'moved', 'changed'].includes(state) ? { handover: { at: 1, legacyHomes: [home], agents: [] } } : {}),
    }), { mode: 0o600 });
    if (state === 'changed') {
      const write = new Database(vault);
      try { write.run("INSERT INTO sessions VALUES ('new capture')"); } finally { write.close(); }
      const stamp = fs.statSync(vault);
      fs.utimesSync(vault, stamp.atime, new Date(stamp.mtimeMs + 1000));
    }
  }
  if (owner === 'unit') {
    fs.mkdirSync(env.MYCO_LAUNCH_AGENTS_DIR, { recursive: true });
    fs.writeFileSync(path.join(env.MYCO_LAUNCH_AGENTS_DIR, 'co.goondocks.myco.fixture.plist'),
      `<plist version="1.0"><dict><key>ProgramArguments</key><array><string>${home}/bin/myco</string><string>daemon</string></array><key>EnvironmentVariables</key><dict><key>MYCO_HOME</key><string>${home}</string></dict></dict></plist>`);
  } else if (owner === 'registration') {
    fs.mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true });
    fs.writeFileSync(path.join(env.CLAUDE_CONFIG_DIR, 'settings.json'), JSON.stringify({ hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: `${home}/bin/myco hook session-start --myco-managed` }] }],
    } }), { mode: 0o600 });
  }
  return { record };
}

const configuredFetch = fakeFetch(async (input) => {
  const request = new Request(input);
  const route = new globalThis.URL(request.url).pathname;
  if (route === '/health') return Response.json({ ok: true });
  if (route === '/auth/login') return new Response(null, { status: 302, headers: { location: `https://github.com/login/oauth/authorize?client_id=fixture&redirect_uri=${encodeURIComponent(`${URL}/auth/callback`)}` } });
  if (route === '/runners/contact') return Response.json({ persisted: true, runner: { id: 'rn_setup_enrolled', name: 'Fixture runner', deploymentId: 'fixture-deployment', state: 'enabled' }, credential: { id: 'credential', expiresAt: 9999999999999, refreshAfter: 0 } });
  if (route === '/members/status') return Response.json({ target: 'fixture' });
  if (route === '/members/projects/list') return Response.json({ projects: [{ projectId: 'proj_capture', name: 'Capture', sessionCount: 0 }] });
  throw new Error(`unexpected route ${route}`);
});

async function deployment(target: 'native' | 'd1-adapter') {
  const github = fakeGitHub();
  let handler: BunHandler | undefined;
  let handle: (request: Request) => Promise<Response>;
  const secrets = { GITHUB_CLIENT_ID: SETUP_APP.clientId, GITHUB_CLIENT_SECRET: SETUP_APP.clientSecret, SESSION_SECRET };
  if (target === 'native') {
    const sqlite = seededSqlite();
    sqlite.run("UPDATE members SET github_id = '770001', role = 'member' WHERE id = 'mem_machine_2'");
    const databasePath = path.join(root, 'server.sqlite');
    fs.writeFileSync(databasePath, sqlite.serialize()); sqlite.close();
    handler = await createBunHandler({ databasePath, blobDir: path.join(root, 'blobs'), header: 'x-forwarded-for', wakeLoop: false, ...secrets, fetchImpl: github.fetchImpl });
    closers.push(() => handler!.close());
    handle = handler.fetch;
  } else {
    const fixture = sqliteEnv();
    fixture.sqlite.run("UPDATE members SET github_id = '770001', role = 'member' WHERE id = 'mem_machine_2'");
    closers.push(() => fixture.sqlite.close());
    const server = createServer({ now: Date.now, sourceOf: () => '192.0.2.30', fetchImpl: github.fetchImpl });
    handle = (request) => server.handleRequest(request, { ...fixture.serverEnv, secrets });
  }
  const signin = await handle(new Request(`${URL}/auth/login`, { headers: { 'x-forwarded-for': '192.0.2.30' } }));
  const state = new globalThis.URL(signin.headers.get('location')!).searchParams.get('state')!;
  const callback = await handle(new Request(`${URL}/auth/callback?code=teammate&state=${encodeURIComponent(state)}`, { headers: { 'x-forwarded-for': '192.0.2.30', cookie: `${OAUTH_STATE_COOKIE}=${state}` } }));
  expect(callback.status).toBe(302);
  const cookies = callback.headers.get('set-cookie')!;
  const cookie = `${SESSION_COOKIE}=${cookies.slice(cookies.indexOf(`${SESSION_COOKIE}=`) + SESSION_COOKIE.length + 1).split(';')[0]}`;
  const calls: string[] = [];
  const fetchImpl = fakeFetch(async (input, init) => {
    const request = new Request(input, init);
    request.headers.set('x-forwarded-for', '192.0.2.30');
    const route = new globalThis.URL(request.url).pathname;
    calls.push(route);
    const response = await handle(request);
    if (route === '/auth/device/start' && response.ok) {
      const grant = await response.clone().json() as { user_code: string };
      const approved = await handle(new Request(`${URL}/api/device/approve`, { method: 'POST', headers: { origin: URL, cookie, 'content-type': 'application/json', 'x-forwarded-for': '192.0.2.30' }, body: JSON.stringify({ user_code: grant.user_code }) }));
      expect(approved.status).toBe(200);
    }
    return response;
  });
  return { fetchImpl, calls, github };
}

describe('teammate journey (c)', () => {
  for (const target of ['native', 'd1-adapter'] as const) it(`joins as a fake GitHub teammate through ${target}, with no worker`, async () => {
    const server = await deployment(target);
    const platform = recordingPlatform();
    const deps: SetupDeps = { ...base(), fetch: server.fetchImpl, sleep: async () => {}, loginDeps: { machineId: 'setup-teammate-machine' }, worker: { runner: platform.runner } };
    const args = ['--join', URL, '--root', project, '--project', 'proj_1', '--no-agents', '--no-runner'];
    expect(await run(args, deps)).toBe(0);
    expect(errors).toEqual([]);
    expect(readDeploymentMembership(URL, home)?.memberId).toBe('mem_machine_2');
    expect(readDefaultDeployment(home)?.serverUrl).toBe(URL);
    expect(fs.existsSync(machineSettingsPath(URL, home))).toBe(true);
    expect(readRegistryEntry(project, home)?.projectId).toBe('proj_1');
    expect(platform.commands).toEqual([]);
    expect(server.calls.filter((route) => route === '/auth/device/start')).toHaveLength(1);
    expect(await run([], deps)).toBe(0);
    expect(server.calls.filter((route) => route === '/auth/device/start')).toHaveLength(1);
    const before = snapshot(home);
    expect(await run(['--status', '--json'], { ...deps, fetch: fakeFetch(async () => { throw new Error('status made a network call'); }) })).toBe(0);
    expect(snapshot(home)).toEqual(before);
    expect(server.github.calls).toHaveLength(2);
  });

  it('resumes provisioning and project connection after sign-in was interrupted', async () => {
    const server = await deployment('d1-adapter');
    let interrupted = true;
    const deps: SetupDeps = { ...base(), fetch: server.fetchImpl, sleep: async () => {}, loginDeps: { machineId: 'interrupted-machine' },
      login: async (args, loginDeps) => {
        expect(loginDeps?.provision).toBe('defer');
        const ok = await login(args, loginDeps);
        if (interrupted) { interrupted = false; throw new Error('Ctrl-C mid-step'); }
        return ok;
      } };
    expect(await run(['--join', URL, '--project', 'proj_1', '--no-agents', '--no-runner'], deps)).toBe(2);
    expect(readDeploymentMembership(URL, home)).not.toBeNull();
    expect(readRegistryEntry(project, home)).toBeNull();
    expect(await run([], { ...deps, login: async () => { throw new Error('must not repeat login'); } })).toBe(0);
    expect(readRegistryEntry(project, home)?.projectId).toBe('proj_1');
  });

  it('stops on unreachable observations without creating a new credential', async () => {
    writeDeploymentMembership({ serverUrl: URL, token: 'x'.repeat(43), machineId: 'fixture', joinedAt: 1, updatedAt: 1 }, { mycoHome: home });
    const before = fs.readFileSync(deploymentPath(URL, home));
    let loggedIn = false;
    expect(await run(['--join', URL, '--no-runner', '--no-agents'], { ...base(), fetch: fakeFetch(async () => { throw new Error('offline'); }), login: async () => { loggedIn = true; return false; } })).toBe(2);
    expect(loggedIn).toBe(false);
    expect(fs.readFileSync(deploymentPath(URL, home))).toEqual(before);
    expect(errors.join('\n')).toContain('unavailable');
  });

  it('changes the default directly after the one explicit choice', async () => {
    const server = await deployment('d1-adapter');
    recordDefaultDeployment('https://other.invalid', { mycoHome: home });
    expect(await run(['--join', URL, '--project', 'proj_1', '--default', '--no-agents', '--no-runner'], { ...base(), fetch: server.fetchImpl, sleep: async () => {}, loginDeps: { machineId: 'default-machine' } })).toBe(0);
    expect(readDefaultDeployment(home)?.serverUrl).toBe(URL);
    expect(lines.join('\n')).toContain('#1724');
  });

  it('re-asks before a saved default answer replaces a later user choice', async () => {
    const server = await deployment('d1-adapter');
    recordDefaultDeployment('https://first.invalid', { mycoHome: home });
    const deps: SetupDeps = { ...base(), fetch: server.fetchImpl, sleep: async () => {}, loginDeps: { machineId: 'changed-default-machine' } };
    expect(await run(['--join', URL, '--project', 'proj_1', '--default', '--no-agents', '--no-runner'], deps)).toBe(0);
    recordDefaultDeployment('https://later.invalid', { mycoHome: home, replace: true });
    expect(await run(['--yes'], deps)).toBe(2);
    expect(readDefaultDeployment(home)?.serverUrl).toBe('https://later.invalid');
    expect(errors.join('\n')).toContain('changed plans require fresh consent');
  });

  it('returns the join owner’s project-choice refusal without a terminal', async () => {
    const server = await deployment('d1-adapter');
    expect(await run(['--join', URL, '--no-agents', '--no-runner'], { ...base(), fetch: server.fetchImpl, sleep: async () => {}, loginDeps: { machineId: 'no-project-choice' } })).toBe(2);
    expect(errors.join('\n')).toContain('myco member join --project');
    expect(readRegistryEntry(project, home)).toBeNull();
  });

  it('conducts an explicit changed Project choice and refuses new creation on a bound repository', async () => {
    const server = await deployment('d1-adapter');
    const deps: SetupDeps = { ...base(), fetch: server.fetchImpl, sleep: async () => {}, loginDeps: { machineId: 'project-choice-machine' } };
    expect(await run(['--join', URL, '--project', 'proj_1', '--no-agents', '--no-runner'], deps)).toBe(0);
    expect(await run(['--project', 'proj_2'], deps)).toBe(0);
    expect(readRegistryEntry(project, home)?.projectId).toBe('proj_2');
    expect(await run(['--new', 'Another'], deps)).toBe(2);
    expect(readRegistryEntry(project, home)?.projectId).toBe('proj_2');
    expect(server.calls).not.toContain('/members/projects');
  });

  it('cannot report completion when an operation returns without the durable binding', async () => {
    writeDeploymentMembership({ serverUrl: URL, token: 'x'.repeat(43), machineId: 'fixture', joinedAt: 1, updatedAt: 1 }, { mycoHome: home });
    expect(await run(['--join', URL, '--project', 'proj_1', '--no-agents', '--no-runner'], { ...base(), fetch: configuredFetch,
      join: async () => ({ version: 2, serverUrl: URL, root: project, projectId: 'proj_1', token: 'x'.repeat(43), machineId: 'fixture', joinedAt: 1, updatedAt: 1 }),
    })).toBe(2);
    expect(errors.join('\n')).toContain('project remains absent');
  });
});

describe('runner journey (d)', () => {
  function runnerDeps() {
    const platform = recordingPlatform();
    const user = path.join(root, 'user');
    fs.mkdirSync(user);
    let time = Date.now();
    const deps: SetupDeps = { ...base(), fetch: configuredFetch, now: () => time,
      sleep: async (ms) => { time += ms; },
      worker: { home: user, binaryPath: path.join(root, 'bin', 'myco'), platform: 'darwin', runner: platform.runner,
        ownDeploymentUrls: async () => [], lockDir: path.join(root, 'locks'), harnessDirs: () => [], detect: () => [] },
    };
    return { deps, platform, advance: (ms: number) => { time += ms; } };
  }

  it('registers a runner without membership and respects a declined service on reruns', async () => {
    let starts = 0;
    const fake = runnerDeps();
    const fetchImpl = fakeFetch(async (input, init) => {
      const route = new globalThis.URL(new Request(input, init).url).pathname;
      if (route === '/auth/login') throw new Error('runner setup must not probe member sign-in');
      if (route === '/auth/runner/start') { starts++; return Response.json({ device_code: 'd'.repeat(43), user_code: 'BCDF-2345', expires_in: 600, interval: 1 }); }
      if (route === '/auth/runner/poll') return Response.json({ registered: true, runnerId: 'rn_setup_enrolled', name: 'mini', deploymentId: 'fixture-deployment' });
      return configuredFetch(input, init);
    });
    expect(await run(['--runner', URL, '--runner-name', 'mini', '--runner-service', 'skip', '--yes'], { ...fake.deps, fetch: fetchImpl })).toBe(0);
    expect(readDeploymentMembership(URL, home)).toBeNull();
    expect(readRunnerRecord(URL, home)?.name).toBe('mini');
    expect(await run([], { ...fake.deps, fetch: fetchImpl })).toBe(0);
    expect(starts).toBe(1);
    expect(fake.platform.commands).toEqual([]);
  });

  it('resumes enrollment after a failed install, and waits for a fresh acknowledged offer', async () => {
    await enrolledBeforeInstall(home, URL);
    const fake = runnerDeps();
    let fail = true;
    let installs = 0;
    const deps: SetupDeps = { ...fake.deps, register: async () => { throw new Error('must not register again'); },
      service: async (verb, args, serviceDeps) => {
        installs++;
        if (fail) { fail = false; return false; }
        const ok = await runRunnerService(verb, args, serviceDeps);
        holdRunnerLock(fake.deps.worker!.lockDir!);
        const record = readRunnerRecord(URL, home)!;
        await recordRunnerContact(URL, { runnerId: record.runnerId!, deploymentId: record.deploymentId! }, Date.now() + 1000, home, { offered: ['claude-code'], withheld: [] });
        return ok;
      } };
    expect(await run(['--runner', URL, '--runner-service', 'install', '--yes'], deps)).toBe(2);
    expect(readRunnerRecord(URL, home)?.runnerId).toBe('rn_setup_enrolled');
    expect(await run([], deps)).toBe(0);
    expect(installs).toBe(2);
    expect(lines.join('\n')).toContain('Runner offering claude-code');
  });

  it('rejects an old offer from before service installation', async () => {
    const record = await enrolledBeforeInstall(home, URL);
    await recordRunnerContact(URL, { runnerId: record.runnerId, deploymentId: record.deploymentId }, 1, home, { offered: ['claude-code'], withheld: [] });
    const fake = runnerDeps();
    expect(await run(['--runner', URL, '--runner-service', 'install', '--yes'], fake.deps)).toBe(2);
    expect(errors.join('\n')).toContain('No current runner offer');
    expect(lines.join('\n')).not.toContain('Runner offering');
  });

  it('a saved runner role and install choice never grant service consent', async () => {
    await enrolledBeforeInstall(home, URL);
    saveSetupFile(home, { version: 1, answers: { role: 'runner', url: URL, runnerService: 'install' }, consented: {} });
    const fake = runnerDeps();
    expect(await run([], fake.deps)).toBe(2);
    expect(fake.platform.commands).toEqual([]);
    expect(errors.join('\n')).toContain('no terminal');
  });
});

describe('observation and consent contracts', () => {
  for (const runtime of ['running', 'stopped', 'unavailable', 'starting', 'restarted'] as const) it(`status reports an installed runner as ${runtime} without changing HOME or MYCO_HOME`, async () => {
    const record = await enrolledBeforeInstall(home, URL);
    const platform = recordingPlatform();
    const userHome = path.join(root, 'user');
    const lockDir = path.join(root, 'locks');
    const worker = { home: userHome, mycoHome: home, platform: 'darwin' as const, binaryPath: path.join(root, 'bin', 'myco'), runner: platform.runner, lockDir };
    const installed = installWorkerService(executorServiceTarget(URL, worker, 'runner'), [], { runner: platform.runner });
    if (runtime === 'stopped') platform.running.clear();
    if (runtime !== 'starting') holdRunnerLock(lockDir);
    if (runtime === 'unavailable') worker.runner = (command, args) => { platform.runner(command, args); return { status: null, error: new Error('Fixture service manager unavailable') }; };
    if (runtime === 'restarted') fs.utimesSync(installed.unitFile, new Date(Date.now() - 10_000), new Date(Date.now() - 10_000));
    await recordRunnerContact(URL, { runnerId: record.runnerId, deploymentId: record.deploymentId }, Date.now() + (runtime === 'restarted' ? -5000 : 1000), home, { offered: ['claude-code'], withheld: [] });
    const unrelated = runnerRecordPath('https://unrelated.invalid', home);
    fs.mkdirSync(path.dirname(unrelated), { recursive: true });
    fs.writeFileSync(unrelated, '{}', { mode: 0o600 });
    platform.commands.length = 0;
    const before = snapshot(root);
    expect(await run(['--status', '--json', '--runner', URL, '--runner-service', 'install'], { ...base(), worker, fetch: fakeFetch(async () => { throw new Error('status made a network call'); }) })).toBe(runtime === 'unavailable' ? 4 : runtime === 'running' ? 0 : 3);
    const observations = JSON.parse(lines.at(-1)!).observations as Awaited<ReturnType<typeof observeSetup>>;
    const service = observations.find(fact => fact.id === 'runner.service');
    expect(service?.state).toBe(runtime === 'unavailable' ? 'unavailable' : runtime === 'stopped' ? 'incomplete' : 'complete');
    expect(service?.detail).toContain(runtime === 'unavailable' ? 'unavailable' : runtime === 'stopped' ? 'installed, stopped' : 'running');
    expect(observations.find(fact => fact.id === 'runner.offer')?.state).toBe(runtime === 'starting' || runtime === 'restarted' ? 'incomplete' : 'complete');
    expect(snapshot(root)).toEqual(before);
    expect(platform.commands).toHaveLength(1);
    expect(platform.commands[0]).toMatch(/^launchctl list /);
  });

  for (const missingLock of [false, true]) it(`status observes capture backlog ${missingLock ? 'with a missing lock' : 'and delivery facts'} without repairing it`, async () => {
    const entry = { version: 2, serverUrl: URL, token: 'x'.repeat(43), machineId: 'fixture', joinedAt: 1, updatedAt: 1, root: project, projectId: 'proj_capture' };
    writeRegistryEntry(entry, { mycoHome: home });
    const spool = new MemberSpool(entry, { mycoHome: home });
    const sessionId = 'setup-capture';
    spool.append(sessionId, promptEvent({ agent: 'claude-code', sessionId, stage: spool.stagerFor(sessionId), version: '2.0.0-test' }, { promptId: mintId(), text: 'fixture prompt' }));
    updateSessionState(spool.dir, sessionId, state => { state.lastDeliveryAt = 1000; });
    fs.writeFileSync(path.join(spool.dir, 'offline.json'), JSON.stringify({ since: 1000, nextProbeAt: 3000, backoffMs: 2000 }), { mode: 0o600 });
    spool.appendRefused({ eventId: mintId(), sessionId, kind: 'prompt', code: 'clock_skew', reason: 'Fixture clock refusal', at: 1000 });
    if (missingLock) fs.unlinkSync(bufferLockPath(spool.dir, sessionId));
    const before = snapshot(root);
    expect(await run(['--status', '--json', '--join', URL, '--root', project, '--no-agents', '--no-runner'], { ...base(), now: () => 2000 })).toBe(0);
    const observations = JSON.parse(lines.at(-1)!).observations as Awaited<ReturnType<typeof observeSetup>>;
    const backlog = observations.find(fact => fact.id === 'machine.backlog');
    expect(backlog?.scope).toBe(project);
    expect(backlog?.state).toBe('incomplete');
    expect(backlog?.detail).toContain('1 event(s) waiting');
    expect(backlog?.detail).toContain(new Date(1000).toISOString());
    expect(observations.find(fact => fact.id === 'machine.latch')?.state).toBe('incomplete');
    expect(observations.find(fact => fact.id === 'machine.refusals')?.state).toBe('incomplete');
    expect(snapshot(root)).toEqual(before);
    await homeReport(home, { mycoHome: home, cwd: project, fetch: configuredFetch, worker: { home: path.join(root, 'user'), runner: recordingPlatform().runner, lockDir: path.join(root, 'locks') } });
    expect(snapshot(root)).toEqual(before);
  });

  it('proceeds with a warning for a readable refusal log with a torn line', async () => {
    const entry = { version: 2, serverUrl: URL, token: 'x'.repeat(43), machineId: 'fixture', joinedAt: 1, updatedAt: 1, root: project, projectId: 'proj_capture' };
    writeRegistryEntry(entry, { mycoHome: home });
    const spool = new MemberSpool(entry, { mycoHome: home });
    fs.writeFileSync(path.join(spool.dir, 'refused.jsonl'), '{"torn\n', { mode: 0o600 });
    const args = ['--join', URL, '--root', project, '--project', 'proj_capture', '--no-agents', '--no-runner'];
    const before = snapshot(root);
    const facts = await observeSetup(home, { role: 'join', url: URL, root: project, noAgents: true, runWork: false }, base());
    expect(facts.find(fact => fact.id === 'machine.refusals')?.state).toBe('incomplete');
    expect(snapshot(root)).toEqual(before);
    expect(await run(args, { ...base(), fetch: configuredFetch })).toBe(0);
    expect(lines.join('\n')).toContain('Warning: machine.refusals');
    expect(lines.join('\n')).toContain('1 unreadable log lines');
    expect(errors).toEqual([]);
  });

  it('reads each capture journal once per conductor run', async () => {
    const entry = { version: 2, serverUrl: URL, token: 'x'.repeat(43), machineId: 'fixture', joinedAt: 1, updatedAt: 1, root: project, projectId: 'proj_capture' };
    writeRegistryEntry(entry, { mycoHome: home });
    const spool = new MemberSpool(entry, { mycoHome: home });
    fs.writeFileSync(path.join(spool.dir, 'read-count.jsonl'), '', { mode: 0o600 });
    const reads = spyOn(MemberSpool.prototype, 'readRecordsOrNull');
    try {
      expect(await run(['--join', URL, '--root', project, '--no-agents', '--no-runner'], { ...base(), fetch: configuredFetch })).toBe(0);
      expect(reads).toHaveBeenCalledTimes(1);
      expect(reads).toHaveBeenCalledWith('read-count');
    } finally { reads.mockRestore(); }
  });

  it('names --yes for a first plan without a terminal', async () => {
    const file = { version: 1 as const, answers: {}, consented: {} };
    await expect(consentToPlan({ home, file, id: 'runner', plan: { url: URL }, question: 'Register this runner?', ask: async () => null, out: () => {}, yes: false })).rejects.toThrow('pass --yes');
    expect(readSetupFile(home).consented).toEqual({});
  });

  for (const damaged of ['latch', 'session state'] as const) it(`reports an unavailable capture ${damaged} without blocking setup`, async () => {
    const entry = { version: 2, serverUrl: URL, token: 'x'.repeat(43), machineId: 'fixture', joinedAt: 1, updatedAt: 1, root: project, projectId: 'proj_capture' };
    writeRegistryEntry(entry, { mycoHome: home });
    const spool = new MemberSpool(entry, { mycoHome: home });
    fs.writeFileSync(path.join(spool.dir, 'damaged.jsonl'), '', { mode: 0o600 });
    fs.writeFileSync(damaged === 'latch' ? path.join(spool.dir, 'offline.json') : sessionStatePath(spool.dir, 'damaged'), '{', { mode: 0o600 });
    expect(await run(['--join', URL, '--root', project, '--no-agents', '--no-runner'], { ...base(), fetch: configuredFetch })).toBe(0);
    expect(lines.join('\n')).toContain(damaged === 'latch' ? 'Warning: machine.latch' : 'Warning: machine.backlog');
  });

  it('counts a journal with a torn final line and no lock without creating files', async () => {
    const entry = { version: 2, serverUrl: URL, token: 'x'.repeat(43), machineId: 'fixture', joinedAt: 1, updatedAt: 1, root: project, projectId: 'proj_capture' };
    writeRegistryEntry(entry, { mycoHome: home });
    const spool = new MemberSpool(entry, { mycoHome: home });
    const sessionId = 'torn-journal';
    spool.append(sessionId, promptEvent({ agent: 'claude-code', sessionId, stage: spool.stagerFor(sessionId), version: '2.0.0-test' }, { promptId: mintId(), text: 'fixture prompt' }));
    fs.appendFileSync(path.join(spool.dir, `${sessionId}.jsonl`), '{"torn');
    fs.unlinkSync(bufferLockPath(spool.dir, sessionId));
    const before = snapshot(root);
    const facts = await observeSetup(home, { role: 'join', url: URL, root: project, noAgents: true, runWork: false }, base());
    expect(facts.find(fact => fact.id === 'machine.backlog')).toMatchObject({ state: 'incomplete', detail: expect.stringContaining('2 event(s) waiting') });
    const report = await homeReport(home, { mycoHome: home, cwd: project, fetch: configuredFetch, worker: { home: path.join(root, 'user'), runner: recordingPlatform().runner, lockDir: path.join(root, 'locks') } });
    expect(report.find(check => check.name === 'Capture backlog')).toMatchObject({ status: 'warn', detail: expect.stringContaining('2 event(s) waiting') });
    expect(snapshot(root)).toEqual(before);
  });

  it('an unavailable later runner observation does not gate sign-in or Project connection', async () => {
    const record = runnerRecordPath(URL, home);
    fs.mkdirSync(path.dirname(record), { recursive: true });
    fs.writeFileSync(record, '{}', { mode: 0o600 });
    const calls: string[] = [];
    const worker = { home: path.join(root, 'user'), mycoHome: home, runner: recordingPlatform().runner, lockDir: path.join(root, 'locks'), harnessDirs: () => [], detect: () => [] };
    const deps: SetupDeps = { ...base(), fetch: configuredFetch, worker, runnerDeps: worker,
      login: async () => {
        calls.push('login');
        writeDeploymentMembership({ serverUrl: URL, token: 'x'.repeat(43), machineId: 'fixture', joinedAt: 1, updatedAt: 1 }, { mycoHome: home });
        return true;
      },
      join: async () => {
        calls.push('join');
        const entry = { version: 2, serverUrl: URL, token: 'x'.repeat(43), machineId: 'fixture', joinedAt: 1, updatedAt: 1, root: project, projectId: 'proj_capture' };
        writeRegistryEntry(entry, { mycoHome: home });
        return entry;
      },
    };
    expect(await run(['--join', URL, '--root', project, '--project', 'proj_capture', '--no-agents', '--run-work', '--runner-service', 'skip'], deps)).toBe(2);
    expect(calls).toEqual(['login', 'join']);
    expect(errors.join('\n')).toContain('runner.enrollment');
  });

  it('status dates the full refusal history and only flags recent refusals', async () => {
    const now = Date.UTC(2026, 9, 11);
    const entry = { version: 2, serverUrl: URL, token: 'x'.repeat(43), machineId: 'fixture', joinedAt: 1, updatedAt: 1, root: project, projectId: 'proj_capture' };
    writeRegistryEntry(entry, { mycoHome: home });
    const spool = new MemberSpool(entry, { mycoHome: home });
    const old = now - 8 * 24 * 60 * 60 * 1000;
    const append = (at: number) => spool.appendRefused({ eventId: mintId(), sessionId: 'refusal-history', kind: 'prompt', code: 'clock_skew', reason: 'Fixture refusal', at });
    append(old);
    for (const recent of [false, true]) {
      if (recent) {
        append(now);
        for (let i = 0; i < 55; i++) append(old);
      }
      const before = snapshot(root);
      await run(['--status', '--json', '--join', URL, '--root', project, '--no-agents', '--no-runner'], { ...base(), now: () => now });
      const observations = JSON.parse(lines.at(-1)!).observations as Awaited<ReturnType<typeof observeSetup>>;
      const refusal = observations.find(fact => fact.id === 'machine.refusals');
      expect(refusal?.state).toBe(recent ? 'incomplete' : 'complete');
      expect(refusal?.detail).toContain(new Date(recent ? now : old).toISOString());
      expect(refusal?.detail).toContain(recent ? '57 refused event(s)' : '1 refused event(s)');
      expect(refusal?.detail).toContain(recent ? '1 in the last 7 days' : '0 in the last 7 days');
      expect(snapshot(root)).toEqual(before);
    }
    append(1e30);
    const before = snapshot(root);
    await run(['--status', '--json', '--join', URL, '--root', project, '--no-agents', '--no-runner'], { ...base(), now: () => now });
    const observations = JSON.parse(lines.at(-1)!).observations as Awaited<ReturnType<typeof observeSetup>>;
    expect(observations.find(fact => fact.id === 'machine.backlog')?.state).toBe('complete');
    expect(observations.find(fact => fact.id === 'machine.refusals')?.detail).toContain('newest unknown');
    expect(snapshot(root)).toEqual(before);
  });

  it('status on a fresh home is strictly read-only and makes no calls', async () => {
    const before = snapshot(root);
    expect(await run(['--status', '--json'], { ...base(), fetch: fakeFetch(async () => { throw new Error('network'); }), worker: { runner: () => { throw new Error('service'); } } })).toBe(3);
    expect(snapshot(root)).toEqual(before);
    expect(fs.existsSync(setupFilePath(home))).toBe(false);
  });

  it('status observes malformed membership as unavailable instead of missing', async () => {
    const file = deploymentPath(URL, home);
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, '{}', { mode: 0o600 });
    const before = snapshot(home);
    expect(await run(['--status', '--join', URL, '--json'], base())).toBe(4);
    expect(lines.join('\n')).toContain('unavailable');
    expect(snapshot(home)).toEqual(before);
  });

  it('remote runner status neither rotates credentials nor writes local records or Deployment telemetry', async () => {
    await enrolledBeforeInstall(home, URL);
    const before = snapshot(home);
    const calls: string[] = [];
    expect(await run(['--status', '--runner', URL, '--runner-service', 'skip', '--check-remote'], { ...base(), fetch: fakeFetch(async (input, init) => {
      calls.push(new globalThis.URL(new Request(input, init).url).pathname);
      return configuredFetch(input, init);
    }) })).toBe(0);
    expect(calls).toEqual(['/health']);
    expect(lines.join('\n')).toContain('runner contact writes Deployment telemetry');
    expect(snapshot(home)).toEqual(before);
  });

  it('a changed fingerprint re-asks even with --yes and refuses with no terminal', async () => {
    const file = readSetupFile(home);
    const opts = { home, file, id: 'service', plan: { binary: '/first', home, unit: 'fixture' }, question: 'Install?', ask: async () => null, out: (line: string) => lines.push(line), yes: true };
    await consentToPlan(opts);
    const first = snapshot(home);
    await expect(consentToPlan({ ...opts, plan: { ...opts.plan, binary: '/second' } })).rejects.toThrow('changed plans require fresh consent');
    expect(snapshot(home)).toEqual(first);
    let asked = 0;
    await consentToPlan({ ...opts, plan: { ...opts.plan, binary: '/second' }, ask: async () => { asked++; return 'yes'; } });
    expect(asked).toBe(1);
    expect(readSetupFile(home).consented.service).toBe(planFingerprint({ ...opts.plan, binary: '/second' }));
  });

  it('canonical fingerprints ignore key order, and answers reject completion or secrets', () => {
    expect(planFingerprint({ url: URL, nested: { b: 2, a: 1 } })).toBe(planFingerprint({ nested: { a: 1, b: 2 }, url: URL }));
    const file = readSetupFile(home);
    expect(() => saveSetupFile(home, { ...file, token: 'secret' } as never)).toThrow();
    saveSetupFile(home, { ...file, answers: { role: 'join', url: URL } });
    expect(fs.statSync(setupFilePath(home)).mode & 0o777).toBe(0o600);
  });

  for (const [state, owner, deferred] of [
    ['none', undefined, false], ['unmoved', undefined, true], ['changed', undefined, true],
    ['needs-destination', undefined, true], ['needs-destination', 'unit', true], ['needs-destination', 'registration', true],
    ['handover-pending', undefined, true], ['handover-pending', 'unit', true], ['handover-pending', 'registration', true],
    ['partial', undefined, true], ['moved', undefined, false], ['unavailable', undefined, false],
  ] as const) it(`typed migration ${state} ${owner ?? 'without legacy capture'} is observed read-only and ${deferred ? 'defers' : 'admits'} setup`, async () => {
    const fixture = migrationFixture(state, owner);
    const observed = legacyMigrationState(home);
    expect(observed.state).toBe(state);
    expect(observed.legacyOwnsCapture === true).toBe(owner !== undefined);
    const entry = { version: 2, serverUrl: URL, token: 'x'.repeat(43), machineId: 'fixture', joinedAt: 1, updatedAt: 1, root: project, projectId: 'proj_capture' };
    writeRegistryEntry(entry, { mycoHome: home });
    const args = ['--join', URL, '--root', project, '--no-agents', '--no-runner', '--no-cutover'];
    const before = snapshot(root);
    expect(await run(['--status', '--json', ...args], base())).toBe(state === 'unavailable' ? 4 : deferred ? 3 : 0);
    const facts = JSON.parse(lines.at(-1)!).observations as Awaited<ReturnType<typeof observeSetup>>;
    const legacy = facts.find(fact => fact.id === 'legacy');
    expect(legacy?.state).toBe(state === 'unavailable' ? 'unavailable' : deferred ? 'incomplete' : 'complete');
    expect(legacy?.detail).toContain(state);
    if (state === 'changed' && observed.state === 'changed') expect(legacy?.detail).toContain(observed.warning);
    if (state === 'unavailable') {
      expect(legacy?.scope).toBe(fixture.record);
      expect(legacy?.detail).toContain(fixture.record);
    }
    expect(snapshot(root)).toEqual(before);
    lines = [];
    const calls: string[] = [];
    expect(await run(args, { ...base(), fetch: fakeFetch(async (input, init) => {
      calls.push(new globalThis.URL(new Request(input, init).url).pathname);
      return configuredFetch(input, init);
    }) })).toBe(deferred || state === 'unavailable' ? 2 : 0);
    if (deferred || state === 'unavailable') {
      if (state === 'unavailable') expect(calls).toEqual([]);
      expect(errors.join('\n')).toContain(state === 'unavailable' ? fixture.record : 'migration remains pending');
      if (state === 'changed') expect(lines.join('\n')).toContain('Keep the 1.4 files');
    } else {
      expect(calls.length).toBeGreaterThan(0);
      expect(lines.filter(line => line.includes('confirm where each project went'))).toHaveLength(0);
    }
  });

  it('legacy detection never executes a binary when remote observation fails', async () => {
    const legacy = legacyFixtureHome(path.join(root, 'legacy'));
    const sentinel = path.join(root, 'executed-legacy');
    fs.writeFileSync(legacy.binary, `#!/bin/sh\ntouch '${sentinel}'\n`, { mode: 0o755 });
    fs.chmodSync(legacy.binary, 0o755);
    expect(await run(['--join', URL, '--no-agents', '--no-runner'], { ...base(), mycoHome: legacy.mycoHome, fetch: fakeFetch(async () => { throw new Error('must defer before remote flow'); }) })).toBe(2);
    expect(lines.join('\n')).toContain('Myco 1.4 sources found');
    expect(fs.existsSync(sentinel)).toBe(false);
  });

  it('observes a different project destination without changing it', async () => {
    const server = await deployment('d1-adapter');
    expect(await run(['--join', URL, '--project', 'proj_1', '--no-agents', '--no-runner'], { ...base(), fetch: server.fetchImpl, sleep: async () => {}, loginDeps: { machineId: 'binding-machine' } })).toBe(0);
    const before = snapshot(home);
    const observations = await observeSetup(home, { role: 'join', url: 'https://other.invalid', root: project }, base());
    expect(observations.find((fact) => fact.id === 'project')?.detail).toContain('bound-elsewhere');
    expect(snapshot(home)).toEqual(before);
  });
});
