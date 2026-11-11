import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import { planEventWrite } from '@myco-server-worker/ingest/events.js';
import { commit } from '@myco-server-worker/db/index.js';
import { recordDispatch } from '@myco-server-worker/db/runs/claim.js';
import { completeLearning } from '@myco-server-worker/core/learning-sessions.js';
import { prepareLearningSlice } from './extraction.js';
import { uuid } from './fixtures.js';

export const PROMPTS = 26_000;
export const ACKS = 7_000;
export const PAGE = 20;
const WRITE_BATCH = 200;
const PROGRESS_EVERY = 1000;
export const scope = { projectId: 'coverage-budget' };
export const runId = 'coverage-budget-run';

async function catalogCapturedPrompts(db: RelationalStore, begin: number, end: number) {
  await db.prepare(`INSERT OR IGNORE INTO session_prompts(project_id,session_id,generation,prompt_id,turn_key,ord,origin,created_at)
    SELECT e.project_id,e.session_id,1,json_extract(e.payload,'$.promptId'),json_extract(e.payload,'$.promptId'),e.rowid,
      json_extract(e.payload,'$.origin'),e.created_at FROM events e
    WHERE e.project_id = ? AND e.session_id = 'session' AND e.kind = 'prompt' AND e.created_at >= ? AND e.created_at < ?`)
    .bind(scope.projectId, begin, end).run();
}

async function acknowledgeHistory(db: RelationalStore, end = ACKS, begin = 0) {
  for (let start = begin; start < end; start += WRITE_BATCH) {
    const rows = Array.from({ length: Math.min(WRITE_BATCH, end - start) }, (_, offset) => ({ promptId: uuid(start + offset), sessionId: 'session', createdAt: start + offset, endedAt: 1 }));
    const sliceRun = `${runId}-${start}`;
    await recordDispatch(db, scope, { id: sliceRun, agentId: 'coverage', task: 'extract-curate', provider: null, model: null,
      runContext: null, dispatchedBy: null, startedAt: Date.now() });
    const assignment = await prepareLearningSlice(db, scope, sliceRun, 'session', rows, 1);
    const completedSlice = await completeLearning(db, scope.projectId, 'session', sliceRun, assignment, '', 1);
    if (!completedSlice.completed || completedSlice.covered !== rows.length) throw new Error(JSON.stringify(completedSlice));
    const completed = Math.min(start + WRITE_BATCH, end);
    if (completed === end || completed % PROGRESS_EVERY === 0) console.info('EXTRACTION_FIXTURE_PROGRESS', { stage: 'ack', completed, total: end });
  }
}

