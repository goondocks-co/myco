import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, it } from 'bun:test';
import { definedStatements } from '@myco-server-worker/db/kernel/statement.js';
import { RUN_CONTROL_REFUSAL_WORDS, type RunControlRefusalCode } from '@goondocks/myco-shared/run-control';
import { KNOWLEDGE_REPOSITORY_TASKS } from '@goondocks/myco-shared/repository';
import { insertReport } from '@myco-server-worker/db/runs/evidence.js';
import { renewRunLeaseExpiry, workerRunLeaseExpiry } from '@myco-server-worker/db/runs/leases.js';
import { recordRunControlRefusal, type RunRow } from '@myco-server-worker/db/runs/lifecycle.js';
import { pinMapRepositoryForRun, pinMapSourceForRun, recordKnowledgeRepositoryUnavailable } from '@myco-server-worker/db/runs/preparation.js';
import { taskRunFacts } from '@myco-server-worker/db/runs/task-facts.js';
import { readSporePage } from '@myco-server-worker/db/spores/browse.js';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import { seededSqlite } from '../myco-server/helpers/d1.js';

const DB = resolve('packages/myco-server/src/db');
/** Statements needing an index the operator path builds, named so the exception goes stale when that changes. */
const NEEDS_OPERATOR_INDEX: Readonly<Record<string, string>> = { 'meta.estimateCursor': 'idx_attempts_settled', 'meta.estimateSettlements': 'idx_attempts_settled' };

const modules = (dir: string): string[] => readdirSync(dir).flatMap(name => {
  const file = join(dir, name);
  if (statSync(file).isDirectory()) return modules(file);
  return /\.ts$/.test(name) && !/\.d\.ts$/.test(name) && !/^schema-v\d+\.ts$/.test(name) ? [file] : [];
});

const browseVariants = async (sqlite: ReturnType<typeof seededSqlite>): Promise<void> => {
  const db = sqliteRelationalStore(sqlite);
  for (const scope of [{ projectId: 'p' }, { all: true, projectIds: [] }, { all: false, projectIds: ['p'] }]) {
    for (let bits = 0; bits < 2 ** 9; bits++) {
      const on = (bit: number) => (bits & (1 << bit)) !== 0;
      if (on(7) && on(4)) continue;
      const after = on(8) ? { createdAt: 1, id: 'x', projectId: 'p' } : null;
      await readSporePage(db, {
        scope: scope as Parameters<typeof readSporePage>[1]['scope'],
        filters: {
          ...(on(0) ? { agentId: 'a' } : {}), ...(on(1) ? { author: 'a' } : {}), ...(on(2) ? { observationType: 't' } : {}),
          ...(on(3) ? { status: 's' } : {}), ...(on(4) ? { sessionId: 's' } : {}), ...(on(5) ? { createdFrom: 1 } : {}),
          ...(on(6) ? { createdTo: 1 } : {}), ...(on(7) ? { includeActive: false } : {}),
        } as Parameters<typeof readSporePage>[1]['filters'],
        after,
        limit: 1,
      });
    }
  }
};

/** Run statements defined per shape exist once their shape is asked for; absent rows leave each call a no-op. */
const runShapes = async (sqlite: ReturnType<typeof seededSqlite>): Promise<void> => {
  const db = sqliteRelationalStore(sqlite);
  const scope = { projectId: 'p' };
  const caller = { tokenId: 't', now: 0, deadline: 0 };
  const run = { id: 'r', dispatchedBy: 'd', runContext: null, task: KNOWLEDGE_REPOSITORY_TASKS[0] } as unknown as RunRow;
  const pin = { inputHash: 'a'.repeat(64), priorRevision: null };
  for (const worker of [{ kind: 'member', tokenId: 't', machineId: 'm' }, { kind: 'runner', runnerId: 'r', credentialId: 'c', machineId: null }] as const) {
    const lease = { worker, now: 0 };
    for (const attempt of [undefined, 'a']) {
      await renewRunLeaseExpiry(db, scope, 'r', worker, 1, 0, attempt);
      await workerRunLeaseExpiry(db, scope, 'r', worker, 0, attempt);
      await pinMapSourceForRun(db, scope, { ...run, dispatchedBy: attempt ?? null }, pin, lease);
    }
    await pinMapRepositoryForRun(db, scope, run, { url: 'u', branch: 'b', commit: 'c' }, pin, lease);
    await recordKnowledgeRepositoryUnavailable(db, scope, run, { code: 'unavailable' } as never, lease);
  }
  await pinMapSourceForRun(db, scope, run, pin);
  for (const held of [undefined, caller]) {
    await insertReport(db, scope, { runId: 'r', agentId: 'a', action: 'x', summary: 's', details: null, audit: null, createdAt: 0 }, held);
    for (const code of Object.keys(RUN_CONTROL_REFUSAL_WORDS) as RunControlRefusalCode[]) await recordRunControlRefusal(db, 't', code, held);
  }
  for (const projects of [undefined, 'p', ['p']]) taskRunFacts(db, ['t'], 0, 'clock', projects);
};

it('every registered statement prepares against the final schema', async () => {
  const sqlite = seededSqlite();
  for (const file of modules(DB)) await import(file);
  await browseVariants(sqlite);
  await runShapes(sqlite);
  const failures: string[] = [];
  const stale: string[] = [];
  for (const [name, sql] of definedStatements()) {
    let message = '';
    try { sqlite.prepare(sql); } catch (error) { message = error instanceof Error ? error.message : String(error); }
    const index = NEEDS_OPERATOR_INDEX[name];
    if (index === undefined) { if (message !== '') failures.push(`${name}: ${message}`); }
    else if (!message.includes(index)) stale.push(name);
  }
  expect(failures).toEqual([]);
  expect(stale).toEqual([]);
  expect(Object.keys(NEEDS_OPERATOR_INDEX).filter(name => !definedStatements().has(name))).toEqual([]);
});
