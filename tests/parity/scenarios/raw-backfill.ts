import { RAW_BACKFILL_BATCH, RAW_BACKFILL_BUDGET } from '@myco-server-worker/core/raw-backfill.js';
import { expect } from 'bun:test';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { sha256Hex } from '@myco-server-worker/hash.js';
import { lit, MEMBER_ID, MACHINE_ID, type ParityScenario, type ParityTarget } from '../harness.ts';

import { BACKFILL_PROJECTS, historicalBackfillSql } from '../../myco-server/helpers/raw-backfill-fixture.js';
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
    const triggerStatements = schema.statements.filter(statement => statement.startsWith('CREATE TRIGGER')
      && provenanceTriggers.some(row => row.name === /CREATE TRIGGER (?:IF NOT EXISTS )?([A-Za-z0-9_]+)/.exec(statement)?.[1]));
    await writeStatements(triggerStatements);
    await target.sql(`UPDATE raw_provenance_backfill SET source = 0, cursor_project = '', cursor_id = '', complete = 0, updated_at = 0 WHERE id = 1`);
    const pending = await fetch(`${target.url}/api/projects/${BACKFILL_PROJECTS[0]}/sessions/backfill_session/transcript`, { headers: target.ownerHeaders() });
    expect(pending.status).toBe(404);
    console.info(`[raw-backfill:${target.name}] historical fixture ready; starting bounded wakes`);
    for (let pass = 0; pass < MAX_BACKFILL_PASSES; pass += 1) {
      const wake = await fetch(`${target.url}/api/wake`, { method: 'POST', headers: { ...target.ownerHeaders(), origin: target.url } });
      expect(wake.status).toBe(200);
      const wakeBody = await wake.json() as { jobs: Array<{ name: string; changed: number; failed: string | null }> };
      const backfill = wakeBody.jobs.find((job) => job.name === 'raw-provenance-backfill');
      expect(backfill).toBeDefined();
      expect(backfill!.failed).toBeNull();
      expect(backfill!.changed).toBeLessThanOrEqual(RAW_BACKFILL_BATCH * RAW_BACKFILL_BUDGET.calls / 6);
    }
    const admitted = await fetch(`${target.url}/api/projects/${BACKFILL_PROJECTS[0]}/sessions/backfill_session/transcript`, { headers: target.ownerHeaders() });
    expect(admitted.status).toBe(200);
    const body = await admitted.json() as { transcripts: Array<{ transcriptId: string }> };
    expect(body.transcripts.map((row) => row.transcriptId)).toEqual(['retained']);
  },
};
