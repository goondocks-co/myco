import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { planEventWrite } from '@myco-server-worker/ingest/events.js';
import { ensureAgent, recordDispatch } from '@myco-server-worker/core/runs.js';
import { recordServedPrompts } from '@myco-server-worker/core/served-material.js';
import { acknowledgePrompt } from '@myco-server-worker/core/extraction-acks.js';
import { BACKUP_FORMAT, restoreArtifact } from '@myco-server-worker/core/backup.js';
import { SERVER_SCHEMA_VERSION } from '@myco-server-worker/constants.js';
import { uuid } from './fixtures.js';

export const PROMPTS = 26_000;
export const ACKS = 7_000;
export const PAGE = 20;
const CONCURRENT = 64;
const WRITE_BATCH = 200;
const PROGRESS_EVERY = 1000;
export const scope = { projectId: 'coverage-budget' };
export const runId = 'coverage-budget-run';
export const RECORD_ACK_SEEK = "SELECT 1 FROM extraction_acks WHERE project_id = ? AND record_id = ? AND kind = 'record' LIMIT 1";

export async function fill(db: RelationalStore, prompts = PROMPTS, acks = ACKS) {
  for (const step of SCHEMA_STEPS) await db.batch(step.statements.map(sql => db.prepare(sql)));
  await db.prepare("INSERT INTO projects(project_id,name,created_at) VALUES('coverage-budget','Coverage',1)").run();
  await ensureAgent(db, { id: 'coverage', name: 'Coverage', provider: null, model: null, enabled: true }, 1);
  await recordDispatch(db, scope, { id: runId, agentId: 'coverage', task: 'extract-curate', provider: null, model: null,
    runContext: null, dispatchedBy: null, startedAt: Date.now() });
  const context = { projectId: scope.projectId, machineId: 'machine', tokenId: 'capture', bodyBytes: 0, now: 1, writeOrigin: 'server' as const };
  for (let start = 0; start < prompts; start += CONCURRENT) {
    await Promise.all(Array.from({ length: Math.min(CONCURRENT, prompts - start) }, async (_, offset) => {
      const i = start + offset;
      const write = await planEventWrite(db, context, {
        eventId: uuid(i + PROMPTS), sessionId: 'session', kind: 'prompt', createdAt: i, channel: 'cli',
        producer: { adapter: 'claude-code', version: 'test' }, payload: { promptId: uuid(i), text: 'Captured material', origin: 'user' },
      });
      if (!write.ok) throw new Error(JSON.stringify(write));
      const outcome = write.write.interpret(await db.batch(write.write.statements));
      if (!outcome.persisted) throw new Error(JSON.stringify(outcome));
    }));
    const completed = Math.min(start + CONCURRENT, prompts);
    if (completed === prompts || Math.floor(completed / PROGRESS_EVERY) !== Math.floor(start / PROGRESS_EVERY)) console.info('EXTRACTION_FIXTURE_PROGRESS', { stage: 'capture', completed, total: prompts });
  }
  const end = await planEventWrite(db, context, { eventId: crypto.randomUUID(), sessionId: 'session', kind: 'session.end', createdAt: prompts + 1, channel: 'cli', producer: { adapter: 'claude-code', version: 'test' }, payload: { endedAt: prompts + 1 } });
  if (!end.ok || !end.write.interpret(await db.batch(end.write.statements)).persisted) throw new Error('fixture session end failed');
  await acknowledgeHistory(db, acks);
}

export async function acknowledgeHistory(db: RelationalStore, end = ACKS, begin = 0) {
  for (let start = begin; start < end; start += WRITE_BATCH) {
    const rows = Array.from({ length: Math.min(WRITE_BATCH, end - start) }, (_, offset) => ({ promptId: uuid(start + offset), sessionId: 'session', createdAt: start + offset, endedAt: 1 }));
    const served = await recordServedPrompts(db, scope, runId, rows, 1);
    await Promise.all(served.map(async item => {
      const ack = await acknowledgePrompt(db, scope, runId, { servedId: item.servedId }, 1);
      if (!('marked' in ack) || !ack.marked) throw new Error(JSON.stringify(ack));
    }));
    const completed = Math.min(start + WRITE_BATCH, end);
    if (completed === end || completed % PROGRESS_EVERY === 0) console.info('EXTRACTION_FIXTURE_PROGRESS', { stage: 'ack', completed, total: end });
  }
}

/** Restore only actual ingest-produced rows; acknowledgement fixtures use the production writers on the target. */
export async function restoreCapturedHistory(source: RelationalStore, target: RelationalStore, begin = 0, end = PROMPTS) {
  const sessions = (await source.prepare('SELECT * FROM sessions').all<Record<string, unknown>>()).results;
  const prompts = (await source.prepare('SELECT * FROM prompt_batches ORDER BY created_at,prompt_id').all<Record<string, unknown>>()).results;
  const lineage = await source.prepare("SELECT value FROM schema_meta WHERE key='deployment_id'").first<{ value: string }>();
  for (let start = begin; start < end; start += 1000) {
    const rows = prompts.slice(start, Math.min(start + 1000, end));
    const header = { format: BACKUP_FORMAT, deploymentId: lineage!.value, schemaVersion: SERVER_SCHEMA_VERSION, createdAt: 1, producer: 'test',
      counts: { sessions: sessions.length, prompt_batches: rows.length } };
    const text = [JSON.stringify(header), ...sessions.map(row => JSON.stringify({ t: 'sessions', r: row })),
      ...rows.map(row => JSON.stringify({ t: 'prompt_batches', r: row }))].join('\n') + '\n';
    await restoreArtifact(target, { text, allowForeignLineage: true, authorization: { kind: 'recovery' } });
    console.info('EXTRACTION_FIXTURE_PROGRESS', { stage: 'restore', completed: Math.min(start + 1000, end), total: end });
  }
}
