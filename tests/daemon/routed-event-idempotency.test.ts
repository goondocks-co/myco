/**
 * Idempotent routed-capture sink (residency design §4a). The member stamps each
 * discrete `/events` event with a source-assigned, identity-bearing id
 * (`capture/event-id.ts`); these tests drive the REAL host handlers to prove the
 * dedup contract that closes the C5 double-delivery finding:
 *
 *  - a re-delivery of the SAME event id (live+drain, lost-ack retry, and a replay
 *    arriving AFTER the 10 s live-dedup window — the ledger has no time window)
 *    collapses to ONE row;
 *  - two genuinely-distinct but content-identical events (different ids) stay TWO
 *    rows — the per-event-not-per-content property a content hash could not give;
 *  - a deduped user_prompt replay returns the SAME batch the first delivery opened;
 *  - the local path (no id) is byte-for-byte today's behavior (no dedup).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db.js';
import { seedSession } from '../helpers/sessions.js';
import { handleUserPrompt, handleToolUse, handleToolFailure } from '@myco/daemon/event-handlers.js';
import { listBatchesBySession } from '@myco/db/queries/batches.js';
import { listActivities } from '@myco/db/queries/activities.js';
import { getRoutedEventDedup } from '@myco/db/queries/routed-event-dedup.js';
import { ensureEventId, readEventId } from '@myco/capture/event-id.js';
import { ALL_PROJECTS_SCOPE } from '@myco/grove/ids.js';

const MACHINE = 'alice_a1b2c3d4';
const eid = (suffix: string) => `${MACHINE}:${suffix}`;

const batchCount = (s: string) => listBatchesBySession(s, { scope: ALL_PROJECTS_SCOPE }).length;
const activityCount = (s: string) => listActivities({ session_id: s, scope: ALL_PROJECTS_SCOPE }).length;

describe('routed-capture idempotency (host sink, §4a)', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(teardownTestDb);
  beforeEach(() => { cleanTestDb(); seedSession({ id: 's1' }); });

  // --- user_prompt --------------------------------------------------------

  it('same event id delivered twice → ONE batch (live+drain / lost-ack / beyond-window)', () => {
    const opts = { sourceEventId: eid('evt-1'), sourceMachineId: MACHINE };
    const first = handleUserPrompt('s1', 'do the thing', opts);
    const second = handleUserPrompt('s1', 'do the thing', opts); // the drain-replay (or a lost-ack retry)
    expect(batchCount('s1')).toBe(1);
    // The deduped replay returns the SAME batch the first delivery opened.
    expect(second.batchId).toBe(first.batchId);
    // Ledger records origin (machine_id) for tracing.
    expect(getRoutedEventDedup(eid('evt-1'))?.machine_id).toBe(MACHINE);
  });

  it('two DISTINCT events with identical content → TWO batches (legitimate repeat preserved)', () => {
    handleUserPrompt('s1', 'continue', { sourceEventId: eid('evt-a'), sourceMachineId: MACHINE });
    handleUserPrompt('s1', 'continue', { sourceEventId: eid('evt-b'), sourceMachineId: MACHINE });
    expect(batchCount('s1')).toBe(2); // a content hash would have wrongly collapsed these
  });

  it('local path (no event id) does NOT dedup — unchanged behavior', () => {
    handleUserPrompt('s1', 'same', {});
    handleUserPrompt('s1', 'same', {});
    expect(batchCount('s1')).toBe(2);
  });

  // --- tool_use / tool_failure -------------------------------------------

  it('tool_use: same id dedups to one activity; distinct ids stay two', () => {
    const args = ['s1', 'claude', 'Read', { file_path: '/x' }, undefined, '/root', undefined] as const;
    handleToolUse(...args, eid('tu-1'), MACHINE);
    handleToolUse(...args, eid('tu-1'), MACHINE); // replay
    expect(activityCount('s1')).toBe(1);
    handleToolUse(...args, eid('tu-2'), MACHINE); // a genuinely distinct tool call
    expect(activityCount('s1')).toBe(2);
  });

  it('tool_use: local path (no id) does not dedup', () => {
    const args = ['s1', 'claude', 'Read', { file_path: '/x' }, undefined, '/root', undefined] as const;
    handleToolUse(...args);
    handleToolUse(...args);
    expect(activityCount('s1')).toBe(2);
  });

  it('tool_failure: same id dedups to one activity', () => {
    handleToolFailure('s1', 'claude', 'Bash', { cmd: 'x' }, 'boom', false, eid('tf-1'), MACHINE);
    handleToolFailure('s1', 'claude', 'Bash', { cmd: 'x' }, 'boom', false, eid('tf-1'), MACHINE);
    expect(activityCount('s1')).toBe(1);
  });

  // --- mixed: a full replayed turn collapses ------------------------------

  it('a whole replayed turn (prompt + two tools) collapses to the originals', () => {
    const deliver = () => {
      handleUserPrompt('s1', 'turn', { sourceEventId: eid('p'), sourceMachineId: MACHINE });
      handleToolUse('s1', 'claude', 'Read', { file_path: '/a' }, undefined, '/root', undefined, eid('t1'), MACHINE);
      handleToolUse('s1', 'claude', 'Edit', { file_path: '/b' }, undefined, '/root', undefined, eid('t2'), MACHINE);
    };
    deliver(); // live
    deliver(); // drain-replay of the identical turn
    expect(batchCount('s1')).toBe(1);
    expect(activityCount('s1')).toBe(2);
  });
});

// --- member-side id stamping (the load-bearing "identical id" property) ----

describe('ensureEventId (member stamp, §4a)', () => {
  it('stamps a machine-prefixed id once and keeps it stable across re-stamps', () => {
    const once = ensureEventId({ type: 'user_prompt', session_id: 's' }, MACHINE);
    const id = readEventId(once);
    expect(id).not.toBeNull();
    expect(id!.startsWith(`${MACHINE}:`)).toBe(true);
    // Re-stamping an already-stamped event (the drain-replayed buffer record) keeps
    // the SAME id — this is why the live-forward and the replay dedup against it.
    expect(readEventId(ensureEventId(once, MACHINE))).toBe(id);
  });

  it('two distinct events get DIFFERENT ids (per-event, not per-content)', () => {
    const a = readEventId(ensureEventId({ type: 'user_prompt', session_id: 's', prompt: 'hi' }, MACHINE));
    const b = readEventId(ensureEventId({ type: 'user_prompt', session_id: 's', prompt: 'hi' }, MACHINE));
    expect(a).not.toBe(b);
  });

  it('is non-mutating — the caller keeps the untouched body', () => {
    const original = { type: 'user_prompt', session_id: 's' };
    ensureEventId(original, MACHINE);
    expect('event_id' in original).toBe(false);
  });
});
