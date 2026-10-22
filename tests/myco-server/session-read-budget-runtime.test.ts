import { expect, it } from 'bun:test';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { listTurns, sessionTurnContexts, turnDetail, toolUsage } from '@myco-server-worker/read/turns.js';
import { uuidv5 } from '@myco-server-worker/hash.js';
import { measuredStore } from './helpers/read-budget.js';
import { countUnplacedContextRecords, listUnplacedHookRecords } from '@myco-server-worker/read/hook-placement.js';

const DAY_MS = 24 * 60 * 60 * 1000;

it('D1 session contributions are attributed once and opening 500 turns stays within the rows-read budget', async () => {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true,
    script: 'export default { fetch() { return new Response(null); } }',
    compatibilityDate: '2026-07-01', d1Databases: ['DB'] }));
  try {
    const db = await mf.getD1Database('DB');
    for (const step of SCHEMA_STEPS) await db.batch(step.statements.map(sql => db.prepare(sql)));
    const now = 10 * DAY_MS;
    const capturedAt = now - DAY_MS;
    await db.prepare("INSERT INTO projects(project_id,name,created_at) VALUES('project','Project',1)").run();
    await db.prepare(`INSERT INTO sessions(project_id,session_id,created_by_token_id,first_received_at,last_received_at,agent) VALUES('project','session','fixture',${capturedAt},${capturedAt + 1000},'copilot')`).run();
    const sequence = 'WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM seq WHERE i<500)';
    await db.prepare(sequence + ` INSERT INTO prompt_batches(project_id,session_id,prompt_id,event_id,origin,text,content_hash,created_at,updated_at,token_id,received_at)
      SELECT 'project','session','prompt-'||i,'prompt-event-'||i,'user','Review','hash',${capturedAt}+i,${capturedAt}+i,'fixture',${capturedAt}+i FROM seq`).run();
    await db.prepare(`WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM seq WHERE i<20000)
      INSERT INTO events(project_id,event_id,session_id,token_id,kind,channel,payload,envelope_hash,created_at,received_at)
      SELECT 'project','event-'||i,'session','fixture','notification','cli','{}','hash',${capturedAt}+i,${capturedAt}+i FROM seq`).run();
    await db.prepare(sequence + ` INSERT INTO responses(project_id,session_id,response_id,event_id,prompt_id,text,content_hash,created_at,token_id,received_at)
      SELECT 'project','session','response-'||i,'reply-'||i,'prompt-'||i,'Done','hash',${capturedAt}+i+1,'fixture',${capturedAt}+i+1 FROM seq`).run();
    await db.prepare(sequence + ` INSERT INTO tool_calls(project_id,session_id,tool_call_id,event_id,prompt_id,tool_name,success,created_at,token_id,received_at)
      SELECT 'project','session','tool-'||i,'tool-event-'||i,'prompt-'||i,'Read',1,${capturedAt}+i,'fixture',${capturedAt}+i FROM seq`).run();
    await db.prepare(`INSERT INTO session_injections(project_id,session_id,kind,created_at) VALUES('project','session','cortex',${capturedAt})`).run();
    await db.prepare(`WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM seq WHERE i<50)
      INSERT INTO prompt_batches(project_id,session_id,prompt_id,event_id,parent_prompt_id,origin,text,content_hash,created_at,updated_at,token_id,received_at)
      SELECT 'project','session','child-'||i,'child-event-'||i,'prompt-1','agent_dispatch','Review child','hash',${capturedAt}+i,${capturedAt}+i,'fixture',${capturedAt}+i FROM seq`).run();
    await db.prepare(sequence + ` INSERT INTO prompt_context_answers(project_id,session_id,prompt_id,id,outcome,context_chars,parts,skipped,failures,selection,created_at)
      SELECT 'project','session','prompt-'||i,'answer-'||i,'empty',0,'[]','["spores:empty"]','[]','{}',${capturedAt}+i FROM seq`).run();
    await db.prepare(sequence + ` INSERT INTO spore_injections(project_id,session_id,prompt_id,prompt_hash,spore_ids,plan_ids,created_at)
      SELECT 'project','session','prompt-'||i,'hash-'||i,'[]','[]',${capturedAt}+i FROM seq`).run();
    await db.prepare(`INSERT INTO events(project_id,event_id,session_id,token_id,kind,channel,payload,envelope_hash,created_at,received_at)
      VALUES ('project','subagent-start-event','session','fixture','subagent.start','cli',?,'hash',${capturedAt},${capturedAt})`)
      .bind(JSON.stringify({ subagentId: await uuidv5('subagent', 'session', 'raw-agent'), parentPromptId: 'prompt-1' })).run();
    for (const [id, kind, payload] of [
      ['unplaced-turn', 'turn', { promptId: 'missing-turn', phase: 'end' }],
      ['unplaced-stop', 'subagent.stop', { subagentId: await uuidv5('subagent', 'session', 'stopped-agent'), parentPromptId: 'missing-stop' }],
    ] as const) await db.prepare(`INSERT INTO events(project_id,event_id,session_id,token_id,kind,channel,payload,envelope_hash,created_at,received_at)
        VALUES ('project',?,'session','fixture',?,'cli',?,'hash',${capturedAt + 1},${capturedAt + 1})`).bind(id, kind, JSON.stringify(payload)).run();
    await db.prepare(`INSERT INTO session_injections(project_id,session_id,kind,created_at) VALUES('project','session','cortex:raw-agent',${capturedAt})`).run();
    await db.prepare('UPDATE spore_injections SET delivered_at=created_at,delivered_prompt_id=prompt_id').run();
    const measured = measuredStore(db);
    let statements = 0;
    const prepare = measured.db.prepare.bind(measured.db);
    measured.db.prepare = sql => { statements++; return prepare(sql); };
    const scope = { projectId: 'project' };
    expect(await sessionTurnContexts(measured.db, scope, 'session')).toEqual({ 'prompt-1': { subagents: 1 } });
    expect(await toolUsage(measured.db, scope, 'session')).toEqual([{ toolName: 'Read', count: 500 }]);
    const headerReads = measured.reads();
    expect(headerReads).toBeLessThan(2_000);
    const unplaced = measuredStore(db);
    let normalOpenUnplacedReads: number | undefined;
    let unplacedRequests = 0;
    let conversationRuntimeMs = 0;
    const ui = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path.endsWith('/unplaced')) {
        unplacedRequests++;
        return Response.json(await listUnplacedHookRecords(unplaced.db, scope, 'session'));
      }
      if (path.endsWith('/turns')) return Response.json(await listTurns(db, scope, 'session', { origins: ['user'], limit: 200, order: 'DESC' }));
      if (path === '/budget/opened') { normalOpenUnplacedReads = unplaced.reads(); return Response.json({ ok: true }); }
      return new Response('unexpected UI request: ' + path, { status: 404 });
    } });
    try {
      const childEnv: NodeJS.ProcessEnv = { ...process.env, MYCO_TEST_KIND: 'dom', MYCO_CONVERSATION_BUDGET_URL: ui.url.href };
      delete childEnv.MYCO_TEST_GROUP;
      delete childEnv.MYCO_TEST_SHARD;
      const childStarted = performance.now();
      const child = Bun.spawn(['node', 'scripts/run-bun-tests.mjs', './tests/myco-server/helpers/conversation-budget_test.tsx'], {
        env: childEnv, stdout: 'pipe', stderr: 'pipe',
      });
      const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      conversationRuntimeMs = Math.ceil(performance.now() - childStarted);
      expect({ exit, output: exit === 0 ? '' : stdout + stderr }).toEqual({ exit: 0, output: '' });
      expect(normalOpenUnplacedReads).toBe(0);
      expect(unplacedRequests).toBe(1);
    } finally { await ui.stop(true); }
    const unplacedPageReads = unplaced.reads();
    await db.prepare(`INSERT INTO spore_injections(project_id,session_id,id,prompt_id,prompt_hash,spore_ids,created_at,delivered_at,delivered_prompt_id)
      VALUES ('project','session','unresolved','selected','unresolved','[]',${capturedAt + 1000},${capturedAt + 1000},'missing'),
        ('project','session','undelivered','waiting','undelivered','[]',${capturedAt + 1000},NULL,NULL)`).run();
    await db.prepare(`INSERT INTO prompt_context_answers(project_id,session_id,id,prompt_id,outcome,context_chars,parts,skipped,failures,selection,created_at)
      VALUES ('project','session','orphan','missing','served',1,'[]','[]','[]','{}',${capturedAt + 1000})`).run();
    await db.prepare(`INSERT INTO session_injections(project_id,session_id,kind,created_at) VALUES ('project','session','plan-nudge',${capturedAt + 1000}),('project','session','cortex:missing-agent',${capturedAt + 1000})`).run();
    const statusReads: number[] = [];
    let oldSessions = 0;
    const oldAt = now - 8 * DAY_MS;
    for (const total of [200, 2_000]) {
      const oldSequence = `WITH RECURSIVE seq(i) AS (SELECT ${oldSessions + 1} UNION ALL SELECT i+1 FROM seq WHERE i<${total})`;
      await db.prepare(oldSequence + ` INSERT INTO sessions(project_id,session_id,created_by_token_id,first_received_at,last_received_at,agent)
        SELECT 'project','old-'||i,'fixture',${oldAt},${oldAt},'copilot' FROM seq`).run();
      await db.prepare(oldSequence + ` INSERT INTO session_injections(project_id,session_id,kind,created_at)
        SELECT 'project','old-'||i,'cortex',${oldAt} FROM seq UNION ALL
        SELECT 'project','old-'||i,'cortex:agent',${oldAt} FROM seq`).run();
      await db.prepare(oldSequence + ` INSERT INTO session_injections(project_id,session_id,kind,created_at,delivered_at,delivered_prompt_id)
        SELECT 'project','old-'||i,'plan-nudge',${oldAt},${oldAt},'missing' FROM seq`).run();
      await db.prepare(oldSequence + `, lookup(n) AS (VALUES(1),(2),(3),(4),(5))
        INSERT INTO spore_injections(project_id,session_id,id,prompt_id,prompt_hash,spore_ids,created_at,delivered_at,delivered_prompt_id)
        SELECT 'project','old-'||i,'receipt-'||n,'selection-'||n,'hash-'||n,'[]',${oldAt},${oldAt},'missing-'||n FROM seq CROSS JOIN lookup`).run();
      await db.prepare(oldSequence + `, lookup(n) AS (VALUES(1),(2),(3),(4),(5))
        INSERT INTO prompt_context_answers(project_id,session_id,id,prompt_id,receipt_id,outcome,context_chars,parts,skipped,failures,selection,created_at,delivered_at,delivered_prompt_id)
        SELECT 'project','old-'||i,'answer-'||n,'selection-'||n,'receipt-'||n,'served',1,'[{"kind":"spores","sporeCount":1}]','[]','[]','{}',${oldAt},${oldAt},'missing-'||n
        FROM seq CROSS JOIN lookup`).run();
      oldSessions = total;
      measured.reset();
      expect(await countUnplacedContextRecords(measured.db, undefined, undefined, now)).toBe(1);
      statusReads.push(measured.reads());
      expect(measured.reads()).toBeLessThan(3_000);
    }
    expect(statusReads[1]).toBe(statusReads[0]);
    measured.reset();
    const afterWindow = now + 7 * DAY_MS;
    expect(await countUnplacedContextRecords(measured.db, undefined, undefined, afterWindow)).toBe(0);
    const expiredStatusReads = measured.reads();
    expect(expiredStatusReads).toBeLessThan(100);
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
    console.info('SESSION_READ_BUDGET', { turns: 500, children: 50, events: 20003, oldSessions: [200, 2000], headerReads, turnReads, maxTurnReads,
      normalOpenUnplacedReads, unplacedPageReads, statusReads, expiredStatusReads, conversationRuntimeMs });
  } finally { await mf.dispose(); }
}, 120_000);
