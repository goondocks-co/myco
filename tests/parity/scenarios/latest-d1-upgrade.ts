import { expect } from 'bun:test';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import type { ParityScenario } from '../harness.ts';

/**
 * Applies the checked-in latest D1 file through Wrangler to populated previous-version
 * workerd D1 built through the same migration mechanism.
 * Compares schema, touched rows, version and migration ledger with the canonical step;
 * checks workerd FK/quick_check and the persisted file's full integrity_check.
 * The comparison detects emitted-file drift. A wrong but consistent canonical and
 * emitted step passes this consistency gate.
 */
export const latestD1Upgrade: ParityScenario = {
  name: 'D1: latest migration upgrades seeded previous schema to expected state',
  only: 'cloudflare',
  dedicated: { cloudflare: { latestSchemaUpgrade: true }, timeoutMs: 240_000 },
  async run(target) {
    expect(await target.sql("SELECT value FROM schema_meta WHERE key = 'version'"))
      .toEqual([{ value: String(SCHEMA_STEPS.at(-1)?.version) }]);
    for (const [table, column] of [
      ['knowledge_git_provenance', 'event_id'], ['deployment_settings', 'write_id'],
      ['worker_model_catalogs', 'observed_order'], ['runner_model_catalogs', 'observed_order'], ['runner_update_reports', 'observed_order'],
    ]) {
      const columns = await target.sql(`PRAGMA table_info(${table})`);
      expect(columns.some(c => c.name === column)).toBe(true);
      expect((await target.sql(`SELECT ${column} AS value FROM ${table}`)).every(row => row.value === null)).toBe(true);
    }
    expect(await target.sql("SELECT claim, source_key, source_thread, source_record FROM prompt_batches WHERE project_id = 'proj_parity' LIMIT 1"))
      .toEqual([{ claim: null, source_key: null, source_thread: null, source_record: null }]);
    await expect(target.sql("UPDATE prompt_batches SET claim = 'guess' WHERE project_id = 'proj_parity'")).rejects.toThrow(/CHECK constraint failed/);
    expect(await target.sql('SELECT COUNT(*) AS n FROM prompt_identity_conflicts')).toEqual([{ n: 0 }]);
    expect(await target.sql("SELECT transcript_id, prompt_identity_scheme FROM transcripts WHERE session_id = 'upgrade_session' AND agent = 'codex' ORDER BY transcript_id"))
      .toEqual([{ transcript_id: 'upgrade_transcript_read', prompt_identity_scheme: null }, { transcript_id: 'upgrade_transcript_unread', prompt_identity_scheme: null }]);
    expect(await target.sql("SELECT transcript_id, record_identity_scheme FROM transcripts WHERE session_id = 'upgrade_session' ORDER BY transcript_id"))
      .toEqual([{ transcript_id: 'upgrade_transcript_read', record_identity_scheme: 'legacy-session-v1' }, { transcript_id: 'upgrade_transcript_unread', record_identity_scheme: 'legacy-session-v1' }]);
    await expect(target.sql("UPDATE transcripts SET record_identity_scheme='source-record-v1' WHERE session_id='upgrade_session'"))
      .rejects.toThrow(/record_identity_scheme_immutable/);
    expect(await target.sql('PRAGMA foreign_key_check')).toEqual([]);
    expect(await target.sql('PRAGMA quick_check')).toEqual([{ quick_check: 'ok' }]);
  },
};
