import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { getDatabase } from '@myco/db/client.js';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db';
import { upsertSession, getSession } from '@myco/db/queries/sessions.js';
import { RECOVERED_BATCH_SENTINEL, BATCH_KIND, insertBatchStateless } from '@myco/db/queries/batches.js';
import { insertActivity } from '@myco/db/queries/activities.js';
import { hasSessionTombstone, SESSION_TOMBSTONE_SOURCE, getSessionTombstone } from '@myco/db/queries/session-tombstones.js';
import { ensureSessionRowExists } from '@myco/daemon/session-lifecycle.js';
import {
  findPhantomCandidates,
  reapPhantomSession,
  sessionLooksInjectionOnly,
  sessionQualifiesForPhantomReap,
} from '@myco/daemon/phantom-reaper.js';
import { runSessionMaintenance } from '@myco/daemon/jobs/session-maintenance.js';
import { ALL_PROJECTS_SCOPE } from '@myco/grove/ids.js';
import { epochSeconds } from '@myco/constants.js';

const noopLogger = {
  info: () => {},
  warn: () => {},
  debug: () => {},
  error: () => {},
} as never;

/** Never finds a transcript — the pure-phantom case. */
const noTranscript = () => null;

function seedSession(id: string, opts: { status?: string; endedAt?: number | null; transcriptPath?: string | null; agent?: string } = {}) {
  upsertSession({
    id,
    agent: opts.agent ?? 'claude-code',
    started_at: epochSeconds() - 3600,
    created_at: epochSeconds() - 3600,
    status: opts.status ?? 'completed',
    ended_at: opts.endedAt === undefined ? epochSeconds() - 3600 : opts.endedAt,
    transcript_path: opts.transcriptPath ?? null,
    machine_id: 'm',
  });
}

function seedSentinelBatch(sessionId: string): string {
  const { row } = insertBatchStateless({
    session_id: sessionId,
    user_prompt: RECOVERED_BATCH_SENTINEL,
    started_at: epochSeconds() - 3600,
    created_at: epochSeconds() - 3600,
    kind: BATCH_KIND.RECOVERED,
    parent_prompt_batch_id: null,
  });
  return row.id;
}

function seedRealBatch(sessionId: string, prompt: string) {
  insertBatchStateless({
    session_id: sessionId,
    user_prompt: prompt,
    started_at: epochSeconds() - 1800,
    created_at: epochSeconds() - 1800,
    kind: BATCH_KIND.INITIAL,
    parent_prompt_batch_id: null,
  });
}

function seedActivity(sessionId: string, batchId: string, toolName: string) {
  insertActivity({
    session_id: sessionId,
    prompt_batch_id: batchId,
    tool_name: toolName,
    timestamp: epochSeconds() - 3600,
    created_at: epochSeconds() - 3600,
  });
}

/** The canonical phantom: one sentinel batch, one injection activity, no transcript. */
function seedPhantom(id: string) {
  seedSession(id);
  const batchId = seedSentinelBatch(id);
  seedActivity(id, batchId, 'myco:inject_cortex');
}

