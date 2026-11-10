import { renderSetupStatus } from '@myco/cli/setup-status.js';
import { rootSlug } from '@myco/symbionts/transcript-attribution.js';
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { bindSandboxChildHome } from '../../scripts/test-environment.mjs';
import { run, parseSetupOptions } from '@myco/cli/setup.js';
import { run as login } from '@myco/cli/login.js';
import { resetMachineIdCache } from '@myco/machine-id.js';
import { runRunnerService } from '@myco/cli/runner-service.js';
import { executorServiceTarget } from '@myco/cli/worker-service.js';
import { homeReport } from '@myco/cli/member-doctor.js';
import { consentToPlan, cutoverConsentPlan, type SetupDeps } from '@myco/setup/steps.js';
import { observeSetup, setupExitCode } from '@myco/setup/observe.js';
import { planFingerprint, readSetupFile, saveSetupFile, setupFilePath } from '@myco/setup/answers.js';
import { readDeploymentMembership, readRegistryEntry, writeDeploymentMembership, writeRegistryEntry, registryEntryPath, deploymentPath, deploymentKeyFor, machineSettingsPath } from '@myco/member/registry.js';
import { legacyMigrationState, type LegacyMigrationState } from '@myco/member/legacy-migration.js';
import { legacyVaultStamp } from '@myco/member/legacy-sources.js';
import { readVaultContent } from '@myco/member/legacy-backup.js';
import { MemberSpool } from '@myco/member/spool.js';
import { LegacyLedger } from '@myco/member/legacy-ledger.js';
import { observeLegacyStrayHistory } from '@myco/member/legacy-strays.js';
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
import { URL, fakeFetch, freshJourney, snapshot, holdRunnerLock as bindRunnerLock } from './fixtures/journey-harness.js';

