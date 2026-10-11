import { describe, expect, it } from 'bun:test';
import { CAPABILITY_ON_SQL, enabledCapabilities, PROJECT_CAPABILITIES, settingsWriter } from '@myco-server-worker/core/settings.js';
import { sqliteEnv } from './helpers/fixtures.js';

import { ensureMember } from '@myco-server-worker/auth/enrollment.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { claimNextRun, dispatchTask, prepareDispatch } from '@myco-server-worker/core/harness.js';
import { projectRepositories } from '@myco-server-worker/core/repositories.js';
import { deploymentSecretStore } from '@myco-server-worker/core/secrets.js';
import { decideTask, readScheduleFacts, runScheduledTasks } from '@myco-server-worker/core/scheduled-tasks.js';
import type { TaskSchedule } from '@myco-server-worker/core/jobs.js';
import { EXTRACTION_TASK, MAP_TASK, SEEDING_TASK, TITLING_TASK } from '@myco-server-worker/core/task-catalogue.js';
import { CONTACT_RECENT_MS, recordWorkerContact } from '@myco-server-worker/core/worker-contacts.js';
import { WORKER_CAPABILITIES } from '@goondocks/myco-shared/repository';
import { offeredHarness } from './helpers/offered-harness.js';
import { legacyWorker } from './helpers/worker-principal.js';

const NOW = 1_800_000_000_000;
const OFFERED = [offeredHarness('claude-code')];

describe('project capability defaults across readers', () => {
  it('agrees on absent, explicit off and explicit on across single, dashboard, schedule and atomic reads', async () => {
    const { db, sqlite } = sqliteEnv();
    const writer = settingsWriter(db);
    for (const state of [undefined, false, true]) {
      if (state !== undefined) {
        for (const capability of PROJECT_CAPABILITIES) await writer.setCapability('proj_1', capability, state, 'test', 1);
      }
      const expected = state !== false;
      expect(await writer.capabilities('proj_1')).toEqual({ cortex: expected, canopy: expected, vault_evolution: expected });
      for (const capability of PROJECT_CAPABILITIES) {
        expect(await writer.capabilityEnabled('proj_1', capability)).toBe(expected);
        expect(await db.prepare(`SELECT ${CAPABILITY_ON_SQL} AS enabled`).bind('proj_1', capability).first<{ enabled: number }>())
          .toEqual({ enabled: expected ? 1 : 0 });
      }
      for (const projectId of [undefined, 'proj_1']) {
        const reader = enabledCapabilities(db, PROJECT_CAPABILITIES, projectId);
        const rows = reader.read((await reader.statement.all()).results as Array<Record<string, unknown>>);
        expect(rows.filter((row) => row.projectId === 'proj_1').map((row) => row.capability).sort())
          .toEqual(expected ? [...PROJECT_CAPABILITIES].sort() : []);
      }
      expect(await writer.capabilities('proj_2')).toEqual({ cortex: true, canopy: true, vault_evolution: true });
    }
    expect(sqlite.query('SELECT capability, enabled FROM project_capabilities WHERE project_id = ? ORDER BY capability').all('proj_1'))
      .toEqual([...PROJECT_CAPABILITIES].sort().map((capability) => ({ capability, enabled: 1 })));
  });
  it('never admits archived Projects, with absent rows or explicit on rows, through any capability reader', async () => {
    const { db, sqlite, serverEnv } = sqliteEnv();
    const writer = settingsWriter(db);
    try {
      sqlite.run("UPDATE projects SET archived_at = ? WHERE project_id = 'proj_1'", [NOW]);
      for (const explicit of [false, true]) {
        if (explicit) for (const capability of PROJECT_CAPABILITIES) await writer.setCapability('proj_1', capability, true, 'test', NOW);
        expect(await writer.capabilities('proj_1')).toEqual({ cortex: false, canopy: false, vault_evolution: false });
        for (const capability of PROJECT_CAPABILITIES) {
          expect(await writer.capabilityEnabled('proj_1', capability)).toBe(false);
          expect(await db.prepare(`SELECT ${CAPABILITY_ON_SQL} AS enabled`).bind('proj_1', capability).first<{ enabled: number }>())
            .toEqual({ enabled: 0 });
        }
        for (const projectId of [undefined, 'proj_1']) {
          const reader = enabledCapabilities(db, PROJECT_CAPABILITIES, projectId);
          expect(reader.read((await reader.statement.all()).results as Array<Record<string, unknown>>)
            .filter((row) => row.projectId === 'proj_1')).toEqual([]);
        }
        const facts = await readScheduleFacts(serverEnv, [MAP_TASK, EXTRACTION_TASK], NOW, 'proj_1');
        expect([...facts.capabilities]).toEqual([]);
      }
      sqlite.run("UPDATE projects SET archived_at = NULL WHERE project_id = 'proj_1'");
      expect(await writer.capabilities('proj_1')).toEqual({ cortex: true, canopy: true, vault_evolution: true });
    } finally { sqlite.close(); }
  });

});