describe('phantom-reaper', () => {
  beforeAll(() => { setupTestDb(); });
  beforeEach(() => { cleanTestDb(); });
  afterAll(() => { teardownTestDb(); });

  it('reaps an injection-only transcriptless session and tombstones it with PHANTOM_REAP', () => {
    seedPhantom('ph1');
    expect(sessionLooksInjectionOnly('ph1')).toBe(true);

    const result = reapPhantomSession('ph1', { logger: noopLogger, findTranscript: noTranscript });
    expect(result?.deleted).toBe(true);
    expect(getSession('ph1', ALL_PROJECTS_SCOPE)).toBeNull();
    expect(hasSessionTombstone('ph1')).toBe(true);
    expect(getSessionTombstone('ph1')?.source).toBe(SESSION_TOMBSTONE_SOURCE.PHANTOM_REAP);

    const db = getDatabase();
    expect(db.prepare('SELECT COUNT(*) AS n FROM prompt_batches WHERE session_id = ?').get('ph1')!.n).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM activities WHERE session_id = ?').get('ph1')!.n).toBe(0);
  });

  it('never reaps a session with a real prompt batch', () => {
    seedSession('real1');
    const batchId = seedSentinelBatch('real1');
    seedActivity('real1', batchId, 'myco:inject_cortex');
    const db = getDatabase();
    db.prepare(
      `INSERT INTO prompt_batches (session_id, prompt_number, user_prompt, kind, started_at, created_at, status)
       VALUES (?, 2, 'fix the bug', 'initial', ?, ?, 'active')`,
    ).run('real1', epochSeconds(), epochSeconds());

    expect(sessionLooksInjectionOnly('real1')).toBe(false);
    expect(reapPhantomSession('real1', { logger: noopLogger, findTranscript: noTranscript })).toBeNull();
    expect(getSession('real1', ALL_PROJECTS_SCOPE)).not.toBeNull();
  });

  it('never reaps a session with any non-injection activity', () => {
    seedSession('real2');
    const batchId = seedSentinelBatch('real2');
    seedActivity('real2', batchId, 'myco:inject_cortex');
    seedActivity('real2', batchId, 'Bash');

    expect(sessionLooksInjectionOnly('real2')).toBe(false);
    expect(reapPhantomSession('real2', { logger: noopLogger, findTranscript: noTranscript })).toBeNull();
  });

  it('never reaps a session whose recorded transcript_path exists on disk', () => {
    seedSession('real3', { transcriptPath: '/tmp/some-transcript.jsonl' });
    const batchId = seedSentinelBatch('real3');
    seedActivity('real3', batchId, 'myco:inject_cortex');

    const opts = { logger: noopLogger, findTranscript: noTranscript, transcriptExists: () => true };
    expect(sessionQualifiesForPhantomReap('real3', opts)).toBe(false);
    expect(reapPhantomSession('real3', opts)).toBeNull();
    expect(getSession('real3', ALL_PROJECTS_SCOPE)).not.toBeNull();
  });

  // Regression gate: `transcript_path` records the path an agent declared
  // it would write, and SessionStart stamps it before the file exists. A
  // predicate that reads the column as proof of content stops reaping this
  // whole class, and phantoms accumulate silently.
  it('reaps an injection-only session whose recorded transcript_path is absent from disk', () => {
    seedSession('ph5', { transcriptPath: '/tmp/never-written.jsonl' });
    const batchId = seedSentinelBatch('ph5');
    seedActivity('ph5', batchId, 'myco:inject_cortex');

    const opts = { logger: noopLogger, findTranscript: noTranscript, transcriptExists: () => false };
    expect(sessionLooksInjectionOnly('ph5')).toBe(true);
    expect(sessionQualifiesForPhantomReap('ph5', opts)).toBe(true);
    expect(reapPhantomSession('ph5', opts)?.deleted).toBe(true);
    expect(getSession('ph5', ALL_PROJECTS_SCOPE)).toBeNull();
  });

  it('refuses to reap when the existence check throws (absence unproven)', () => {
    seedSession('ph6', { transcriptPath: '/tmp/unstattable.jsonl' });
    const batchId = seedSentinelBatch('ph6');
    seedActivity('ph6', batchId, 'myco:inject_cortex');

    const boom = () => { throw new Error('stat failed'); };
    expect(sessionQualifiesForPhantomReap('ph6', {
      logger: noopLogger,
      findTranscript: noTranscript,
      transcriptExists: boom,
    })).toBe(false);
  });

  it('never reaps when transcript discovery finds a file on disk (last-moment veto)', () => {
    seedPhantom('ph2');
    const found = () => '/tmp/discovered-transcript.jsonl';
    expect(sessionQualifiesForPhantomReap('ph2', { logger: noopLogger, findTranscript: found })).toBe(false);
    expect(reapPhantomSession('ph2', { logger: noopLogger, findTranscript: found })).toBeNull();
    expect(getSession('ph2', ALL_PROJECTS_SCOPE)).not.toBeNull();
  });

  it('refuses to reap when transcript discovery throws (absence unproven)', () => {
    seedPhantom('ph3');
    const boom = () => { throw new Error('discovery failed'); };
    expect(sessionQualifiesForPhantomReap('ph3', { logger: noopLogger, findTranscript: boom })).toBe(false);
  });

  it('never reaps a sentinel batch that captured a real assistant response', () => {
    seedSession('resp1');
    const batchId = seedSentinelBatch('resp1');
    seedActivity('resp1', batchId, 'myco:inject_cortex');
    // Stop delivered last_assistant_message onto the sentinel — that is
    // captured content, not phantom noise.
    getDatabase().prepare('UPDATE prompt_batches SET response_summary = ? WHERE id = ?')
      .run('the assistant actually answered here', batchId);

    expect(sessionLooksInjectionOnly('resp1')).toBe(false);
    expect(findPhantomCandidates([]).map((c) => c.id)).toEqual([]);
    expect(reapPhantomSession('resp1', { logger: noopLogger, findTranscript: noTranscript })).toBeNull();
  });

  it('refuses to reap while the session has an unconverged buffer (journal may hold real prompts)', () => {
    seedPhantom('buf1');
    const opts = { logger: noopLogger, findTranscript: noTranscript, hasUnconvergedBuffer: () => true };
    expect(sessionQualifiesForPhantomReap('buf1', opts)).toBe(false);
    expect(reapPhantomSession('buf1', opts)).toBeNull();
    expect(getSession('buf1', ALL_PROJECTS_SCOPE)).not.toBeNull();
  });

  it('refuses to reap when the buffer-convergence probe throws (convergence unproven)', () => {
    seedPhantom('buf2');
    const opts = {
      logger: noopLogger,
      findTranscript: noTranscript,
      hasUnconvergedBuffer: () => { throw new Error('probe failed'); },
    };
    expect(sessionQualifiesForPhantomReap('buf2', opts)).toBe(false);
  });

  it('chokepoint re-check: a candidate that gained a real batch after the snapshot is not reaped', () => {
    seedPhantom('race1');
    const snapshot = findPhantomCandidates([]).map((c) => c.id);
    expect(snapshot).toContain('race1');
    // A register/prompt lands between snapshot and delete.
    seedRealBatch('race1', 'surprise, I am real work');
    expect(reapPhantomSession('race1', { logger: noopLogger, findTranscript: noTranscript })).toBeNull();
    expect(getSession('race1', ALL_PROJECTS_SCOPE)).not.toBeNull();
  });

  it('does not resurrect a reaped session via ensureSessionRowExists (tombstone gate)', () => {
    seedPhantom('ph4');
    reapPhantomSession('ph4', { logger: noopLogger, findTranscript: noTranscript });
    expect(hasSessionTombstone('ph4')).toBe(true);

    const created = ensureSessionRowExists({
      sessionId: 'ph4',
      agent: 'claude-code',
      machineId: 'm',
      logger: noopLogger,
      source: 'tool_use' as never,
    });
    expect(created).toBe(false);
    expect(getSession('ph4', ALL_PROJECTS_SCOPE)).toBeNull();
  });

  describe('findPhantomCandidates (maintenance sweep)', () => {
    it('returns aged phantoms, skips active/registered/fresh ones', () => {
      seedPhantom('aged');

      // Fresh phantom: ended 30 seconds ago — inside the age guard.
      seedSession('fresh', { endedAt: epochSeconds() - 30 });
      const freshBatch = seedSentinelBatch('fresh');
      seedActivity('fresh', freshBatch, 'myco:inject_cortex');

      // Still-active phantom-shaped session.
      seedSession('livephantom', { status: 'active', endedAt: null });
      const liveBatch = seedSentinelBatch('livephantom');
      seedActivity('livephantom', liveBatch, 'myco:inject_spores');

      // Aged phantom that is currently registered (TOCTOU guard).
      seedPhantom('registered');

      const ids = findPhantomCandidates(['registered']).map((c) => c.id);
      expect(ids).toEqual(['aged']);
    });

    it('returns a phantom whose transcript_path was stamped but never written', () => {
      seedSession('stamped', { transcriptPath: '/tmp/stamped-never-written.jsonl' });
      const batch = seedSentinelBatch('stamped');
      seedActivity('stamped', batch, 'myco:inject_cortex');

      expect(findPhantomCandidates([]).map((c) => c.id)).toEqual(['stamped']);
    });

    it('sweep reaps a stamped-path phantom and spares one whose file is on disk', async () => {
      seedSession('gone', { transcriptPath: '/tmp/gone.jsonl' });
      seedActivity('gone', seedSentinelBatch('gone'), 'myco:inject_cortex');
      seedSession('here', { transcriptPath: '/tmp/here.jsonl' });
      seedActivity('here', seedSentinelBatch('here'), 'myco:inject_cortex');

      await runSessionMaintenance({
        logger: noopLogger,
        registeredSessionIds: () => [],
        embeddingManager: { onRemoved: () => {} } as never,
        transcriptMiner: { reconcileAndAttributeResponses: () => ({}) } as never,
        resolveProjectVaultDir: () => null,
        findTranscript: () => null,
        transcriptExists: (p) => p === '/tmp/here.jsonl',
      });

      expect(getSession('gone', ALL_PROJECTS_SCOPE)).toBeNull();
      expect(getSession('here', ALL_PROJECTS_SCOPE)).not.toBeNull();
    });

    it('does not return sessions with real batches or real activities', () => {
      seedSession('mixed');
      const b = seedSentinelBatch('mixed');
      seedActivity('mixed', b, 'Edit');
      expect(findPhantomCandidates([]).map((c) => c.id)).toEqual([]);
    });

    it('runSessionMaintenance reaps an aged phantom end-to-end with PHANTOM_REAP source', async () => {
      seedPhantom('sweepme');
      seedSession('keeper');
      seedRealBatch('keeper', 'do real work');

      await runSessionMaintenance({
        logger: noopLogger,
        registeredSessionIds: () => [],
        embeddingManager: { onRemoved: () => {} } as never,
        transcriptMiner: { reconcileAndAttributeResponses: () => ({}) } as never,
        resolveProjectVaultDir: () => null,
        findTranscript: () => null,
      });

      expect(getSession('sweepme', ALL_PROJECTS_SCOPE)).toBeNull();
      expect(getSessionTombstone('sweepme')?.source).toBe(SESSION_TOMBSTONE_SOURCE.PHANTOM_REAP);
      expect(getSession('keeper', ALL_PROJECTS_SCOPE)).not.toBeNull();
    });
  });
});
