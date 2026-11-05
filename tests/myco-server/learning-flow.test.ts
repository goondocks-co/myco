import { Database } from 'bun:sqlite';
import { expect, it } from 'bun:test';
import { runLearningFlow } from '../parity/scenarios/learning-flow.ts';
import { withDocumentStores } from './helpers/document-stores.js';
import { ensureMember } from '@myco-server-worker/auth/enrollment.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { completeBudgetMigration } from '@myco-server-worker/db/budget-activation.js';
import { createServer } from '@myco-server-worker/pipeline.js';
import { serverEnvFromBindings } from '@myco-server-worker/platform/cloudflare/env.js';
import { memberHeaders, memoryBlobStore, noOutboundFetch, recordingLimiter } from './helpers/fixtures.js';
import { ownerCookie, OWNER_ENV } from './helpers/owner.js';
import { PROJECT_HEADER } from '@myco-server-worker/constants.js';
import { statementRecorder } from '../helpers/statement-recorder.js';
import { sqliteBudgetMeter } from './helpers/budget-meter.js';

const CLAIM_AND_SETTLE_LIMIT = 1000;

it('learns an exact failure through run MCP tools on both stores with a bounded claim and settlement', async () => {
  const meter = sqliteBudgetMeter();
  try {
    await withDocumentStores(async (db, target, native) => {
      const now = Date.now();
      await ensureMember(db, 'owner', now, 'admin');
      await db.prepare("UPDATE members SET github_id='583231' WHERE id='owner'").run();
      const token = await issueMemberToken(db, { memberId: 'owner', machineId: 'machine' }, now);
      await completeBudgetMigration(db, now);
      await db.prepare("INSERT INTO agents(id,name,source,enabled,created_at) VALUES('myco-agent','Myco','built-in',1,1)").run();
      const ids = JSON.stringify(Array.from({ length: 5000 }, (_, n) => n));
      await db.prepare(`INSERT INTO agent_runs(project_id,id,agent_id,task,status,origin,started_at,completed_at)
        SELECT 'project','history-'||value,'myco-agent','extract-curate','completed','automatic',1,1 FROM json_each(?)`).bind(ids).run();
      await db.prepare(`INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at)
        SELECT 'project','history-'||value,'machine',?,1,1 FROM json_each(?)`).bind(token.tokenId, ids).run();
      await db.prepare(`INSERT INTO session_prompts(project_id,session_id,generation,prompt_id,ord,created_at)
        SELECT 'project','history-'||value,1,printf('00000000-0000-7000-8000-%012d',value),1,1 FROM json_each(?)`).bind(ids).run();
      const recorder = statementRecorder(db, { accounting: target === 'D1' ? 'd1' : 'native' });
      const env = serverEnvFromBindings({ MYCO_DB: recorder.db, BUCKET: memoryBlobStore(), ...OWNER_ENV,
        SOURCE_LIMIT: recordingLimiter(), TOKEN_LIMIT: recordingLimiter() });
      const server = createServer({ now: Date.now, sourceOf: () => 'test-source', fetchImpl: noOutboundFetch });
      const cookie = await ownerCookie(db);
      let snapshot: Database | null = null;
      const closeSnapshot = () => { snapshot?.close(); snapshot = null; };
      let cycle = false;
      const request = async (request: Request) => {
        const path = new URL(request.url).pathname;
        if (path === '/worker/claim') {
          recorder.reset();
          snapshot?.close();
          snapshot = native === undefined ? null : Database.deserialize(native.serialize());
          cycle = true;
        }
        const response = await server.handleRequest(request, env);
        if (cycle && path === '/worker/end') {
          const entries = recorder.statements.map(entry => ({ sql: entry.sql, params: [...entry.binds] }));
          const rows = snapshot === null ? recorder.statements.reduce((sum, entry) => sum + (entry.rowsRead ?? 0), 0) : meter.reads(snapshot, entries);
          console.info('LEARNING_CYCLE_READS', JSON.stringify({ target, rows, limit: CLAIM_AND_SETTLE_LIMIT }));
          expect(rows).toBeGreaterThan(0);
          expect(rows).toBeLessThanOrEqual(CLAIM_AND_SETTLE_LIMIT);
          snapshot?.close(); snapshot = null; cycle = false;
        }
        return response;
      };
      try {
        await runLearningFlow({ url: 'https://s', projectId: 'project', memberHeaders: extra => memberHeaders(token.token, { [PROJECT_HEADER]: 'project', ...extra }),
          ownerHeaders: () => ({ cookie, 'cf-connecting-ip': '1.2.3.4' }),
          sql: async sql => (await db.prepare(sql).all<Record<string, unknown>>()).results,
        }, request);
      } finally { closeSnapshot(); }
    });
  } finally { meter.close(); }
}, 120_000);
