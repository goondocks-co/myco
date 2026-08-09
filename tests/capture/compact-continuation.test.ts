import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db.js';
import { seedSession } from '../helpers/sessions.js';
import { TranscriptMiner } from '@myco/capture/transcript-miner.js';
import { extractUserPromptRecords } from '@myco/capture/prompt-kind.js';
import { getSession, updateSession } from '@myco/db/queries/sessions.js';
import { listBatchesBySession } from '@myco/db/queries/batches.js';
import { ALL_PROJECTS_SCOPE } from '@myco/grove/ids.js';

const FIXTURE = path.join(import.meta.dir, '../fixtures/claude-compact-continuation.jsonl');
const NEW_ID = 'new-session-id';
const OLD_ID = 'old-session-id';

function fixtureEvents(): Array<Record<string, unknown>> {
  return fs.readFileSync(FIXTURE, 'utf-8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

describe('compact-continuation classification (walker)', () => {
  it('classifies the compact summary origin=system via the record_field_equals rule; real turn stays human', () => {
    const records = extractUserPromptRecords('claude-code', fixtureEvents(), '/tmp/fixture.jsonl');
    const summary = records.find((r) => r.text.startsWith('This session is being continued'));
    const real = records.find((r) => r.text === 'keep going with the refactor');
    expect(summary).toBeDefined();
    expect(summary!.origin).toBe('system');
    expect(real).toBeDefined();
    expect(real!.origin).toBe('human');
  });

  it('does not classify by text prefix alone — a human prompt that merely sounds like a summary stays human', () => {
    const events = [
      {
        type: 'user',
        promptId: 'p-human',
        message: { role: 'user', content: 'This session is being continued from a previous conversation — just kidding, human typed this.' },
      },
    ];
    const records = extractUserPromptRecords('claude-code', events, '/tmp/fixture.jsonl');
    expect(records).toHaveLength(1);
    expect(records[0].origin).toBe('human');
  });

  it('regression pin: new metadata record types yield no prompt records', () => {
    const records = extractUserPromptRecords('claude-code', fixtureEvents(), '/tmp/fixture.jsonl');
    // Exactly three user-type prompt records exist in the fixture: rollover
    // summary, real human turn, in-place summary. Metadata records
    // (ai-title, mode, file-history-snapshot, …) contribute nothing.
    expect(records).toHaveLength(3);
  });
});

describe('compact-continuation lineage stitch (miner)', () => {
  let tmpDir: string;
  let transcriptPath: string;

  beforeAll(() => { setupTestDb(); });
  afterAll(teardownTestDb);

  beforeEach(() => {
    cleanTestDb();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compact-lineage-'));
    transcriptPath = path.join(tmpDir, `${NEW_ID}.jsonl`);
    fs.copyFileSync(FIXTURE, transcriptPath);
    seedSession({ id: NEW_ID, agent: 'claude-code' });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function reconcile() {
    return new TranscriptMiner().reconcileBatchKinds(NEW_ID, {
      agent: 'claude-code',
      transcriptPath,
    });
  }

  it('sets parent_session_id from the rollover summary record; in-place compaction does not override', () => {
    reconcile();
    const row = getSession(NEW_ID, ALL_PROJECTS_SCOPE)!;
    // The rollover record carries session_id=OLD_ID ≠ file id → stitched.
    // The later in-place record carries session_id=NEW_ID → skipped.
    expect(row.parent_session_id).toBe(OLD_ID);
    expect(row.parent_session_reason).toBe('compact continuation');
  });

  it('is idempotent across re-mines', () => {
    reconcile();
    // Append nothing; force a second full pass by touching the file.
    fs.appendFileSync(transcriptPath, '\n');
    reconcile();
    const row = getSession(NEW_ID, ALL_PROJECTS_SCOPE)!;
    expect(row.parent_session_id).toBe(OLD_ID);
    const batches = listBatchesBySession(NEW_ID, { scope: ALL_PROJECTS_SCOPE });
    const summaries = batches.filter((b) => (b.user_prompt ?? '').startsWith('This session is being continued'));
    const humans = batches.filter((b) => b.user_prompt === 'keep going with the refactor');
    expect(humans).toHaveLength(1);
    expect(summaries.length).toBeLessThanOrEqual(2);
  });

  it('never overwrites existing lineage (NULL-guarded)', () => {
    updateSession(NEW_ID, { parent_session_id: 'someone-else', parent_session_reason: 'resume' }, ALL_PROJECTS_SCOPE);
    reconcile();
    const row = getSession(NEW_ID, ALL_PROJECTS_SCOPE)!;
    expect(row.parent_session_id).toBe('someone-else');
    expect(row.parent_session_reason).toBe('resume');
  });

  it('stores the mined compact summary batch as origin=system, hidden from the default human view', () => {
    reconcile();
    const batches = listBatchesBySession(NEW_ID, { scope: ALL_PROJECTS_SCOPE });
    const summary = batches.find((b) => (b.user_prompt ?? '').startsWith('This session is being continued'));
    expect(summary).toBeDefined();
    expect(summary!.origin).toBe('system');
    const human = batches.find((b) => b.user_prompt === 'keep going with the refactor');
    expect(human).toBeDefined();
    expect(human!.origin).toBe('human');
  });
});