let root: string;
let home: string;
let project: string;
let lines: string[];
let errors: string[];
const closers: (() => void | Promise<void>)[] = [];
beforeEach(() => {
  ({ root, home, project, lines, errors } = freshJourney());
});
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  fs.rmSync(root, { recursive: true, force: true });
  process.exitCode = 0;
  resetMachineIdCache();
});
const base = (): SetupDeps => ({ mycoHome: home, cwd: project, ask: async () => null, agents: () => [], stdout: line => lines.push(line), stderr: line => errors.push(line) });
function holdRunnerLock(lockDir: string): void {
  bindRunnerLock(closers, lockDir);
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
        const titleId = legacyHistoryCompletionGroups(source, 'machine_1')[0]![1]!;
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

  it('names earlier stray history in guided preview, status and doctor', async () => {
    const fixture = await rig({ multi: true });
    const project = fixture.legacy.projects[1]!;
    const ledger = new LegacyLedger(home, LEGACY_URLS[0], project.id);
    ledger.append({ k: 'session', session: project.sessionId });
    const before = fs.readFileSync(ledger.file);
    expect({ code: await run(flags, fixture.deps), errors }).toEqual({ code: 0, errors: [] });
    const previewLines = lines.filter(line => line.includes('An earlier move also put'));
    expect(previewLines.length).toBeGreaterThan(0);
    const expected = `An earlier move also put ${path.basename(project.root)}'s history on ${LEGACY_URLS[0]} (it now goes to ${LEGACY_URLS[1]}). Myco leaves that copy alone; you can remove it from that Deployment. Run myco cutover --dismiss-earlier-copies once you have.`;
    expect(previewLines.every(line => line.trim() === expected)).toBe(true);
    const previewAt = lines.findIndex(line => line.includes('cutover preview (dry run)'));
    const executionAt = lines.findIndex(line => line.startsWith('Cutting over '));
    expect(previewAt).toBeGreaterThanOrEqual(0);
    expect(executionAt).toBeGreaterThan(previewAt);
    expect(lines.slice(previewAt, executionAt).filter(line => line.includes('An earlier move also put')).map(line => line.trim())).toEqual([expected]);
    lines = [];
    expect(await run(['--status'], fixture.deps)).toBe(0);
    expect(lines.filter(line => line.includes('An earlier move also put'))).toEqual([expected]);
    const doctor = await homeReport(home, { ...fixture.deps.cutoverDeps, cwd: root, fetch: fixture.deps.fetch, worker: { runner: () => { throw new Error('No service calls'); } } });
    expect(doctor.filter(check => check.detail.includes('An earlier move also put')).map(check => check.detail)).toEqual([expected]);
    expect(doctor.filter(check => check.detail.includes('An earlier move also put')).map(check => ({ status: check.status, fixable: check.fixable }))).toEqual([{ status: 'info', fixable: false }]);
    expect(fs.readFileSync(ledger.file)).toEqual(before);
  });

  it('dismisses earlier history across status, guided preview, cutover preview and doctor', async () => {
    const fixture = await rig({ multi: true });
    const project = fixture.legacy.projects[1]!;
    const ledger = new LegacyLedger(home, LEGACY_URLS[0], project.id);
    ledger.append({ k: 'session', session: project.sessionId });
    expect(await run(flags, fixture.deps)).toBe(0);
    const proofFile = path.join(home, 'member', 'cutover.json');
    const proof = fs.readFileSync(proofFile);
    const bytes = fs.readFileSync(ledger.file);
    lines = [];
    expect(await cutoverRun(['--dismiss-earlier-copies'], { ...fixture.deps.cutoverDeps, mycoHome: home,
      fetch: fakeFetch(async () => { throw new Error('Dismissal must not call a Deployment'); }),
      stdout: line => lines.push(line), stderr: line => errors.push(line),
    })).toBe(true);
    expect(lines.filter(line => line.startsWith('Dismissed'))).toHaveLength(1);
    expect(fs.readFileSync(ledger.file)).toEqual(bytes);
    expect(fs.readFileSync(proofFile)).toEqual(proof);
    lines = [];
    expect(await run(['--status'], fixture.deps)).toBe(0);
    expect(lines.join('\n')).not.toContain('An earlier move also put');
    const plan = planCutover(home, { homeDir: fixture.legacy.home, dryRun: true }, fixture.deps.cutoverDeps);
    expect(plan.strayHistory).toEqual([]);
    lines = [];
    expect((await runCutover(plan, { ...fixture.deps.cutoverDeps, stdout: line => lines.push(line), fetch: fixture.deps.fetch })).ok).toBe(true);
    expect(lines.join('\n')).not.toContain('An earlier move also put');
    lines = [];
    expect(await run(['--yes', '--cutover'], fixture.deps)).toBe(0);
    expect(lines.join('\n')).not.toContain('An earlier move also put');
    const doctor = await homeReport(home, { ...fixture.deps.cutoverDeps, cwd: root, fetch: fixture.deps.fetch,
      worker: { runner: () => { throw new Error('No service calls'); } },
    });
    expect(doctor.some(check => check.detail.includes('An earlier move also put'))).toBe(false);
  });

  for (const state of ['moved', 'none'] as const) for (const broken of ['membership', 'ledger'] as const) it(`keeps ${state} migration status when the earlier-copy ${broken} check is unavailable`, async () => {
    const fixture = await rig({ multi: true });
    const project = fixture.legacy.projects[1]!;
    new LegacyLedger(home, LEGACY_URLS[0], project.id).append({ k: 'session', session: project.sessionId });
    if (broken === 'membership') fs.writeFileSync(deploymentPath(LEGACY_URLS[0], home), '{');
    else {
      const dir = path.join(home, 'member', 'legacy');
      fs.renameSync(dir, `${dir}-retained`);
      fs.writeFileSync(dir, 'unreadable ledger directory');
    }
    const observations = await observeSetup(home, {}, { legacyHomeDir: fixture.legacy.home, legacyObserver: async () => ({ state }), agents: () => [], status: true });
    const migration = observations.find(fact => fact.id === 'legacy')!;
    expect(migration.state).toBe('complete');
    expect(migration.detail).toStartWith(state);
    expect(setupExitCode([migration])).toBe(0);
    expect(renderSetupStatus([migration]).join('\n')).toContain('Earlier moves could not be checked:');
    expect(renderSetupStatus([migration]).join('\n')).not.toContain('migration records could not be read');
  });

  it('keeps refused project placement out of the guided earlier-copy preview', async () => {
    const fixture = await rig({ multi: true });
    const project = fixture.legacy.projects[1]!;
    new LegacyLedger(home, LEGACY_URLS[0], project.id).append({ k: 'session', session: project.sessionId });
    fs.writeFileSync(path.join(home, 'member', 'cutover.json'), JSON.stringify({ backups: {}, migrations: {
      [fixture.legacy.vault]: { digest: 'earlier', size: 1, mtimeMs: 1, projects: {
        [project.id]: { destination: { serverUrl: LEGACY_URLS[0], key: deploymentKeyFor(LEGACY_URLS[0]) }, vault: { state: 'partial', at: 1 } },
      } },
    } }), { mode: 0o600 });
    expect(await run(flags, fixture.deps)).toBe(2);
    expect(errors.join('\n')).toContain('its receipt names');
    expect(lines.join('\n')).not.toContain('An earlier move also put');
  });

  it('surfaces an unreadable route in status and doctor before claiming where stray history goes', async () => {
    const fixture = await rig({ multi: true });
    const project = fixture.legacy.projects[1]!;
    new LegacyLedger(home, LEGACY_URLS[0], project.id).append({ k: 'session', session: project.sessionId });
    const binding = registryEntryPath(project.root, home);
    fs.writeFileSync(binding, '{');
    expect(() => observeLegacyStrayHistory(home, { homeDir: fixture.legacy.home })).toThrow('binding at');
    expect(await run(['--status'], fixture.deps)).toBe(4);
    expect(lines.join('\n')).toMatch(/binding at|Project routes could not all be read/);
    expect(lines.join('\n')).not.toContain('An earlier move also put');
    const doctor = await homeReport(home, { ...fixture.deps.cutoverDeps, cwd: root, fetch: fixture.deps.fetch, worker: { runner: () => { throw new Error('No service calls'); } } });
    expect(doctor.some(check => check.detail.includes('Earlier moves could not be checked:') && check.detail.includes('binding at'))).toBe(true);
    expect(doctor.some(check => check.detail.includes('An earlier move also put'))).toBe(false);
  });

  it('reports retained Deployment proof after its ledger is lost and the project moves elsewhere', async () => {
    const fixture = await rig({ secondMembership: true });
    const original = readDeploymentMembership(LEGACY_URLS[0], home)!;
    for (const project of fixture.legacy.projects) writeRegistryEntry({ ...original, version: 2, root: project.root, projectId: project.id }, { mycoHome: home });
    expect(await run(flags, fixture.deps)).toBe(0);
    const state = readCutoverState(home);
    fs.writeFileSync(path.join(home, 'member', 'cutover.json'), JSON.stringify({ backups: state.backups }));
    expect(await run(flags, fixture.deps)).toBe(0);
    const project = fixture.legacy.projects[1]!;
    expect(readCutoverState(home).migrations![fixture.legacy.vault]!.projects[project.id]!.evidence?.kind).toBe('deployment');
    fs.rmSync(new LegacyLedger(home, LEGACY_URLS[0], project.id).file);
    const membership = readDeploymentMembership(LEGACY_URLS[1], home)!;
    writeRegistryEntry({ ...membership, version: 2, root: project.root, projectId: project.id }, { mycoHome: home });
    const requests = fixture.calls.length;
    lines = [];
    expect({ code: await run(['--yes', '--route', `${project.id}=${LEGACY_URLS[1]}`], { ...fixture.deps, ask: async () => 'yes' }), errors }).toEqual({ code: 0, errors: [] });
    const expected = `An earlier move also put ${path.basename(project.root)}'s history on ${LEGACY_URLS[0]} (it now goes to ${LEGACY_URLS[1]}). Myco leaves that copy alone; you can remove it from that Deployment. Run myco cutover --dismiss-earlier-copies once you have.`;
    expect(lines.filter(line => line.includes('An earlier move also put')).every(line => line.trim() === expected)).toBe(true);
    expect(lines.some(line => line.trim() === expected)).toBe(true);
    expect(fixture.calls.slice(requests).filter(call => call.url === LEGACY_URLS[0] && call.route === '/import/legacy-history')).toEqual([]);
    lines = [];
    expect(await run(['--status'], fixture.deps)).toBe(0);
    expect(lines.filter(line => line.includes('An earlier move also put'))).toEqual([expected]);
  });

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
