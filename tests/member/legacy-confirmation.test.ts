import { afterEach, beforeEach, expect, it, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runLegacyImport } from '@myco/member/legacy-import.js';
import { readVaultContent } from '@myco/member/legacy-backup.js';
import { memberRig, TEST_MACHINE_ID } from './helpers/server.js';
import { observeLegacyMigration } from '@myco/member/legacy-confirmation.js';
import { readCutoverState } from '@myco/member/legacy-migration.js';
import { writeDeploymentMembership, writeRegistryEntry } from '@myco/member/registry.js';
import { LEGACY_HISTORY_MAX_EVENTS, LEGACY_HISTORY_PATH } from '@goondocks/myco-shared/member-protocol';
import { legacyCaptureGuidance } from '@myco/cli/legacy-capture.js';
import { LifecycleLock } from '@myco/utils/lifecycle-lock.js';
import { bindSandboxChildHome } from '../../scripts/test-environment.mjs';

let root: string;
let restore: () => void;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-legacy-evidence-'));
  restore = bindSandboxChildHome(root, { MYCO_HOME: path.join(root, 'myco') });
});
afterEach(() => { restore(); fs.rmSync(root, { recursive: true, force: true }); });

for (const allConfirmed of [true, false]) it(`requires every bounded proof batch before backfilling a large source: ${allConfirmed}`, async () => {
  const home = path.join(root, 'myco');
  const folder = path.join(root, 'repo');
  const vault = path.join(home, 'groves', 'retained', 'myco.db');
  fs.mkdirSync(folder); fs.mkdirSync(path.dirname(vault), { recursive: true });
  const db = new Database(vault);
  db.exec(fs.readFileSync(new URL('../fixtures/legacy/vault-v76.sql', import.meta.url), 'utf8'));
  const count = LEGACY_HISTORY_MAX_EVENTS + 1;
  try {
    for (let index = 0; index < count; index++) db.run("INSERT INTO sessions (id, project_id, project_root, agent, started_at, ended_at, status, created_at) VALUES (?, 'proj_old', ?, 'claude-code', 1700000000, 1700000060, 'completed', 1700000000)", [`source-${index}`, folder]);
  } finally { db.close(); }
  const membership = { serverUrl: 'https://evidence.invalid', token: 'F'.repeat(43), machineId: 'fixture', joinedAt: 1, updatedAt: 1 };
  writeDeploymentMembership(membership, { mycoHome: home });
  writeRegistryEntry({ ...membership, version: 2, root: folder, projectId: 'proj_old' }, { mycoHome: home });
  const bytes = fs.readFileSync(vault);
  let batches = 0;
  const clock = Date.now();
  const time = spyOn(Date, 'now').mockImplementation(() => clock + batches * 4000);
  const result = await observeLegacyMigration(home, { fetch: async (input, init) => {
    expect(new URL(new Request(input, init).url).pathname).toBe(LEGACY_HISTORY_PATH);
    const { eventGroups } = JSON.parse(String(init?.body)) as { eventGroups: string[][] };
    expect(eventGroups.flat().length).toBeLessThanOrEqual(LEGACY_HISTORY_MAX_EVENTS);
    expect(readCutoverState(home).migrations).toBeUndefined();
    batches++;
    const confirmed = allConfirmed || batches === 1;
    return Response.json({ persisted: true, confirmed, ...(confirmed ? { eventIds: eventGroups.map(group => group[0]) } : {}) });
  } });
  time.mockRestore();
  expect(batches).toBe(allConfirmed ? 3 : 2);
  expect(result.state).toBe(allConfirmed ? 'partial' : 'unmoved');
  if (allConfirmed) expect(readCutoverState(home).migrations?.[vault]?.projects.proj_old?.evidence?.eventIds).toHaveLength(count);
  else expect(readCutoverState(home).migrations).toBeUndefined();
  expect(fs.readFileSync(vault)).toEqual(bytes);
});


