import { Database } from 'bun:sqlite';
import { expect, it } from 'bun:test';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { dispatchLoad, recordTaskHolder } from '@myco-server-worker/core/runs.js';
import { embeddingSweep } from '@myco-server-worker/core/embedding/work-sweep.js';
import { sharedChecks } from '@myco-server-worker/ingest/projections.js';
import { kindSpec } from '@myco-server-worker/ingest/kinds.js';
import type { CaptureEnvelope } from '@myco-server-worker/ingest/envelope.js';
import { ensureMember } from '@myco-server-worker/auth/enrollment.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import { statementRecorder } from '../helpers/statement-recorder.js';
import { sqliteBudgetMeter } from './helpers/budget-meter.js';
import { uuid } from './helpers/fixtures.js';

const NOW = 1_800_000_000_000;
const SIZE = 5000;
const LOAD_LIMIT = 20;
const HOLDER_LIMIT = 50;
const SOURCE_PAGE_LIMIT = 512;
const MACHINE_LIMIT = 8;

it('bounds admission, holder changes, embedding pages and prompt ownership on both stores', async () => {
  const native = new Database(':memory:');
  const meter = sqliteBudgetMeter();
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true,
    script: 'export default {fetch(){return new Response(null)}}', compatibilityDate: '2026-08-01', d1Databases: ['DB'] }));
  try {
    const d1 = await mf.getD1Database('DB');
    for (const step of SCHEMA_STEPS) {
      for (const sql of step.statements) native.exec(sql);
      await d1.batch(step.statements.map(sql => d1.prepare(sql)));
    }
    for (const [target, db] of [['native', sqliteRelationalStore(native)], ['D1', d1]] as const) {
      await db.prepare("INSERT INTO projects(project_id,name,created_at) VALUES('project','Project',1)").run();
      await db.prepare("INSERT INTO agents(id,name,source,enabled,created_at) VALUES('agent','Agent','built-in',1,1)").run();
      await ensureMember(db, 'member', NOW, 'admin');
      const token = await issueMemberToken(db, { memberId: 'member', machineId: 'machine' }, NOW);
      const ids = JSON.stringify(Array.from({ length: SIZE }, (_, n) => n));
      await db.prepare(`INSERT INTO agent_runs(project_id,id,agent_id,task,status,origin,started_at,queued_at,held_by)
        SELECT 'project','done-'||value,'agent','title-summary','completed','automatic',1,1,NULL FROM json_each(?)`).bind(ids).run();
      await db.prepare(`INSERT INTO agent_runs(project_id,id,agent_id,task,status,origin,queued_at,held_by)
        SELECT 'project','queue-'||value,'agent','title-summary','queued','automatic',1,'worker' FROM json_each(?)`).bind(ids).run();
      await db.prepare(`INSERT INTO agent_runs(project_id,id,agent_id,task,status,origin,started_at,queued_at,held_by) VALUES
        ('project','live','agent','title-summary','running','automatic',?,1,NULL),
        ('project','held','agent','title-summary','queued','automatic',NULL,1,'budget'),
        ('project','profile','agent','title-summary','queued','automatic',NULL,1,'profile_unsupported:codex'),
        ('project','null','agent','title-summary','queued','automatic',NULL,1,NULL)`).bind(NOW).run();
      await db.prepare(`INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at,summary)
        SELECT 'project',printf('session-%05d',value),'machine',?,1,1,'A useful summary' FROM json_each(?)`).bind(token.tokenId, ids).run();
      await db.prepare(`INSERT INTO session_prompts(project_id,session_id,generation,prompt_id,ord,created_at)
        SELECT 'project',printf('session-%05d',value),1,printf('00000000-0000-7000-8000-%012d',value),1,1 FROM json_each(?)`).bind(ids).run();

      const check = async (label: string, limit: number, action: (db: RelationalStore) => Promise<unknown>, select: (sql: string) => boolean = () => true) => {
        const recorded = statementRecorder(db, { accounting: target === 'D1' ? 'd1' : 'native' });
        const snapshot = target === 'native' ? Database.deserialize(native.serialize()) : null;
        try {
          await action(recorded.db);
          const entries = recorded.statements.filter(entry => select(entry.sql));
          expect(entries.length).toBeGreaterThan(0);
          let rows = 0;
          const plans: string[] = [];
          for (const entry of entries) {
            const explain = `EXPLAIN QUERY PLAN ${entry.sql}`;
            const prepared = target === 'native' ? native.prepare(explain) : null;
            const plan = prepared === null
              ? (await db.prepare(explain).bind(...entry.binds).all<{ detail: string }>()).results.map(row => row.detail)
              : (prepared.all(...entry.binds as never[]) as { detail: string }[]).map(row => row.detail);
            prepared?.finalize();
            plans.push(...plan);
            const count = snapshot === null ? entry.rowsRead : meter.reads(snapshot, { sql: entry.sql, params: [...entry.binds] });
            expect(count).toBeDefined();
            rows += count!;
          }
          console.info('CLAIM_READ_CEILING', JSON.stringify({ target, label, rows, limit, plans }));
          expect(rows, label).toBeLessThanOrEqual(limit);
          return entries;
        } finally { snapshot?.close(); }
      };
      const load = await check('dispatch load', LOAD_LIMIT, async store => {
        expect(await dispatchLoad(store, 'title-summary', NOW)).toEqual({ liveRuns: 1, liveTaskRuns: 1, taskRunsLastHour: 1 });
        expect(await dispatchLoad(store, 'title-summary', NOW, 'live')).toEqual({ liveRuns: 0, liveTaskRuns: 0, taskRunsLastHour: 0 });
      });
      expect(load[0]!.sql).toContain('idx_agent_runs_status_id');
      await check('holder release', HOLDER_LIMIT, store => recordTaskHolder(store, ['title-summary'], ['budget', null], 'worker', true));
      expect((await db.prepare("SELECT id,held_by FROM agent_runs WHERE id IN ('held','profile','null') ORDER BY id").all()).results)
        .toEqual([{ id: 'held', held_by: 'worker' }, { id: 'null', held_by: 'worker' }, { id: 'profile', held_by: 'worker' }]);
      await check('holder no-op', HOLDER_LIMIT, store => recordTaskHolder(store, ['title-summary'], ['budget'], 'worker', true));
      await check('holder identity no-op', HOLDER_LIMIT, store => recordTaskHolder(store, ['title-summary'], ['worker'], 'worker', true));
      await check('holder budget', HOLDER_LIMIT, store => recordTaskHolder(store, ['extract-curate'], ['worker'], 'budget'));
      await db.prepare("UPDATE agent_runs SET held_by='profile_unsupported:codex' WHERE id GLOB 'queue-*'").run();
      await check('profile no-op', HOLDER_LIMIT, store => recordTaskHolder(store, ['title-summary'], ['worker', 'budget'], 'profile_unsupported:codex', true));
      await check('embedding tail page', SOURCE_PAGE_LIMIT, store => embeddingSweep(store, 'project', ['model'], ['model'], NOW,
        JSON.stringify({ phase: 'sources', a: 'session', b: 'session-04500' })));
      const event: CaptureEnvelope = { eventId: uuid(90), sessionId: 'session-04999', kind: 'response', createdAt: NOW,
        channel: 'cli', producer: { adapter: 'fixture', version: '1' }, payload: {}, payloadJson: '{}', payloadBytes: new TextEncoder().encode('{}') };
      const owner = sharedChecks(kindSpec('response')!, { projectId: 'project', machineId: 'machine', tokenId: token.tokenId, now: NOW, nonce: 'fixture', actor: null },
        event, { promptId: uuid(4999), responseId: uuid(91), text: 'Fixed' }, [])
        .find(check => check.read.sql.startsWith('SELECT s.machine_id FROM session_prompts'))!;
      await check('prompt owner', MACHINE_LIMIT, async store => {
        expect((await store.prepare(owner.read.sql).bind(...owner.read.params).all()).results).toEqual([{ machine_id: 'machine' }]);
      });
    }
  } finally { native.close(); meter.close(); await mf.dispose(); }
}, 120_000);
