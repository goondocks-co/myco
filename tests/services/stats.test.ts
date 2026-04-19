import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDatabase, closeDatabase, getDatabase } from '@myco/db/client.js';
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
import { markEmbedded } from '@myco/db/queries/embeddings.js';
import { gatherStats } from '@myco/services/stats.js';

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

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-stats-'));
    vaultDir = path.join(tempDir, '.myco');
    fs.mkdirSync(vaultDir, { recursive: true });

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

    fs.writeFileSync(
      path.join(vaultDir, 'daemon.json'),
      JSON.stringify({
        pid: process.pid,
        port: 19200,
        version: '0.0.0-test',
        started: new Date(Date.now() - 5_000).toISOString(),
      }),
      'utf-8',
    );

    const stats = gatherStats(vaultDir, { active_sessions: ['sess-1', 'sess-2'] });

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
});
