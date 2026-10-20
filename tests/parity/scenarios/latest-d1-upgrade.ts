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
    // The latest step pins each transcript held: one already read to the scheme that read it, any other to its
    // agent's declaration; the pin never changes after.
    expect(await target.sql("SELECT transcript_id, prompt_identity_scheme FROM transcripts WHERE session_id = 'upgrade_session' AND agent = 'codex' ORDER BY transcript_id"))
      .toEqual([{ transcript_id: 'upgrade_transcript_read', prompt_identity_scheme: 'offset-v1' }, { transcript_id: 'upgrade_transcript_unread', prompt_identity_scheme: 'codex-turn-v1' }]);
    await expect(target.sql("UPDATE transcripts SET prompt_identity_scheme = 'codex-turn-v1' WHERE transcript_id = 'upgrade_transcript_read'")).rejects.toThrow(/prompt identity scheme never changes/);
    expect(await target.sql('PRAGMA foreign_key_check')).toEqual([]);
    expect(await target.sql('PRAGMA quick_check')).toEqual([{ quick_check: 'ok' }]);
  },
};
