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
    // The latest step records where a parsed prompt's identity comes from: a claim the store admits from its own list, and
    // a table of refused second sources keyed by all six of its names. The transcripts it finds keep the pins they hold.
    expect(await target.sql("SELECT claim, source_key, source_thread, source_record FROM prompt_batches WHERE project_id = 'proj_parity' LIMIT 1"))
      .toEqual([{ claim: null, source_key: null, source_thread: null, source_record: null }]);
    await expect(target.sql("UPDATE prompt_batches SET claim = 'guess' WHERE project_id = 'proj_parity'")).rejects.toThrow(/CHECK constraint failed/);
    expect(await target.sql('SELECT COUNT(*) AS n FROM prompt_identity_conflicts')).toEqual([{ n: 0 }]);
    expect(await target.sql("SELECT transcript_id, prompt_identity_scheme FROM transcripts WHERE session_id = 'upgrade_session' AND agent = 'codex' ORDER BY transcript_id"))
      .toEqual([{ transcript_id: 'upgrade_transcript_read', prompt_identity_scheme: null }, { transcript_id: 'upgrade_transcript_unread', prompt_identity_scheme: null }]);
    expect(await target.sql('PRAGMA foreign_key_check')).toEqual([]);
    expect(await target.sql('PRAGMA quick_check')).toEqual([{ quick_check: 'ok' }]);
  },
};
