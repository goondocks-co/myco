import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db.js';
import { seedSession, nowSec } from '../helpers/sessions.js';

import {
  buildInjectionContentHash,
  hasInjectionRecord,
  recordInjectionActivity,
} from '@myco/daemon/injection-records.js';
import { insertBatch } from '@myco/db/queries/batches.js';
import { listActivities } from '@myco/db/queries/activities.js';
import { ALL_PROJECTS_SCOPE } from '@myco/grove/ids.js';

function withOpenBatch(sessionId: string, userPrompt = 'hello'): { batchId: number } {
  const batch = insertBatch({
    session_id: sessionId,
    kind: 'initial',
    prompt_number: 1,
    user_prompt: userPrompt,
    started_at: nowSec(),
    created_at: nowSec(),
  });
  return { batchId: batch.id };
}

describe('buildInjectionContentHash', () => {
  it('encodes session in the cortex hash', () => {
    expect(buildInjectionContentHash('cortex', 'sess-abc'))
      .toBe('myco:inject:cortex:sess-abc');
  });
  it('appends discriminator when supplied', () => {
    expect(buildInjectionContentHash('spores', 'sess-abc', 'abc123'))
      .toBe('myco:inject:spores:sess-abc:abc123');
  });
  it('encodes subagent injections as their own synthetic tool namespace', () => {
    expect(buildInjectionContentHash('subagent', 'sess-abc', 'agent-123'))
      .toBe('myco:inject:subagent:sess-abc:agent-123');
  });
  it('omits trailing colon when discriminator is empty string', () => {
    expect(buildInjectionContentHash('cortex', 'sess-abc', ''))
      .toBe('myco:inject:cortex:sess-abc');
  });
});