describe('default-on task enforcement', () => {
  it('admits extraction and seeding with no rows, and an explicit Learning opt-out stops new and queued work', async () => {
    const { db, sqlite, serverEnv } = sqliteEnv({ workerLogin: true });
    try {
      await projectRepositories(db, deploymentSecretStore(db, serverEnv.wrappingKey))
        .save('proj_1', { url: 'https://example.test/team/repo.git', branch: 'main', revision: null }, 'test', NOW);
      await ensureMember(db, 'mem_worker', NOW, 'admin', 'test');
      const credential = await issueMemberToken(db, { memberId: 'mem_worker', machineId: 'm1' }, NOW);
      for (const task of [EXTRACTION_TASK, SEEDING_TASK]) {
        expect(await prepareDispatch(serverEnv, task, 'proj_1')).toMatchObject({ ok: true });
        expect(await dispatchTask(serverEnv, task, 'proj_1', { serverUrl: 'https://s', actor: 'test' }, NOW))
          .toMatchObject({ dispatched: true, queued: true });
      }
      await settingsWriter(db).setCapability('proj_1', 'vault_evolution', false, 'test', NOW);
      for (const task of [EXTRACTION_TASK, SEEDING_TASK]) {
        expect(await prepareDispatch(serverEnv, task, 'proj_1')).toEqual({ ok: false, refusal: 'capability_off', capability: 'vault_evolution' });
        expect(await claimNextRun(serverEnv, { principal: legacyWorker(credential.tokenId, 'm1'), harnesses: OFFERED, capabilities: WORKER_CAPABILITIES, now: NOW + 1 }))
          .toMatchObject({ claimed: false });
      }
      expect(sqlite.query('SELECT task, status, run_context AS context FROM agent_runs ORDER BY task').all())
        .toEqual([EXTRACTION_TASK, SEEDING_TASK].sort().map((task) => ({ task, status: 'skipped', context: JSON.stringify({ reason: 'capability_off' }) })));
      expect(await prepareDispatch(serverEnv, TITLING_TASK, 'proj_1')).toMatchObject({ ok: true });
    } finally { sqlite.close(); }
  });

  it('claims a default-on code-map through atomic admission without adding a capability row', async () => {
    const { db, sqlite, serverEnv } = sqliteEnv({ workerLogin: true });
    try {
      await projectRepositories(db, deploymentSecretStore(db, serverEnv.wrappingKey))
        .save('proj_1', { url: 'https://example.test/team/repo.git', branch: 'main', revision: null }, 'test', NOW);
      await ensureMember(db, 'mem_worker', NOW, 'admin', 'test');
      const credential = await issueMemberToken(db, { memberId: 'mem_worker', machineId: 'm1' }, NOW);
      expect(await dispatchTask(serverEnv, MAP_TASK, 'proj_1', { serverUrl: 'https://s', actor: 'test' }, NOW))
        .toMatchObject({ dispatched: true, queued: true });
      expect(await claimNextRun(serverEnv, { principal: legacyWorker(credential.tokenId, 'm1'), harnesses: OFFERED, capabilities: WORKER_CAPABILITIES, now: NOW + 1 }))
        .toMatchObject({ claimed: true, run: { task: MAP_TASK } });
      expect(sqlite.query('SELECT COUNT(*) AS n FROM project_capabilities').get()).toEqual({ n: 0 });
    } finally { sqlite.close(); }
  });

  it('refuses archive and opt-out races at the atomic queue write for code-map and capture tasks', async () => {
    for (const [task, change] of [[MAP_TASK, 'archive'], [MAP_TASK, 'off'], [TITLING_TASK, 'archive']] as const) {
      const { db, sqlite, serverEnv } = sqliteEnv({ workerLogin: true });
      try {
        await projectRepositories(db, deploymentSecretStore(db, serverEnv.wrappingKey))
          .save('proj_1', { url: 'https://example.test/team/repo.git', branch: 'main', revision: null }, 'test', NOW);
        let changed = false;
        const interleaved = {
          ...serverEnv,
          db: {
            prepare: (sql: string) => {
              if (!changed && sql.startsWith('INSERT INTO agent_runs') && sql.includes("'queued'")) {
                changed = true;
                if (change === 'archive') sqlite.run("UPDATE projects SET archived_at=? WHERE project_id='proj_1'", [NOW]);
                else sqlite.run("INSERT INTO project_capabilities (project_id, capability, enabled, updated_at, updated_by) VALUES ('proj_1', 'canopy', 0, ?, 'test')", [NOW]);
              }
              return db.prepare(sql);
            },
            batch: db.batch,
          },
        };
        expect(await dispatchTask(interleaved, task, 'proj_1', { serverUrl: 'https://s', actor: 'test' }, NOW))
          .toEqual(change === 'archive' ? { dispatched: false, refusal: 'unknown_project' } : { dispatched: false, refusal: 'capability_off', capability: 'canopy' });
        expect(changed).toBe(true);
        expect(sqlite.query('SELECT COUNT(*) AS n FROM agent_runs').get()).toEqual({ n: 0 });
      } finally { sqlite.close(); }
    }
  });

  it('does not schedule archived Projects or claim their already queued default-on work', async () => {
    const { db, sqlite, serverEnv } = sqliteEnv({ workerLogin: true });
    try {
      await projectRepositories(db, deploymentSecretStore(db, serverEnv.wrappingKey))
        .save('proj_1', { url: 'https://example.test/team/repo.git', branch: 'main', revision: null }, 'test', NOW);
      await ensureMember(db, 'mem_worker', NOW, 'admin', 'test');
      const credential = await issueMemberToken(db, { memberId: 'mem_worker', machineId: 'm1' }, NOW);
      await recordWorkerContact(db, { credentialId: credential.tokenId, machineId: 'm1', offers: OFFERED, capabilities: [...WORKER_CAPABILITIES], now: NOW });
      const writer = settingsWriter(db);
      await writer.setLeaf('agent.scheduled_tasks_enabled', true, 'test', NOW);
      await writer.setLeaf('cortex.canopy.refresh.background_enabled', true, 'test', NOW);
      sqlite.run("INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at) VALUES ('proj_1', 's_archive', 'm1', ?, ?, ?)", [credential.tokenId, NOW, NOW]);
      expect(await dispatchTask(serverEnv, MAP_TASK, 'proj_1', { serverUrl: 'https://s', actor: 'test' }, NOW)).toMatchObject({ dispatched: true });
      sqlite.run('UPDATE projects SET archived_at = ?', [NOW]);
      expect(await runScheduledTasks(serverEnv, 'sleep', NOW + 1, 'https://s')).toEqual({ dispatched: 0, skipped: 0 });
      expect(await claimNextRun(serverEnv, { principal: legacyWorker(credential.tokenId, 'm1'), harnesses: OFFERED, capabilities: WORKER_CAPABILITIES, now: NOW + 1 })).toMatchObject({ claimed: false });
      expect(sqlite.query('SELECT status FROM agent_runs').all()).toEqual([{ status: 'skipped' }]);
      for (const task of [EXTRACTION_TASK, SEEDING_TASK, MAP_TASK, TITLING_TASK]) {
        expect(await prepareDispatch(serverEnv, task, 'proj_1')).toMatchObject({ ok: false, refusal: 'unknown_project' });
      }
    } finally { sqlite.close(); }
  });

  it('skips an archived title at the queue head and claims later live work', async () => {
    const { db, sqlite, serverEnv } = sqliteEnv({ workerLogin: true });
    try {
      await ensureMember(db, 'mem_worker', NOW, 'admin', 'test');
      const credential = await issueMemberToken(db, { memberId: 'mem_worker', machineId: 'm1' }, NOW);
      for (const projectId of ['proj_1', 'proj_2']) {
        sqlite.run("INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at) VALUES (?, ?, 'm1', ?, ?, ?)", [projectId, 's_' + projectId, credential.tokenId, NOW, NOW]);
        expect(await dispatchTask(serverEnv, TITLING_TASK, projectId, { serverUrl: 'https://s', actor: 'test', params: { session_id: 's_' + projectId, mode: 'claim' } }, NOW))
          .toMatchObject({ dispatched: true, queued: true });
      }
      sqlite.run("UPDATE projects SET archived_at=? WHERE project_id='proj_1'", [NOW]);
      expect(await claimNextRun(serverEnv, { principal: legacyWorker(credential.tokenId, 'm1'), harnesses: OFFERED, capabilities: WORKER_CAPABILITIES, now: NOW + 1 }))
        .toMatchObject({ claimed: true, run: { projectId: 'proj_2' } });
      expect(sqlite.query("SELECT status FROM agent_runs WHERE project_id='proj_1'").get()).toEqual({ status: 'skipped' });
    } finally { sqlite.close(); }
  });

  it('schedules a default-on code map only with repository access and a recent capable worker, retaining ceilings and overlap', async () => {
    const { db, sqlite, serverEnv } = sqliteEnv({ workerLogin: true });
    const schedule = { intervalSeconds: 60, runIn: ['sleep'], overlap: 'skip', maxRunsPerDay: 1 } satisfies TaskSchedule;
    const leaves = { activeWindowDays: 10, coldThresholdDays: 10 };
    const decide = (now = NOW) => decideTask(serverEnv, 'proj_1', NOW, MAP_TASK, schedule, 'sleep', leaves, now);
    try {
      expect(await decide()).toBe('repository_missing');
      await projectRepositories(db, deploymentSecretStore(db, serverEnv.wrappingKey))
        .save('proj_1', { url: 'https://example.test/team/repo.git', branch: 'main', revision: null }, 'test', NOW);
      expect(await decide()).toBe('worker_unavailable');
      sqlite.run("UPDATE project_repositories SET secret_slot = 'repository:missing', username='test' WHERE project_id='proj_1'");
      expect(await decide()).toBe('repository_unavailable');
      sqlite.run("UPDATE project_repositories SET secret_slot=NULL, username=NULL WHERE project_id='proj_1'");
      await ensureMember(db, 'mem_worker', NOW, 'admin', 'test');
      const credential = await issueMemberToken(db, { memberId: 'mem_worker', machineId: 'm1' }, NOW);
      const report = (capabilities: string[], authenticated = true, now = NOW) => recordWorkerContact(db, {
        credentialId: credential.tokenId, machineId: 'm1', offers: OFFERED.map((offer) => ({ ...offer, authenticated })), capabilities, now,
      });
      await report([]);
      expect(await decide()).toBe('worker_unavailable');
      await report(['repository-checkout']);
      expect(await decide()).toBe('worker_unavailable');
      await report([...WORKER_CAPABILITIES], false);
      expect(await decide()).toBe('worker_unavailable');
      await report([...WORKER_CAPABILITIES]);
      expect(await decide()).toBeNull();
      expect(await decide(NOW + CONTACT_RECENT_MS + 1)).toBe('worker_unavailable');
      await settingsWriter(db).setCapability('proj_1', 'canopy', false, 'test', NOW);
      expect(await decide()).toBe('capability_off');
      await settingsWriter(db).setCapability('proj_1', 'canopy', true, 'test', NOW);
      expect(await dispatchTask(serverEnv, MAP_TASK, 'proj_1', { serverUrl: 'https://s', actor: 'clock' }, NOW))
        .toMatchObject({ dispatched: true });
      expect(await decide()).toBe('already_running');
      sqlite.run("UPDATE agent_runs SET status='completed', completed_at=? WHERE project_id='proj_1'", [NOW]);
      expect(await decide(NOW + 61_000)).toBe('max_runs_per_day');
    } finally { sqlite.close(); }
  });
});