/** Seeds acknowledged prompt history across 200-prompt learning slices with full card, run, attribution, served, and ack state. */
export async function seedAcknowledgedHistory(db: RelationalStore, end = ACKS, begin = 0) {
  if (end <= begin) return;
  await acknowledgeHistory(db, begin + 1, begin);
  const total = end - begin;
  const sliceCount = Math.ceil(total / WRITE_BATCH);
  const firstRun = `${runId}-${begin}`;
  const firstSliceCards = Math.min(WRITE_BATCH, total);
  const lastSliceRun = `${runId}-${begin + (sliceCount - 1) * WRITE_BATCH}`;
  const templateRecord = uuid(begin);

  const statements = [];
  if (firstSliceCards > 1) {
    statements.push(
      db.prepare(`UPDATE agent_run_events SET payload = json_set(payload, '$.cards', CAST(? AS INTEGER)) WHERE project_id = ? AND run_id = ?`)
        .bind(firstSliceCards, scope.projectId, firstRun),
    );
  }
  if (sliceCount > 1) {
    const sampleRun = await db.prepare('SELECT * FROM agent_runs WHERE project_id = ? AND id = ?')
      .bind(scope.projectId, firstRun).first<Record<string, unknown>>();
    if (sampleRun === null) throw new Error('fixture template run missing');
    const runCols = Object.keys(sampleRun);
    const runExprs = runCols.map(col => col === 'id' ? `printf('%s-%d', ?, CAST(? AS INTEGER) + s.idx * ${WRITE_BATCH})` : `r.${col}`);
    statements.push(
      db.prepare(`WITH RECURSIVE s(idx) AS (SELECT 1 UNION ALL SELECT idx + 1 FROM s WHERE idx < CAST(? AS INTEGER))
        INSERT INTO agent_runs (${runCols.join(', ')})
        SELECT ${runExprs.join(', ')}
        FROM s CROSS JOIN agent_runs r WHERE r.project_id = ? AND r.id = ?`)
        .bind(sliceCount - 1, runId, begin, scope.projectId, firstRun),
      db.prepare(`WITH RECURSIVE s(idx) AS (SELECT 1 UNION ALL SELECT idx + 1 FROM s WHERE idx < CAST(? AS INTEGER))
        INSERT INTO agent_run_events (project_id, run_id, phase_name, event_type, tool_name, outcome, duration_ms, payload, recorded_at)
        SELECT e.project_id, printf('%s-%d', ?, CAST(? AS INTEGER) + s.idx * ${WRITE_BATCH}), e.phase_name, e.event_type, e.tool_name,
          e.outcome, e.duration_ms,
          json_set(e.payload, '$.cards', MIN(${WRITE_BATCH}, CAST(? AS INTEGER) - (CAST(? AS INTEGER) + s.idx * ${WRITE_BATCH}))),
          e.recorded_at
        FROM s CROSS JOIN (SELECT * FROM agent_run_events WHERE project_id = ? AND run_id = ? ORDER BY id LIMIT 1) e`)
        .bind(sliceCount - 1, runId, begin, end, begin, scope.projectId, firstRun),
    );
  }
  if (begin + 1 < end) {
    const sliceRunExpr = `printf('%s-%d', ?, CAST(? AS INTEGER) + ((n.i - CAST(? AS INTEGER)) / ${WRITE_BATCH}) * ${WRITE_BATCH})`;
    const promptExpr = `printf('00000000-0000-7000-8000-%012d', n.i)`;
    const servedExpr = `printf('10000000-0000-7000-8000-%012d', n.i)`;
    const ackExpr = `printf('20000000-0000-7000-8000-%012d', n.i)`;
    statements.push(
      db.prepare(`WITH RECURSIVE n(i) AS (SELECT CAST(? AS INTEGER) UNION ALL SELECT i + 1 FROM n WHERE i < CAST(? AS INTEGER))
        INSERT INTO turn_cards (project_id, session_id, turn_key, state, input_hash, card, signal, records, covered, last_seq, created_at, carded_at)
        SELECT c.project_id, c.session_id, ${promptExpr}, c.state,
          ${sliceRunExpr} || ':' || ${promptExpr},
          c.card, c.signal, json_array(json_array('prompt', ${promptExpr})), 1, c.last_seq, n.i, c.carded_at
        FROM n CROSS JOIN turn_cards c
        WHERE c.project_id = ? AND c.session_id = 'session' AND c.turn_key = ?`)
        .bind(begin + 1, end - 1, runId, begin, begin, scope.projectId, templateRecord),
      db.prepare(`WITH RECURSIVE n(i) AS (SELECT CAST(? AS INTEGER) UNION ALL SELECT i + 1 FROM n WHERE i < CAST(? AS INTEGER))
        INSERT INTO run_served_material (project_id, served_id, run_id, session_id, instance_id, record_id, served_at)
        SELECT m.project_id, ${servedExpr}, ${sliceRunExpr}, m.session_id, m.instance_id, ${promptExpr}, m.served_at
        FROM n CROSS JOIN run_served_material m
        WHERE m.project_id = ? AND m.run_id = ? AND m.record_id = ?`)
        .bind(begin + 1, end - 1, runId, begin, begin, scope.projectId, firstRun, templateRecord),
      db.prepare(`WITH RECURSIVE n(i) AS (SELECT CAST(? AS INTEGER) UNION ALL SELECT i + 1 FROM n WHERE i < CAST(? AS INTEGER))
        INSERT INTO extraction_acks (project_id, ack_id, session_id, kind, record_id, served_id, run_id, acknowledged_at)
        SELECT a.project_id, ${ackExpr}, a.session_id, a.kind, ${promptExpr}, ${servedExpr}, ${sliceRunExpr}, a.acknowledged_at
        FROM n CROSS JOIN extraction_acks a
        WHERE a.project_id = ? AND a.run_id = ? AND a.record_id = ?`)
        .bind(begin + 1, end - 1, runId, begin, begin, scope.projectId, firstRun, templateRecord),
    );
  }
  if (sliceCount > 1) {
    statements.push(
      db.prepare(`UPDATE learning_sessions
        SET revision = revision + CAST(? AS INTEGER), due_cards = 0, pending_cards = 0, eligible_at = NULL, fresh_admitted = 0, last_completed_run = ?
        WHERE project_id = ? AND session_id = 'session'`)
        .bind(sliceCount - 1, lastSliceRun, scope.projectId),
    );
  }
  if (statements.length > 0) await db.batch(statements);
  console.info('EXTRACTION_FIXTURE_PROGRESS', { stage: 'ack', completed: end, total: end });
}

