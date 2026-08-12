import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { closeDatabase, getDatabase, initDatabase } from '@myco/db/client.js';
import { createSchema } from '@myco/db/schema.js';
import { upsertSession } from '@myco/db/queries/sessions.js';
import { insertBatchStateless } from '@myco/db/queries/batches.js';
import { buildDiagnosticBundle, type BuildBundleOptions } from '@myco/capture/diagnostics/index.js';

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'diag-analyzable-'));
  dbPath = path.join(dir, 'myco.db');
  initDatabase(dbPath);
  createSchema(getDatabase());
});

afterEach(() => {
  closeDatabase();
  rmSync(dir, { recursive: true, force: true });
});

/** The captured-twice signature: same uuid chain, same prompts, byte-identical. */
const DUP_TRANSCRIPT =
  [
    JSON.stringify({
      type: 'user',
      uuid: 'd1',
      parentUuid: null,
      timestamp: '2026-08-12T10:00:00Z',
      message: { role: 'user', content: 'why is capture silent for this session' },
    }),
    JSON.stringify({
      type: 'assistant',
      uuid: 'd2',
      parentUuid: 'd1',
      timestamp: '2026-08-12T10:00:05Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'checking the daemon log for a hook miss' }] },
    }),
    JSON.stringify({
      type: 'user',
      uuid: 'd3',
      parentUuid: 'd2',
      timestamp: '2026-08-12T10:01:00Z',
      message: { role: 'user', content: 'found it, thanks' },
    }),
  ].join('\n') + '\n';

/** Negative control: a genuinely distinct conversation. */
const UNIQUE_TRANSCRIPT =
  [
    JSON.stringify({
      type: 'user',
      uuid: 'x1',
      parentUuid: null,
      timestamp: '2026-08-12T11:00:00Z',
      message: { role: 'user', content: 'unrelated question about backups' },
    }),
    JSON.stringify({
      type: 'assistant',
      uuid: 'x2',
      parentUuid: 'x1',
      timestamp: '2026-08-12T11:00:05Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'unrelated answer about backups' }] },
    }),
  ].join('\n') + '\n';

interface SkeletonRow {
  uuid: string | null;
  parent_uuid: string | null;
  text_sha256: string | null;
}

/** Only `uuid`/`parent_uuid`/`text_sha256` matter for chain-identity comparison. */
function chainOf(lines: Array<Record<string, unknown>>): SkeletonRow[] {
  return lines.map((l) => ({
    uuid: l.uuid as string | null,
    parent_uuid: l.parent_uuid as string | null,
    text_sha256: l.text_sha256 as string | null,
  }));
}