describe('recordInjectionActivity', () => {
  beforeAll(() => setupTestDb());
  afterAll(() => teardownTestDb());
  beforeEach(() => cleanTestDb());

  it('returns no_batch for spores/canopy when no prompt_batch yet (they fire AFTER a batch exists)', async () => {
    // Spores and canopy injections fire from UserPromptSubmit /
    // PreToolUse respectively, both of which create a batch before
    // the injection fires. Hitting no_batch here is a violation of
    // that contract, so we keep the legacy fall-through — return
    // no_batch and serve the text without manufacturing a sentinel.
    const sessionId = seedSession({ id: 's-no-batch', agent: 'antigravity' });
    const result = await recordInjectionActivity({
      sessionId,
      projectId: null,
      injectionType: 'spores',
      discriminator: 'abc',
      fetchContent: async () => ({ text: 'should never run' }),
    });
    expect(result).toEqual({ injected: false, reason: 'no_batch' });
  });

  it('creates a sentinel batch when CORTEX is recorded with no existing batch (single-shot SessionStart symbionts)', async () => {
    // Cortex fires during SessionStart, BEFORE UserPromptSubmit
    // creates the first real batch. With no_batch fall-through, the
    // cortex injection would never appear in the activities list.
    // The fix manufactures a sentinel batch so the activity has
    // somewhere to attach; `handleUserPrompt` later replaces the
    // sentinel's user_prompt with the real prompt rather than
    // inserting a second batch.
    const { hasAnyBatch } = await import('@myco/db/queries/batches.js');
    const sessionId = seedSession({ id: 's-cortex-recovery', agent: 'codex' });
    expect(hasAnyBatch(sessionId)).toBe(false);
    const result = await recordInjectionActivity({
      sessionId,
      projectId: null,
      injectionType: 'cortex',
      fetchContent: async () => ({ text: 'fake cortex content', metadata: { source: 'cortex' } }),
    });
    expect(result.injected).toBe(true);
    expect(hasAnyBatch(sessionId)).toBe(true);
  });

  it('records the activity and returns the fetched text on first call', async () => {
    const sessionId = seedSession({ id: 's-first', agent: 'antigravity' });
    const { batchId } = withOpenBatch(sessionId);

    let fetchCalls = 0;
    const result = await recordInjectionActivity({
      sessionId,
      projectId: null,
      injectionType: 'cortex',
      trigger: { metadata: { source: 'unit-test' } },
      fetchContent: async () => {
        fetchCalls++;
        return { text: 'fake cortex preamble', metadata: { source: 'cortex' } };
      },
    });

    expect(result).toMatchObject({
      injected: true,
      text: 'fake cortex preamble',
      metadata: { source: 'cortex' },
    });
    expect(fetchCalls).toBe(1);

    const activities = listActivities({ session_id: sessionId, scope: ALL_PROJECTS_SCOPE });
    expect(activities).toHaveLength(1);
    expect(activities[0]!.tool_name).toBe('myco:inject_cortex');
    expect(activities[0]!.content_hash).toBe('myco:inject:cortex:s-first');
    expect(activities[0]!.tool_output_summary).toBe('fake cortex preamble');
    expect(JSON.parse(activities[0]!.tool_input!)).toEqual({ source: 'unit-test' });

    // activity_count on the batch is bumped so the UI's per-batch Tool Calls
    // section surfaces injection rows.
    const { getBatchById } = await import('@myco/db/queries/batches.js');
    const batch = getBatchById(batchId, ALL_PROJECTS_SCOPE);
    expect(batch!.activity_count).toBe(1);
  });

  it('records subagent injection as a prompt-batch activity without incrementing session tool_count', async () => {
    const sessionId = seedSession({ id: 's-subagent', agent: 'codex' });
    const { batchId } = withOpenBatch(sessionId);

    const result = await recordInjectionActivity({
      sessionId,
      projectId: null,
      injectionType: 'subagent',
      discriminator: 'agent-123',
      trigger: { metadata: { source: 'subagent-start', agent_type: 'reviewer' } },
      fetchContent: async () => ({ text: 'subagent primer', metadata: { source: 'subagent-primer' } }),
    });

    expect(result).toMatchObject({
      injected: true,
      text: 'subagent primer',
      metadata: { source: 'subagent-primer' },
    });

    const activities = listActivities({ session_id: sessionId, scope: ALL_PROJECTS_SCOPE });
    expect(activities).toHaveLength(1);
    expect(activities[0]!.tool_name).toBe('myco:inject_subagent');
    expect(activities[0]!.content_hash).toBe('myco:inject:subagent:s-subagent:agent-123');
    expect(JSON.parse(activities[0]!.tool_input!)).toEqual({
      source: 'subagent-start',
      agent_type: 'reviewer',
    });

    const { getBatchById } = await import('@myco/db/queries/batches.js');
    expect(getBatchById(batchId, ALL_PROJECTS_SCOPE)!.activity_count).toBe(1);

    const { getSession } = await import('@myco/db/queries/sessions.js');
    expect(getSession(sessionId, ALL_PROJECTS_SCOPE)!.tool_count).toBe(0);
  });

  it('returns already_recorded on the second call and never invokes the fetch', async () => {
    const sessionId = seedSession({ id: 's-dedup', agent: 'antigravity' });
    withOpenBatch(sessionId);

    await recordInjectionActivity({
      sessionId, projectId: null, injectionType: 'cortex',
      fetchContent: async () => ({ text: 'first run' }),
    });

    let secondFetchCalls = 0;
    const second = await recordInjectionActivity({
      sessionId, projectId: null, injectionType: 'cortex',
      fetchContent: async () => {
        secondFetchCalls++;
        return { text: 'second run' };
      },
    });

    expect(second).toEqual({ injected: false, reason: 'unique_violation' });
    expect(secondFetchCalls).toBe(0);
    // Still only one activity row.
    expect(listActivities({ session_id: sessionId, scope: ALL_PROJECTS_SCOPE })).toHaveLength(1);
  });

  it('scopes dedup per session — same injection type can record once per session', async () => {
    const sessionA = seedSession({ id: 's-A', agent: 'antigravity' });
    const sessionB = seedSession({ id: 's-B', agent: 'antigravity' });
    withOpenBatch(sessionA);
    withOpenBatch(sessionB);

    const a = await recordInjectionActivity({
      sessionId: sessionA, projectId: null, injectionType: 'cortex',
      fetchContent: async () => ({ text: 'A cortex' }),
    });
    const b = await recordInjectionActivity({
      sessionId: sessionB, projectId: null, injectionType: 'cortex',
      fetchContent: async () => ({ text: 'B cortex' }),
    });

    expect(a.injected).toBe(true);
    expect(b.injected).toBe(true);
    expect(listActivities({ session_id: sessionA, scope: ALL_PROJECTS_SCOPE })).toHaveLength(1);
    expect(listActivities({ session_id: sessionB, scope: ALL_PROJECTS_SCOPE })).toHaveLength(1);
  });

  it('scopes dedup per discriminator — same session can record once per (type, discriminator)', async () => {
    const sessionId = seedSession({ id: 's-discrim', agent: 'antigravity' });
    withOpenBatch(sessionId);

    const a = await recordInjectionActivity({
      sessionId, projectId: null, injectionType: 'spores', discriminator: 'prompt-aaa',
      fetchContent: async () => ({ text: 'spores for aaa' }),
    });
    const b = await recordInjectionActivity({
      sessionId, projectId: null, injectionType: 'spores', discriminator: 'prompt-bbb',
      fetchContent: async () => ({ text: 'spores for bbb' }),
    });
    const aAgain = await recordInjectionActivity({
      sessionId, projectId: null, injectionType: 'spores', discriminator: 'prompt-aaa',
      fetchContent: async () => ({ text: 'should not run' }),
    });

    expect(a.injected).toBe(true);
    expect(b.injected).toBe(true);
    expect(aAgain).toEqual({ injected: false, reason: 'unique_violation' });
    expect(listActivities({ session_id: sessionId, scope: ALL_PROJECTS_SCOPE })).toHaveLength(2);
  });

  it('truncates very large injected text to the storage limit', async () => {
    const sessionId = seedSession({ id: 's-trunc', agent: 'antigravity' });
    withOpenBatch(sessionId);

    const giant = 'x'.repeat(20_000);
    const result = await recordInjectionActivity({
      sessionId, projectId: null, injectionType: 'cortex',
      fetchContent: async () => ({ text: giant }),
    });

    expect(result.injected).toBe(true);
    // Caller still receives the full text — only the stored summary is truncated.
    if (result.injected) expect(result.text).toBe(giant);
    const activities = listActivities({ session_id: sessionId, scope: ALL_PROJECTS_SCOPE });
    expect(activities[0]!.tool_output_summary!.length).toBe(8000);
  });

  it('hasInjectionRecord returns true after recordInjectionActivity succeeds', async () => {
    const sessionId = seedSession({ id: 's-has', agent: 'antigravity' });
    withOpenBatch(sessionId);

    expect(hasInjectionRecord(sessionId, 'cortex')).toBe(false);
    await recordInjectionActivity({
      sessionId, projectId: null, injectionType: 'cortex',
      fetchContent: async () => ({ text: 'cortex' }),
    });
    expect(hasInjectionRecord(sessionId, 'cortex')).toBe(true);
    expect(hasInjectionRecord(sessionId, 'spores', 'prompt-x')).toBe(false);
  });

  it('propagates an error from fetchContent without leaving a phantom success', async () => {
    const sessionId = seedSession({ id: 's-throw', agent: 'antigravity' });
    withOpenBatch(sessionId);

    let attempt = 0;
    await expect(recordInjectionActivity({
      sessionId, projectId: null, injectionType: 'cortex',
      fetchContent: async () => {
        attempt++;
        throw new Error('content unavailable');
      },
    })).rejects.toThrow('content unavailable');

    // The placeholder activity row IS in place (NULL tool_output_summary)
    // — this is intentional: it dedup-blocks retries until the row is
    // explicitly cleared. Operators identify failed injections by querying
    // myco:* activities with NULL output_summary.
    const activities = listActivities({ session_id: sessionId, scope: ALL_PROJECTS_SCOPE });
    expect(activities).toHaveLength(1);
    expect(activities[0]!.tool_output_summary).toBeNull();
    expect(attempt).toBe(1);

    // Subsequent call sees the placeholder and short-circuits to already_recorded.
    const second = await recordInjectionActivity({
      sessionId, projectId: null, injectionType: 'cortex',
      fetchContent: async () => ({ text: 'should not run' }),
    });
    expect(second).toEqual({ injected: false, reason: 'unique_violation' });
  });
});