for (const receipt of ['backup-only', 'absent'] as const) for (const refused of ['spores', 'lineage', 'plan', 'prompt', 'response', 'title', 'end', 'complete'] as const) it(refused === 'complete' ? `confirms offered records but leaves transcripts pending with an unattached plan: ${receipt}` : `keeps a manual import stopped at ${refused} unconfirmed with ${receipt} receipt`, async () => {
  const rig = await memberRig({ projectId: 'proj_partial' });
  const home = path.join(root, 'myco');
  const folder = path.join(root, 'repo');
  const vault = path.join(home, 'groves', 'retained', 'myco.db');
  fs.mkdirSync(folder); fs.mkdirSync(path.dirname(vault), { recursive: true });
  const db = new Database(vault);
  db.exec(fs.readFileSync(new URL('../fixtures/legacy/vault-v76.sql', import.meta.url), 'utf8'));
  db.run("INSERT INTO sessions (id, project_id, project_root, agent, started_at, ended_at, status, created_at) VALUES ('source-session', 'proj_partial', ?, 'claude-code', 1700000000, 1700000060, 'completed', 1700000000)", [folder]);
  db.run("INSERT INTO spores (id, project_id, agent_id, observation_type, status, content, created_at) VALUES ('spore-a', 'proj_partial', 'user', 'gotcha', 'obsolete', 'Retained fact', 1700000000)");
  if (refused === 'lineage') db.run("INSERT INTO resolution_events (id, project_id, agent_id, spore_id, action, reason, created_at) VALUES ('lineage-a', 'proj_partial', 'user', 'spore-a', 'obsolete', 'Retained reason', 1700000060)");
  if (refused === 'complete') db.run("INSERT INTO plans (id, project_id, logical_key, content, session_id, created_at, updated_at) VALUES ('unattached', 'proj_partial', 'key', '# Retained plan', NULL, 1700000000, 1700000060)");
  if (refused === 'plan') db.run("INSERT INTO plans (id, project_id, logical_key, status, title, content, session_id, created_at, updated_at) VALUES ('source-plan', 'proj_partial', 'key', 'active', 'Retained plan', '# Plan', 'source-session', 1700000000, 1700000060)");
  if (refused === 'prompt' || refused === 'response') db.run("INSERT INTO prompt_batches (id, project_id, session_id, user_prompt, response_summary, started_at, ended_at, created_at) VALUES ('source-prompt', 'proj_partial', 'source-session', 'Retained prompt', 'Retained response', 1700000000, 1700000060, 1700000000)");
  if (refused === 'title' || refused === 'end') db.run("UPDATE sessions SET title = 'Retained title' WHERE id = 'source-session'");
  db.close();
  const membership = { serverUrl: 'https://member-test.invalid', token: rig.token, tokenId: rig.tokenId, machineId: TEST_MACHINE_ID, joinedAt: 1, updatedAt: 1 };
  writeDeploymentMembership(membership, { mycoHome: home });
  writeRegistryEntry({ ...membership, version: 2, root: folder, projectId: 'proj_partial' }, { mycoHome: home });
  const bytes = fs.readFileSync(vault);
  try {
    const report = await runLegacyImport({ sources: [vault], project: 'proj_partial', serverUrl: membership.serverUrl }, {
      mycoHome: home, machineId: TEST_MACHINE_ID, sleep: async () => {},
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const route = new URL(request.url).pathname;
        const body = route === '/events' ? await request.clone().json() as { kind: string; payload?: { title?: string } } : null;
        const refuse = refused === 'spores' ? route.startsWith('/spores') : refused === 'lineage' ? route === '/spores/resolve'
          : refused === 'title' ? body?.payload?.title !== undefined : refused === 'end' ? body?.kind === 'session.end' && body.payload?.title === undefined : body?.kind === refused;
        return refuse
          ? Response.json({ persisted: false, code: 'parse', reason: 'fixture refuses history' }) : rig.fetch(request);
      },
    });
    expect(report.projects[0]?.sessions.fromVault).toBe(refused === 'spores' || refused === 'lineage' || refused === 'complete' ? 1 : 0);
    expect(rig.env.sqlite.query("SELECT COUNT(*) AS n FROM events WHERE project_id = 'proj_partial' AND kind = 'session.end'").get()).toMatchObject({ n: 1 });
    if (refused === 'complete') expect(report.projects[0]?.refusals).toEqual([]);
    else expect(report.projects[0]?.refusals.length).toBeGreaterThan(0);
    if (receipt === 'backup-only') {
      const copy = path.join(home, 'copy.db');
      fs.copyFileSync(vault, copy);
      fs.writeFileSync(path.join(home, 'member', 'cutover.json'), JSON.stringify({ backups: { [vault]: { copy, ...readVaultContent(copy), at: 1 } } }), { mode: 0o600 });
    }
    const observed = await observeLegacyMigration(home, { fetch: rig.fetch });
    expect(observed.state).toBe(refused === 'complete' ? 'partial' : receipt === 'backup-only' ? 'needs-destination' : 'unmoved');
    if (refused === 'complete') expect(readCutoverState(home).migrations?.[vault]?.projects.proj_partial).toMatchObject({ vault: { state: 'complete' }, evidence: { sporeIds: ['spore-a'] } });
    else { expect(observed.confirmation).toBe('not-found'); expect(readCutoverState(home).migrations).toBeUndefined(); }
    expect(readCutoverState(home).migrations?.[vault]?.projects.proj_partial?.transcripts).toBeUndefined();
    expect(fs.readFileSync(vault)).toEqual(bytes);
  } finally { rig.env.sqlite.close(); }
});


