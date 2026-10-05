import { RAW_BACKFILL_BATCH, RAW_BACKFILL_BUDGET } from '@myco-server-worker/core/raw-backfill.js';
import { expect } from 'bun:test';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { sha256Hex } from '@myco-server-worker/hash.js';
import { lit, MEMBER_ID, MACHINE_ID, type ParityScenario, type ParityTarget } from '../harness.ts';

import { BACKFILL_PROJECTS, historicalBackfillSql, HISTORICAL_BLOBS, HISTORICAL_PLANS, HISTORICAL_TRANSCRIPTS } from '../../myco-server/helpers/raw-backfill-fixture.js';
const PARITY_EVENTS = 2_000;
const MAX_BACKFILL_PASSES = 3;

/** Real native and D1 wake paths finish a large held source fixture without mirroring its event log. */
export const rawBackfillParity: ParityScenario = {
  name: 'raw backfill: bounded historical provenance, retained transcript ownership and completion on native and D1',
  dedicated: { timeoutMs: 360_000 },
  async run(target: ParityTarget) {
    console.info(`[raw-backfill:${target.name}] preparing historical fixture`);
    const writeStatements = async (statements: string[]) => {
      if (target.name === 'cloudflare') await target.sql(statements.join(';\n') + ';');
      else for (const statement of statements) await target.sql(statement);
    };
    const now = Date.now();
    const credential = (await target.sql(`SELECT id FROM member_credentials WHERE token_hash = ${lit(await sha256Hex(target.memberToken))}`))[0]?.id;
    expect(typeof credential).toBe('string');
    const schema = SCHEMA_STEPS.find((step) => step.version === 71)!;
    const names = schema.statements.flatMap((statement) => {
      const match = /CREATE TRIGGER (?:IF NOT EXISTS )?([A-Za-z0-9_]+)/.exec(statement);
      return match === null ? [] : [match[1]];
    });
    const provenanceTriggers = await target.sql(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND name IN (${names.map(lit).join(',')})`);
    const dropTriggers = provenanceTriggers.map((row) => {
      const name = String(row.name);
      if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error(`unexpected fixture trigger ${name}`);
      return `DROP TRIGGER ${name}`;
    });
    await writeStatements(dropTriggers);
    await writeStatements(historicalBackfillSql(now, MEMBER_ID, MACHINE_ID, String(credential), PARITY_EVENTS));
    const sourceRows = async (table: string) => {
      const source: Record<string, unknown>[] = [];
      const pageSize = 250;
      for (let offset = 0; ; offset += pageSize) {
        const page = await target.sql(`SELECT * FROM ${table} WHERE project_id IN (${BACKFILL_PROJECTS.map(lit).join(',')}) ORDER BY rowid LIMIT ${pageSize} OFFSET ${offset}`);
        source.push(...page);
        if (page.length < pageSize) break;
      }
      const rows = source.map((row) => {
        if (table !== 'events') return row;
        const { raw_revision: _revision, ...original } = row;
        return original;
      });
      return rows;
    };
    const originals: Array<{ table: string; rows: Record<string, unknown>[]; hash: string }> = [];
    for (const table of ['blobs', 'events', 'transcripts', 'transcript_segments', 'plans', 'prompt_batches', 'responses', 'tool_calls']) {
      const rows = await sourceRows(table);
      originals.push({ table, rows, hash: await sha256Hex(JSON.stringify(rows)) });
    }
    const triggerStatements = schema.statements.filter((statement) => statement.startsWith('CREATE TRIGGER'));
    await writeStatements(triggerStatements);
    await target.sql(`UPDATE raw_provenance_backfill SET source = 0, cursor_project = '', cursor_id = '', complete = 0, updated_at = 0 WHERE id = 1`);
    const rows = async () => Number((await target.sql(`SELECT COUNT(*) AS n FROM raw_resources WHERE project_id IN (${BACKFILL_PROJECTS.map(lit).join(',')})`))[0]?.n);
    expect(await rows()).toBe(0);
    expect(await target.sql(`SELECT complete FROM raw_provenance_backfill WHERE id = 1`)).toEqual([{ complete: 0 }]);
    const pending = await fetch(`${target.url}/api/projects/${BACKFILL_PROJECTS[0]}/sessions/backfill_session/transcript`, { headers: target.ownerHeaders() });
    expect(pending.status).toBe(404);
    console.info(`[raw-backfill:${target.name}] historical fixture ready; starting bounded wakes`);
    let previous = 0;
    let complete = false;
    for (let pass = 0; pass < MAX_BACKFILL_PASSES; pass += 1) {
      const wake = await fetch(`${target.url}/api/wake`, { method: 'POST', headers: { ...target.ownerHeaders(), origin: target.url } });
      expect(wake.status).toBe(200);
      const wakeBody = await wake.json() as { jobs: Array<{ name: string; changed: number; failed: string | null }> };
      const backfill = wakeBody.jobs.find((job) => job.name === 'raw-provenance-backfill');
      expect(backfill).toBeDefined();
      expect(backfill!.failed).toBeNull();
      expect(backfill!.changed).toBeLessThanOrEqual(RAW_BACKFILL_BATCH * RAW_BACKFILL_BUDGET.calls / 6);
      const checkpoint = await target.sql(`SELECT *, (SELECT COUNT(*) FROM raw_resources WHERE project_id IN (${BACKFILL_PROJECTS.map(lit).join(',')})) AS raw_rows FROM raw_provenance_backfill WHERE id = 1`);
      const current = Number(checkpoint[0]?.raw_rows);
      expect(current).toBeGreaterThanOrEqual(previous);
      previous = current;
      if (pass % 10 === 0) console.info(`[raw-backfill:${target.name}] pass ${pass}; source ${checkpoint[0]?.source}; raw snapshots ${current}`);
      complete = checkpoint[0]?.complete === 1;
      if (complete) break;
    }
    expect(complete).toBe(true);
    expect(await rows()).toBe(HISTORICAL_BLOBS + HISTORICAL_TRANSCRIPTS);
    expect(await target.sql(`SELECT COUNT(*) AS n FROM raw_resources WHERE kind = 'event'`)).toEqual([{ n: 0 }]);
    expect(await target.sql(`SELECT COUNT(*) AS n FROM events WHERE project_id IN (${BACKFILL_PROJECTS.map(lit).join(',')})`)).toEqual([{ n: PARITY_EVENTS + HISTORICAL_PLANS }]);
    expect(await target.sql(`SELECT kind, COUNT(*) AS n FROM processed_resources WHERE project_id IN (${BACKFILL_PROJECTS.map(lit).join(',')}) GROUP BY kind ORDER BY kind`)).toEqual([
      { kind: 'attachment', n: HISTORICAL_BLOBS }, { kind: 'plan', n: HISTORICAL_PLANS },
      { kind: 'prompt', n: HISTORICAL_BLOBS }, { kind: 'response', n: HISTORICAL_BLOBS },
      { kind: 'tool-input', n: HISTORICAL_BLOBS }, { kind: 'tool-output', n: HISTORICAL_BLOBS },
    ]);
    for (const original of originals) {
      const rows = await sourceRows(original.table);
      const changed = rows.findIndex((row, index) => JSON.stringify(row) !== JSON.stringify(original.rows[index]));
      if (changed !== -1) {
        throw new Error(`Backfill changed ${original.table} row ${changed}: ${JSON.stringify({ before: original.rows[changed], after: rows[changed] })}`);
      }
      expect(await sha256Hex(JSON.stringify(rows)), original.table).toBe(original.hash);
    }
    expect(await target.sql(`SELECT resource_id AS transcript_id, owner_member_id FROM raw_resources WHERE kind = 'transcript' AND resource_id NOT LIKE 'bulk-%' AND project_id IN (${BACKFILL_PROJECTS.map(lit).join(',')}) ORDER BY resource_id`)).toEqual([
      { transcript_id: 'conflicting', owner_member_id: null }, { transcript_id: 'known', owner_member_id: MEMBER_ID },
      { transcript_id: 'mixed', owner_member_id: null }, { transcript_id: 'retained', owner_member_id: MEMBER_ID }, { transcript_id: 'unknown', owner_member_id: null },
    ]);
    const admitted = await fetch(`${target.url}/api/projects/${BACKFILL_PROJECTS[0]}/sessions/backfill_session/transcript`, { headers: target.ownerHeaders() });
    expect(admitted.status).toBe(200);
    const body = await admitted.json() as { transcripts: Array<{ transcriptId: string }> };
    expect(body.transcripts.map((row) => row.transcriptId)).toEqual(['retained']);
  },
};
