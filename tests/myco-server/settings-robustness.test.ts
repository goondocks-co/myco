/**
 * The settings surface under load and failure, and the fallbacks that keep data: one read of the settings table per
 * answer; a policy that cannot resolve reports its leaves as unknown without costing a machine its own settings; an
 * embedding write that loses a race writes nothing; and retention, backup and map values the rule refuses keep
 * everything, clamp, or hold.
 */
import { describe, expect, it } from 'bun:test';
import worker from '@myco-server-worker/index.js';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import { settingsWriter } from '@myco-server-worker/core/settings.js';
import { runRetentionDays } from '@myco-server-worker/core/jobs-run.js';
import { scheduleLeaves } from '@myco-server-worker/core/scheduled-tasks.js';
import { backupRetentionPolicy, currentRetentionVictims } from '@myco-server-worker/core/backup-retention.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { memberPost, sqliteEnv } from './helpers/fixtures.js';
import { asOwner, OWNER_ENV } from './helpers/owner.js';

const WRAP = btoa('r'.repeat(32));
const NOW = Date.now();
const DAY = 86_400_000;
const json = async (response: Response): Promise<Record<string, unknown>> => response.json() as Promise<Record<string, unknown>>;
const store = (e: ReturnType<typeof sqliteEnv>, leaf: string, text: string) =>
  e.sqlite.run(`INSERT OR REPLACE INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES (?, ?, 1, 'historic')`, [leaf, text]);

describe('the settings answer', () => {
  it('reads the settings table once for every leaf it describes', async () => {
    const e = sqliteEnv();
    const bindings = { ...e.env, ...OWNER_ENV, SECRET_WRAP_KEY: { get: async () => WRAP } };
    e.executed.length = 0;
    expect((await worker.fetch(await asOwner(e.db, '/api/settings'), bindings)).status).toBe(200);
    expect(e.executed.filter((sql) => /\bFROM deployment_settings\b/.test(sql))).toHaveLength(1);
  });

  it('reports a policy that cannot resolve as unknown, and still answers a machine its own settings', async () => {
    const e = sqliteEnv({ onSql: (sql) => { if (/\bdeployment_secrets\b/.test(sql)) throw new Error('the key store is unreachable'); } });
    store(e, 'embedding.provider', '"openrouter"');
    e.sqlite.run(`INSERT OR IGNORE INTO machine_claims (machine_id, member_id, claimed_at) VALUES ('machine_1', 'mem_machine_1', ?)`, [NOW]);
    e.sqlite.run(`INSERT INTO machine_settings (machine_id, leaf, value, updated_at, updated_by) VALUES ('machine_1', 'capture.plan_dirs', '["docs/plans"]', 1, 'mem_machine_1')`);
    const bindings = { ...e.env, ...OWNER_ENV, SECRET_WRAP_KEY: { get: async () => WRAP } };
    const { token } = await issueMemberToken(e.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, NOW);
    const answer = await json(await worker.fetch(memberPost(token, {}, '/members/settings'), bindings));
    expect((answer.machine as { leaves: Record<string, unknown> }).leaves['capture.plan_dirs']).toEqual(['docs/plans']);
    const leaves = new Map((answer.leaves as Array<Record<string, unknown>>).map((row) => [row.leaf, row]));
    expect(leaves.get('embedding.provider')).toMatchObject({ state: 'unknown', reason: expect.stringContaining('the key store is unreachable') });
    expect(leaves.get('agent.scheduled_tasks_enabled')).toMatchObject({ state: 'active', effective: false });
    expect(answer.embedding).toBeNull();
  });
});

describe('an embedding write that loses a race', () => {
  it('writes nothing and answers a conflict when another write changed the choice after it was judged', async () => {
    const e = sqliteEnv();
    let raced = false;
    const racing: RelationalStore = {
      prepare: (sql) => e.db.prepare(sql),
      batch: async (statements) => {
        if (!raced) {
          raced = true;
          e.sqlite.run(`INSERT INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES ('embedding.provider', '"openrouter"', 7, 'mem_other')`);
        }
        return e.db.batch(statements);
      },
    };
    const result = await settingsWriter(racing, { target: 'cloudflare' }).setEmbedding({ provider: 'workers-ai', model: '@cf/baai/bge-large-en-v1.5' }, 'mem_machine_1', NOW);
    expect(result).toEqual({ applied: false, refusal: { reason: 'conflict', leaf: 'embedding.provider' } });
    expect(e.sqlite.query(`SELECT leaf, value, updated_by FROM deployment_settings WHERE leaf LIKE 'embedding.%' ORDER BY leaf`).all())
      .toEqual([{ leaf: 'embedding.provider', value: '"openrouter"', updated_by: 'mem_other' }]);
  });
});

describe('a stored value the rule refuses', () => {
  it('keeps task records longest rather than for the default', async () => {
    for (const [text, days] of [['400', 365], ['"forever"', 365], ['0.5', 1], ['45.9', 45]] as const) {
      const e = sqliteEnv();
      store(e, 'agent.run_retention_days', text);
      expect({ text, days: await runRetentionDays(e.serverEnv) }).toEqual({ text, days });
    }
  });

  it('keeps the code map refreshing at the nearest period the rule allows', async () => {
    for (const [text, seconds] of [['20000', 10_080 * 60], ['90.5', 90 * 60], ['"hourly"', 21_600]] as const) {
      const e = sqliteEnv();
      store(e, 'cortex.canopy.refresh.background_enabled', 'true');
      store(e, 'cortex.canopy.refresh.background_period_minutes', text);
      expect({ text, seconds: (await scheduleLeaves(e.serverEnv)).mapRefresh.intervalSeconds }).toEqual({ text, seconds });
    }
  });

  it('lets go of no manual export while either retention count is refused', async () => {
    for (const [leaf, text] of [['backup.retention.keep_daily', '3.5'], ['backup.retention.keep_weekly', '-1'], ['backup.retention.keep_daily', '"all"']] as const) {
      const e = sqliteEnv();
      for (let i = 0; i < 20; i++) {
        e.sqlite.run(`INSERT INTO backups (id, key, created_at, size_bytes, counts_json, schema_version, producer, pinned) VALUES (?, ?, ?, 1, '{}', 1, 'test', 0)`, [`b${i}`, `k${i}`, NOW - i * DAY]);
      }
      store(e, leaf, text);
      expect({ leaf, text, victims: (await currentRetentionVictims(e.db, await backupRetentionPolicy(e.db))).size }).toEqual({ leaf, text, victims: 0 });
    }
  });
});