function parseJsonl(text: string): Array<Record<string, unknown>> {
  return text
    .trim()
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/**
 * Spec Gates-table row "Bundle is analyzable end-to-end": plants the
 * registry/dedup-layer anomaly from the analyze-debug-bundle skill's worked
 * example (two sessions, overlapping windows, byte-identical transcripts --
 * the captured-twice signature) and proves it is detectable using ONLY the
 * unzipped bundle's own files, in the ANALYZE order (sessions.jsonl to find
 * the overlap, then the two transcript skeletons to confirm the chains
 * match) -- no DB access. A third, genuinely distinct session is the
 * negative control: it must NOT be flagged as a duplicate.
 */
describe('bundle is analyzable end-to-end: duplicate-session detection', () => {
  test('two overlapping sessions with byte-identical transcripts are detectable from the bundle alone; a distinct third session is not', async () => {
    const transcriptDir = mkdtempSync(path.join(tmpdir(), 'diag-analyzable-transcripts-'));
    const dupPathA = path.join(transcriptDir, 'dupA.jsonl');
    const dupPathB = path.join(transcriptDir, 'dupB.jsonl');
    const uniquePath = path.join(transcriptDir, 'uniq.jsonl');
    writeFileSync(dupPathA, DUP_TRANSCRIPT);
    writeFileSync(dupPathB, DUP_TRANSCRIPT);
    writeFileSync(uniquePath, UNIQUE_TRANSCRIPT);

    // Two sessions over the SAME window, same transcript -- e.g. two hook
    // invocations captured one real conversation under different session ids.
    upsertSession({
      id: 'dupA',
      agent: 'claude-code',
      started_at: 1000,
      ended_at: 1200,
      created_at: 1000,
      transcript_path: dupPathA,
    });
    upsertSession({
      id: 'dupB',
      agent: 'claude-code',
      started_at: 1050,
      ended_at: 1250,
      created_at: 1050,
      transcript_path: dupPathB,
    });
    insertBatchStateless({
      session_id: 'dupA',
      created_at: 1010,
      started_at: 1010,
      user_prompt: 'why is capture silent for this session',
    });
    insertBatchStateless({
      session_id: 'dupB',
      created_at: 1060,
      started_at: 1060,
      user_prompt: 'why is capture silent for this session',
    });

    // A third, non-overlapping session with a genuinely different transcript.
    upsertSession({
      id: 'uniq',
      agent: 'claude-code',
      started_at: 2000,
      ended_at: 2100,
      created_at: 2000,
      transcript_path: uniquePath,
    });
    insertBatchStateless({
      session_id: 'uniq',
      created_at: 2010,
      started_at: 2010,
      user_prompt: 'unrelated question about backups',
    });

    const outDir = mkdtempSync(path.join(tmpdir(), 'diag-analyzable-out-'));
    const options: BuildBundleOptions = {
      groveId: 'g1',
      db: getDatabase(),
      vaultDir: dir,
      dbPath,
      mycoHome: dir,
      logDir: dir,
      config: {},
      mycoVersion: '9.9.9-test',
      window: { since: 500, until: 2500 },
      includeContent: false,
      outDir,
    };

    const result = await buildDiagnosticBundle(options);
    const unzipped = unzipSync(readFileSync(result.filePath));

    // ANALYZE step 1: read sessions.jsonl to find the overlapping pair --
    // bundle-only, no DB access.
    const sessionRows = parseJsonl(strFromU8(unzipped['sessions.jsonl']!))
      .filter((r) => r.table === 'sessions')
      .map((r) => r.row as { id: string; started_at: number; ended_at: number | null });

    const overlaps = (
      a: { started_at: number; ended_at: number | null },
      b: { started_at: number; ended_at: number | null },
    ): boolean => {
      const aEnd = a.ended_at ?? a.started_at;
      const bEnd = b.ended_at ?? b.started_at;
      return a.started_at <= bEnd && b.started_at <= aEnd;
    };

    const overlappingPairs: Array<[string, string]> = [];
    for (let i = 0; i < sessionRows.length; i++) {
      for (let j = i + 1; j < sessionRows.length; j++) {
        if (overlaps(sessionRows[i]!, sessionRows[j]!)) {
          overlappingPairs.push([sessionRows[i]!.id, sessionRows[j]!.id]);
        }
      }
    }
    expect(overlappingPairs).toEqual([['dupA', 'dupB']]);

    // ANALYZE step 2: load both transcript skeletons and confirm the chains
    // (uuid/parent_uuid/text_sha256 sequences) are identical -- the
    // registry/dedup-layer verdict, still bundle-only.
    const [idA, idB] = overlappingPairs[0]!;
    const skelA = chainOf(parseJsonl(strFromU8(unzipped[`transcripts/${idA}.skeleton.jsonl`]!)));
    const skelB = chainOf(parseJsonl(strFromU8(unzipped[`transcripts/${idB}.skeleton.jsonl`]!)));
    expect(skelA).toEqual(skelB);
    expect(skelA.length).toBeGreaterThan(0);

    // Negative control: the genuinely distinct third session must NOT match.
    const skelUniq = chainOf(parseJsonl(strFromU8(unzipped['transcripts/uniq.skeleton.jsonl']!)));
    expect(skelUniq).not.toEqual(skelA);
  });
});