/** Seeds captured prompt history in session and catalogs session_prompts; acknowledgement fixtures use production writers on the target. */
export async function seedCapturedHistory(db: RelationalStore, begin = 0, end = PROMPTS, totalPrompts = PROMPTS) {
  if (end <= begin) return;
  const context = { projectId: scope.projectId, machineId: 'machine', tokenId: 'capture', bodyBytes: 0, now: 1, writeOrigin: 'server' as const };
  if (begin === 0) {
    const first = await planEventWrite(db, context, {
      eventId: uuid(PROMPTS), sessionId: 'session', kind: 'prompt', createdAt: 0, channel: 'cli',
      producer: { adapter: 'claude-code', version: 'test' }, payload: { promptId: uuid(0), text: 'Captured material', origin: 'user' },
    });
    if (!first.ok || !first.write.interpret(await commit(db, ...first.write.statements)).persisted) throw new Error('fixture first prompt failed');
  }
  const bulkStart = Math.max(begin, 1);
  if (bulkStart < end) {
    const sample = await db.prepare('SELECT * FROM events WHERE project_id = ? AND event_id = ?')
      .bind(scope.projectId, uuid(PROMPTS)).first<Record<string, unknown>>();
    if (sample === null) throw new Error('fixture template event missing');
    const columns = Object.keys(sample).filter(col => col !== 'raw_revision' && col !== 'content_revision');
    const expressions = columns.map(col => {
      if (col === 'event_id') return `printf('00000000-0000-7000-8000-%012d', n.i + ${PROMPTS})`;
      if (col === 'created_at') return 'n.i';
      if (col === 'envelope_hash') return `printf('env-%012d', n.i)`;
      if (col === 'ingest_nonce') return `printf('30000000-0000-7000-8000-%012d', n.i)`;
      if (col === 'payload') return `json_set(e.payload, '$.promptId', printf('00000000-0000-7000-8000-%012d', n.i))`;
      return `e.${col}`;
    });
    await db.prepare(`WITH RECURSIVE n(i) AS (SELECT CAST(? AS INTEGER) UNION ALL SELECT i + 1 FROM n WHERE i < CAST(? AS INTEGER))
      INSERT INTO events (${columns.join(', ')})
      SELECT ${expressions.join(', ')}
      FROM n CROSS JOIN events e WHERE e.project_id = ? AND e.event_id = ?`)
      .bind(bulkStart, end - 1, scope.projectId, uuid(PROMPTS)).run();
  }
  if (end === totalPrompts) {
    const ended = await planEventWrite(db, context, {
      eventId: crypto.randomUUID(), sessionId: 'session', kind: 'session.end', createdAt: totalPrompts + 1, channel: 'cli',
      producer: { adapter: 'claude-code', version: 'test' }, payload: { endedAt: totalPrompts + 1 },
    });
    if (!ended.ok || !ended.write.interpret(await commit(db, ...ended.write.statements)).persisted) throw new Error('fixture session end failed');
  }
  await catalogCapturedPrompts(db, begin, end);
  console.info('EXTRACTION_FIXTURE_PROGRESS', { stage: 'capture', completed: end, total: totalPrompts });
}
