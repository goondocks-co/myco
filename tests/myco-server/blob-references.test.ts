/**
 * The blob reference catalogue: what may hold a blob, that every holder is
 * indexed for the check, and that the check is bounded per statement.
 *
 * The catalogue is derived from the kind catalogue, so the pin here is what
 * turns a new blob-naming kind into a deliberate change: the orphan sweep,
 * retention, deletion and the recovery check all read this one list.
 */
import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { BLOB_REFERENCES, blobReferenceColumn, referenceLabel } from '@myco-server-worker/core/blob-references.js';
import { blobHeld, unreferencedAmong } from '@myco-server-worker/db/storage/blob-held.js';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { sqliteEnv } from './helpers/fixtures.js';

/** Every reference the catalogue names today, by label; a kind that starts naming a blob lands here. */
const REFERENCES = [
  'plans.blob_key',
  'attachments.blob_key',
  'transcript_segments.blob_key',
  'event_refs.blob',
  'event_refs.output_blob',
  'events.blob_key (prompt, tool.use, tool.failure, response, plan, attachment, transcript.segment, compaction.pre, compaction.post)',
  'archive_bundles.archive_key',
  'archive_bundles.receipt_key',
  'raw_archive_refs.archive_key',
  'raw_archive_refs.receipt_key',
  'registered_content_proofs.key',
  'run_bodies.key',
];

const DDL = SCHEMA_STEPS.flatMap((s) => s.statements);

describe('the blob reference catalogue', () => {
  it('names every projected blob column and every retained blob-bearing event kind', () => {
    expect(BLOB_REFERENCES.map(referenceLabel)).toEqual(REFERENCES);
  });

  it('is indexed by Project and key at every reference, so the held check is a seek per holder rather than a scan', () => {
    for (const ref of BLOB_REFERENCES) {
      const indexed = DDL.some(sql => sql.replace(/\s/g, '').includes(`ON${ref.table}(project_id,${blobReferenceColumn(ref).replace(/\s/g, '')})`));
      expect({ ref: referenceLabel(ref), indexed }).toEqual({ ref: referenceLabel(ref), indexed: true });
    }
  });

  it('plans the orphan select as a scan of blobs and a seek into every holder', () => {
    const { sqlite } = sqliteEnv();
    try {
      const plan = sqlite.query(`EXPLAIN QUERY PLAN SELECT project_id, key FROM blobs b WHERE NOT (${blobHeld('b.project_id', 'b.key')}) LIMIT 8`)
        .all() as { detail: string }[];
      const details = plan.map((r) => r.detail);
      for (const ref of BLOB_REFERENCES) {
        const scanned = details.filter((d) => d.startsWith(`SCAN ${ref.table}`));
        expect({ ref: referenceLabel(ref), scanned }).toEqual({ ref: referenceLabel(ref), scanned: [] });
        expect(details.some((d) => d.startsWith(`SEARCH ${ref.table} USING`) && d.includes(ref.column))).toBe(true);
      }
    } finally { sqlite.close(); }
  });

  it('answers a page of any size in bounded statements binding one value each, every pair judged in its own Project', async () => {
    const { sqlite, db, executed } = sqliteEnv();
    try {
      const key = (n: number) => String(n).padStart(64, '0');
      const pairs = Array.from({ length: 300 }, (_, n) => ({ projectId: n % 2 === 0 ? 'proj_1' : 'proj_2', key: key(n) }));
      // Every third key is held by a raw event in proj_1 only.
      for (const { key: k } of pairs.filter((_, n) => n % 3 === 0)) {
        sqlite.run(`INSERT INTO events (project_id,event_id,session_id,token_id,kind,channel,payload,envelope_hash,created_at,received_at)
                    VALUES ('proj_1', ?, 's', 't', 'tool.use', 'cli', json_object('blob',?), 'h', 1, 1)`, [`tc-${k}`, k]);
      }
      executed.length = 0;
      const free = await unreferencedAmong(db, pairs);
      const expected = pairs.filter((p, n) => !(n % 3 === 0 && p.projectId === 'proj_1'));
      expect(free).toEqual(expected);
      const checks = executed.filter((sql) => sql.includes('json_each'));
      expect(checks.length).toBe(2);
      for (const sql of checks) expect((sql.match(/\?/g) ?? []).length).toBe(1);
    } finally { sqlite.close(); }
  });
});
