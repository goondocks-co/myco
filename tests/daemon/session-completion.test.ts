/**
 * Tests for the daemon-level session-completion chokepoint
 * (`daemon/session-completion.ts`): final transcript-mining convergence
 * BEFORE the status flip, on every completion path. The routed-transcript
 * cache GC's safety invariant — "completed implies mined" — lives here.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db';
import { upsertSession, getSession } from '@myco/db/queries/sessions.js';
import { completeSessionWithMining } from '@myco/daemon/session-completion.js';
import { MS_PER_SECOND } from '@myco/constants.js';
import { ALL_PROJECTS_SCOPE } from '@myco/grove/ids.js';

const epochNow = () => Math.floor(Date.now() / MS_PER_SECOND);

describe('completeSessionWithMining', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => { cleanTestDb(); });

  it('mines the stamped transcript BEFORE the status flip, then closes', () => {
    const now = epochNow();
    upsertSession({
      id: 'cw-mined',
      agent: 'claude-code',
      started_at: now,
      created_at: now,
      status: 'active',
      transcript_path: '/routed/materialized/cw-mined.jsonl',
    });

    const observed: Array<{ sessionId: string; agent: string; transcriptPath: string; statusAtMineTime: string }> = [];
    const result = completeSessionWithMining('cw-mined', now, {
      transcriptMiner: {
        reconcileAndAttributeResponses(sessionId, input) {
          // Ordering proof: the row must still be ACTIVE while the mine
          // runs — the flip happens strictly after convergence.
          const statusAtMineTime = getSession(sessionId, ALL_PROJECTS_SCOPE)!.status;
          observed.push({ sessionId, ...input, statusAtMineTime });
          return {};
        },
      },
    });

    expect(observed).toEqual([{
      sessionId: 'cw-mined',
      agent: 'claude-code',
      transcriptPath: '/routed/materialized/cw-mined.jsonl',
      statusAtMineTime: 'active',
    }]);
    expect(result?.status).toBe('completed');
    expect(getSession('cw-mined', ALL_PROJECTS_SCOPE)?.status).toBe('completed');
  });

  it('skips mining when the session has no transcript source, and still closes', () => {
    const now = epochNow();
    upsertSession({
      id: 'cw-no-source',
      agent: 'claude-code',
      started_at: now,
      created_at: now,
      status: 'active',
    });

    let mined = 0;
    const result = completeSessionWithMining('cw-no-source', now, {
      transcriptMiner: { reconcileAndAttributeResponses: () => { mined += 1; return {}; } },
    });

    expect(mined).toBe(0);
    expect(result?.status).toBe('completed');
  });

  it('a mining failure is caught and the close still proceeds (never a zombie active)', () => {
    const now = epochNow();
    upsertSession({
      id: 'cw-mine-throws',
      agent: 'claude-code',
      started_at: now,
      created_at: now,
      status: 'active',
      transcript_path: '/routed/materialized/cw-mine-throws.jsonl',
    });

    const warns: string[] = [];
    const result = completeSessionWithMining('cw-mine-throws', now, {
      transcriptMiner: {
        reconcileAndAttributeResponses: () => { throw new Error('miner exploded'); },
      },
      logger: { warn: (_kind, message) => { warns.push(message); } },
    });

    expect(result?.status).toBe('completed');
    expect(warns.length).toBe(1);
  });

  it('returns null for a nonexistent session without invoking the miner', () => {
    let mined = 0;
    const result = completeSessionWithMining('cw-missing', epochNow(), {
      transcriptMiner: { reconcileAndAttributeResponses: () => { mined += 1; return {}; } },
    });

    expect(result).toBeNull();
    expect(mined).toBe(0);
  });
});
