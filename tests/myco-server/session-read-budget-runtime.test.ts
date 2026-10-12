import { expect, it } from 'bun:test';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { sessionTurnContexts, turnDetail, toolUsage } from '@myco-server-worker/read/turns.js';
import { uuidv5 } from '@myco-server-worker/hash.js';
import { measuredStore } from './helpers/read-budget.js';

it('D1 session contributions are attributed once and opening 500 turns stays within the rows-read budget', async () => {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true,
    script: 'export default { fetch() { return new Response(null); } }',
    compatibilityDate: '2026-07-01', d1Databases: ['DB'] }));
  try {
    const db = await mf.getD1Database('DB');
    for (const step of SCHEMA_STEPS) await db.batch(step.statements.map(sql => db.prepare(sql)));
    await db.prepare("INSERT INTO projects(project_id,name,created_at) VALUES('project','Project',1)").run();
    await db.prepare("INSERT INTO sessions(project_id,session_id,created_by_token_id,first_received_at,last_received_at,agent) VALUES('project','session','fixture',1,1000,'claude-code')").run();
    const sequence = 'WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM seq WHERE i<500)';
    await db.prepare(sequence + ` INSERT INTO prompt_batches(project_id,session_id,prompt_id,event_id,origin,text,content_hash,created_at,updated_at,token_id,received_at)
      SELECT 'project','session','prompt-'||i,'prompt-event-'||i,'user','Review','hash',i,i,'fixture',i FROM seq`).run();
    await db.prepare(`WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM seq WHERE i<20000)
      INSERT INTO events(project_id,event_id,session_id,token_id,kind,channel,payload,envelope_hash,created_at,received_at)
      SELECT 'project','event-'||i,'session','fixture','notification','hook','{}','hash',i,i FROM seq`).run();
    await db.prepare(sequence + ` INSERT INTO responses(project_id,session_id,response_id,event_id,prompt_id,text,content_hash,created_at,token_id,received_at)
      SELECT 'project','session','response-'||i,'reply-'||i,'prompt-'||i,'Done','hash',i+1,'fixture',i+1 FROM seq`).run();
    await db.prepare(sequence + ` INSERT INTO tool_calls(project_id,session_id,tool_call_id,event_id,prompt_id,tool_name,success,created_at,token_id,received_at)
      SELECT 'project','session','tool-'||i,'tool-event-'||i,'prompt-'||i,'Read',1,i,'fixture',i FROM seq`).run();
    await db.prepare("INSERT INTO session_injections(project_id,session_id,kind,created_at) VALUES('project','session','cortex',1)").run();
    await db.prepare(`WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM seq WHERE i<50)
      INSERT INTO prompt_batches(project_id,session_id,prompt_id,event_id,parent_prompt_id,origin,text,content_hash,created_at,updated_at,token_id,received_at)
      SELECT 'project','session','child-'||i,'child-event-'||i,'prompt-1','agent_dispatch','Review child','hash',i,i,'fixture',i FROM seq`).run();
    await db.prepare(sequence + ` INSERT INTO prompt_context_answers(project_id,session_id,prompt_id,id,outcome,context_chars,parts,skipped,failures,selection,created_at)
      SELECT 'project','session','prompt-'||i,'answer-'||i,'empty',0,'[]','["spores:empty"]','[]','{}',i FROM seq`).run();
    await db.prepare(sequence + ` INSERT INTO spore_injections(project_id,session_id,prompt_id,prompt_hash,spore_ids,plan_ids,created_at)
      SELECT 'project','session','prompt-'||i,'hash-'||i,'[]','[]',i FROM seq`).run();
    await db.prepare("UPDATE events SET kind='subagent.start', payload=? WHERE event_id='event-1'")
      .bind(JSON.stringify({ subagentId: await uuidv5('subagent', 'session', 'raw-agent'), parentPromptId: 'prompt-1' })).run();
    await db.prepare("INSERT INTO session_injections(project_id,session_id,kind,created_at) VALUES('project','session','cortex:raw-agent',1)").run();
    const measured = measuredStore(db);
    let statements = 0;
    const prepare = measured.db.prepare.bind(measured.db);
    measured.db.prepare = sql => { statements++; return prepare(sql); };
    const scope = { projectId: 'project' };
    expect(await sessionTurnContexts(measured.db, scope, 'session')).toEqual({ 'prompt-1': { start: true, subagents: 1 } });
    expect(await toolUsage(measured.db, scope, 'session')).toEqual([{ toolName: 'Read', count: 500 }]);
    const headerReads = measured.reads();
    expect(headerReads).toBeLessThan(2_000);
    let turnReads = 0;
    let maxTurnReads = 0;
    for (let i = 1; i <= 500; i++) {
      measured.reset();
      statements = 0;
      const body = await turnDetail(measured.db, scope, 'session', 'prompt-' + i);
      expect(body?.metrics.tools).toEqual([{ toolName: 'Read', count: 1 }]);
      expect(body?.metrics.durationMs).toBe(1);
      expect(body?.answers.map(a => a.id)).toEqual(['answer-' + i]);
      if (i === 1) {
        expect(body?.children).toHaveLength(50);
        expect(body?.children.every(child => child.body.answers.length === 0)).toBe(true);
      }
      expect(measured.reads()).toBeLessThan(i === 1 ? 2000 : 100);
      expect(statements).toBeLessThanOrEqual(9);
      turnReads += measured.reads();
      maxTurnReads = Math.max(maxTurnReads, measured.reads());
    }
    expect(headerReads + turnReads).toBeLessThan(30_000);
    console.info('SESSION_READ_BUDGET', { turns: 500, children: 50, events: 20000, headerReads, turnReads, maxTurnReads });
  } finally { await mf.dispose(); }
}, 120_000);
