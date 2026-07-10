import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDatabase, closeDatabase, getDatabase, openDatabase } from '@myco/db/client.js';
import { createSchema } from '@myco/db/schema.js';
import { saveConfig } from '@myco/config/loader.js';
import { MycoConfigSchema } from '@myco/config/schema.js';
import { registerAgent } from '@myco/db/queries/agents.js';
import { upsertSession } from '@myco/db/queries/sessions.js';
import { insertBatch } from '@myco/db/queries/batches.js';
import { insertSpore } from '@myco/db/queries/spores.js';
import { upsertPlan } from '@myco/db/queries/plans.js';
import { insertRun } from '@myco/db/queries/runs.js';
import { upsertDigestExtract } from '@myco/db/queries/digest-extracts.js';
import { ALL_PROJECTS_SCOPE, projectScope, type GroveProjectId } from '@myco/grove/ids.js';
import { markEmbedded } from '@myco/db/queries/embeddings.js';
import { gatherStats } from '@myco/services/stats.js';
import { resolveServiceDaemonStatePath } from '@myco/grove/paths.js';
import { sandboxMycoHome } from '../helpers/myco-home-sandbox.js';

const AGENT_ID = 'stats-agent';

const epochNow = () => Math.floor(Date.now() / 1000);

function insertArtifact(id: string, content: string | null, createdAt: number): void {
  const db = getDatabase();
  db.prepare(
    `INSERT INTO artifacts (id, artifact_type, source_path, title, content, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, 'file', '/tmp/test', 'Test Artifact', content, createdAt);
}

describe('gatherStats', () => {
  let tempDir: string;
  let vaultDir: string;
  let sandbox: ReturnType<typeof sandboxMycoHome>;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-stats-'));
    vaultDir = path.join(tempDir, '.myco');
    fs.mkdirSync(vaultDir, { recursive: true });
    // The daemon-metadata assertions below write a fixture daemon.json via
    // resolveServiceDaemonStatePath(); the sandbox keeps it out of the
    // machine's real ~/.myco.
    sandbox = sandboxMycoHome('myco-stats-home-');

    saveConfig(vaultDir, MycoConfigSchema.parse({
      version: 3,
      embedding: {
        provider: 'ollama',
        model: 'bge-m3',
      },
    }));

    const db = initDatabase(path.join(vaultDir, 'myco.db'));
    createSchema(db);
  });

  afterEach(() => {
    sandbox.restore();
    closeDatabase();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('summarizes vault counts, embedding queue state, digest state, and daemon metadata', () => {
    const now = epochNow();

    registerAgent({ id: AGENT_ID, name: 'Stats Agent', created_at: now });
    upsertSession({
      id: 'sess-1',
      agent: 'codex',
      started_at: now,
      created_at: now,
      summary: 'Session summary for embeddings',
    });
    insertBatch({
      session_id: 'sess-1',
      created_at: now,
      user_prompt: 'Summarize the current work',
    });
    insertSpore({
      id: 'spore-1',
      agent_id: AGENT_ID,
      observation_type: 'gotcha',
      content: 'A useful gotcha',
      created_at: now,
    });
    upsertPlan({
      id: 'plan-1',
      logical_key: 'session:sess-1:key:primary',
      session_id: 'sess-1',
      title: 'Primary Plan',
      content: 'Plan content',
      created_at: now,
    });
    insertArtifact('artifact-1', 'Artifact content', now);
    insertRun({
      id: 'run-1',
      agent_id: AGENT_ID,
      task: 'digest',
      status: 'completed',
      started_at: now - 10,
      completed_at: now,
    });
    upsertDigestExtract({
      agent_id: AGENT_ID,
      tier: 5000,
      content: 'Digest body',
      generated_at: now,
    });

    markEmbedded('sessions', 'sess-1');

    const statePath = resolveServiceDaemonStatePath();
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        pid: process.pid,
        port: 19200,
        version: '0.0.0-test',
        started: new Date(Date.now() - 5_000).toISOString(),
      }),
      'utf-8',
    );

    const stats = gatherStats(vaultDir, { active_sessions: ['sess-1', 'sess-2'], scope: ALL_PROJECTS_SCOPE });

    expect(stats.vault.path).toBe(vaultDir);
    expect(stats.vault.name).toBe(path.basename(tempDir));
    expect(stats.vault.session_count).toBe(1);
    expect(stats.vault.batch_count).toBe(1);
    expect(stats.vault.spore_count).toBe(1);
    expect(stats.vault.plan_count).toBe(1);
    expect(stats.vault.artifact_count).toBe(1);
    expect(stats.vault.entity_count).toBe(0);
    expect(stats.vault.edge_count).toBe(0);

    expect(stats.embedding.provider).toBe('ollama');
    expect(stats.embedding.model).toBe('bge-m3');
    expect(stats.embedding.queue_depth).toBe(3);
    expect(stats.embedding.embedded_count).toBe(1);
    expect(stats.embedding.total_embeddable).toBe(4);

    expect(stats.agent.last_run_status).toBe('completed');
    expect(stats.agent.total_runs).toBe(1);
    expect(stats.unprocessed_batches).toBe(1);

    expect(stats.digest.freshest_tier).toBe(5000);
    expect(stats.digest.tiers_available).toEqual([5000]);
    expect(stats.digest.generated_at).toBe(now);

    expect(stats.daemon.pid).toBe(process.pid);
    expect(stats.daemon.port).toBe(19200);
    expect(stats.daemon.version).toBe('0.0.0-test');
    expect(stats.daemon.uptime_seconds).toBeGreaterThan(0);
    expect(stats.daemon.active_sessions).toEqual(['sess-1', 'sess-2']);
  });

  it('reports last_run_at from a resumed run\'s CURRENT-attempt clock, not its original dispatch time', () => {
    const now = epochNow();
    const originalDispatch = now - 10_000; // T0: resumed run's original dispatch, long ago
    const resumeTime = now - 100; // T2: resumed run's most recent attempt — the true recency signal
    const freshDispatch = now - 5_000; // T1: a fresh (never-resumed) run dispatched after T0 but before T2

    registerAgent({ id: AGENT_ID, name: 'Stats Agent', created_at: now });

    // Resumed old run: started_at preserves ORIGINAL dispatch (T0); resumed_at
    // is the per-attempt recency clock (T2) and must win the ORDER BY.
    insertRun({
      id: 'run-resumed',
      agent_id: AGENT_ID,
      task: 'digest',
      status: 'completed',
      started_at: originalDispatch,
      resumed_at: resumeTime,
      completed_at: resumeTime + 5,
    });

    // Fresh run: dispatched at T1, strictly between T0 and T2, never resumed.
    // A started_at-only sort would incorrectly pick this row over run-resumed.
    insertRun({
      id: 'run-fresh',
      agent_id: AGENT_ID,
      task: 'digest',
      status: 'failed',
      started_at: freshDispatch,
      completed_at: freshDispatch + 5,
    });

    const stats = gatherStats(vaultDir, { active_sessions: [], scope: ALL_PROJECTS_SCOPE });

    // last_run_at must reflect the resumed run's CURRENT-attempt clock (T2),
    // not its original dispatch (T0), and the resumed run — not the fresher
    // never-resumed dispatch (T1) — must be the row selected.
    expect(stats.agent.last_run_at).toBe(resumeTime);
    expect(stats.agent.last_run_status).toBe('completed');
  });

  it('degrades to machine+grove config when the project root does not exist on this machine (Team Host served project)', () => {
    // Team Host shape: the Grove row (and DB) are local but the checkout
    // lives on the member's machine — the vault dir names a path that does
    // not exist here. Stats are DB reads; config only supplies embedding
    // labels, so the read must succeed on the machine+grove merge instead
    // of throwing "myco.yaml not found" (the dashboard-landing 500).
    const servedVaultDir = path.join(tempDir, 'served-project', '.myco'); // never created
    const stats = gatherStats(servedVaultDir, { active_sessions: [], scope: ALL_PROJECTS_SCOPE });
    expect(stats.vault.path).toBe(servedVaultDir);
    // The project tier contributed nothing; embedding labels resolve from
    // machine-tier/schema defaults rather than the absent myco.yaml.
    expect(typeof stats.embedding.provider).toBe('string');
    expect(stats.vault.session_count).toBeGreaterThanOrEqual(0);
  });

  it('reads Grove-scoped counts from an explicit database path instead of the singleton', () => {
    const now = epochNow();
    const targetVaultDir = path.join(tempDir, 'target', '.myco');
    fs.mkdirSync(targetVaultDir, { recursive: true });
    saveConfig(targetVaultDir, MycoConfigSchema.parse({
      version: 3,
      embedding: {
        provider: 'ollama',
        model: 'bge-m3',
      },
    }));

    upsertSession({
      id: 'legacy-session',
      project_id: 'proj_target',
      agent: 'codex',
      started_at: now,
      created_at: now,
      status: 'active',
      summary: 'This row is in the singleton DB and must not be counted.',
    });

    const targetDbPath = path.join(targetVaultDir, 'myco.db');
    const targetDb = openDatabase(targetDbPath);
    try {
      createSchema(targetDb);
      targetDb.prepare(
        `INSERT INTO sessions (id, project_id, agent, started_at, created_at, status, summary)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run('target-session', 'proj_target', 'codex', now, now, 'active', 'Target session summary');
      targetDb.prepare(
        `INSERT INTO prompt_batches (project_id, session_id, user_prompt, processed, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run('proj_target', 'target-session', 'Target prompt', 0, now);
      targetDb.prepare(
        `INSERT INTO plans (id, project_id, logical_key, title, content, session_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run('target-plan', 'proj_target', 'target-plan', 'Target Plan', 'Target plan content', 'target-session', now);
    } finally {
      targetDb.close();
    }

    const stats = gatherStats(targetVaultDir, {
      active_sessions: ['legacy-session'],
      databasePath: targetDbPath,
      scope: projectScope('proj_target' as GroveProjectId),
    });

    expect(stats.vault.session_count).toBe(1);
    expect(stats.vault.batch_count).toBe(1);
    expect(stats.vault.plan_count).toBe(1);
    expect(stats.daemon.active_sessions).toEqual(['target-session']);
    expect(stats.embedding.queue_depth).toBe(2);
    expect(stats.embedding.total_embeddable).toBe(2);
  });
});