for (const outcome of ['unreachable', 'refused', 'route_missing', 'project-missing', 'busy', 'unauthorized', 'timeout'] as const) it(`names the next step for confirmation ${outcome}`, async () => {
  const home = path.join(root, 'myco');
  const vault = path.join(home, 'groves', 'retained', 'myco.db');
  const folder = path.join(root, 'repo');
  fs.mkdirSync(folder); fs.mkdirSync(path.dirname(vault), { recursive: true });
  const db = new Database(vault);
  db.exec(fs.readFileSync(new URL('../fixtures/legacy/vault-v76.sql', import.meta.url), 'utf8'));
  db.run("INSERT INTO sessions (id, project_id, project_root, agent, started_at, ended_at, status, created_at) VALUES ('source', 'proj_old', ?, 'claude-code', 1700000000, 1700000060, 'completed', 1700000000)", [folder]);
  db.close();
  const member = { serverUrl: 'https://evidence.invalid', token: 'F'.repeat(43), machineId: 'fixture', joinedAt: 1, updatedAt: 1 };
  writeDeploymentMembership(member, { mycoHome: home });
  writeRegistryEntry({ ...member, version: 2, root: folder, projectId: 'proj_old' }, { mycoHome: home });
  const lockFile = path.join(home, 'member', 'cutover.lock');
  fs.writeFileSync(lockFile, '');
  const held = outcome === 'busy' ? LifecycleLock.acquire(lockFile) : null;
  try {
    const result = await observeLegacyMigration(home, { fetch: async (_input, init) => {
      if (outcome === 'unreachable') throw new Error('offline');
      if (outcome === 'unauthorized') return new Response('revoked', { status: 401 });
      if (outcome === 'timeout') return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('fixture timed out')), { once: true }));
      if (outcome === 'busy') {
        const body = JSON.parse(String(init?.body)) as { eventGroups: string[][] };
        return Response.json({ persisted: true, confirmed: true, eventIds: body.eventGroups.flat(), sporeIds: [], lineageIds: [] });
      }
      return Response.json({ persisted: false, code: outcome === 'project-missing' ? 'no_project' : outcome, reason: 'fixture' });
    } });
    expect(result.confirmation).toBe(outcome === 'unauthorized' ? 'sign-in-required' : outcome === 'timeout' ? 'pending' : outcome === 'unreachable' ? 'unavailable' : (outcome === 'refused' || outcome === 'route_missing') ? 'update-required' : outcome);
    expect(legacyCaptureGuidance(result).hint?.toLowerCase()).toContain(outcome === 'unauthorized' ? 'myco login <link>' : outcome === 'timeout' ? 'will check again' : outcome === 'unreachable' ? 'online' : outcome === 'busy' ? 'another cutover is running' : outcome === 'project-missing' ? 'no longer on' : 'update the deployment');
    expect(readCutoverState(home).migrations).toBeUndefined();
  } finally { if (held?.acquired) held.lock.release(); }
}, 10_000);
