import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db.js';
import { nowSec, seedSession } from '../helpers/sessions.js';
import { handleUserPrompt } from '@myco/daemon/event-handlers.js';
import { listBatchesBySession } from '@myco/db/queries/batches.js';
import { getDatabase } from '@myco/db/client.js';
import { ALL_PROJECTS_SCOPE } from '@myco/grove/ids.js';

describe('handleUserPrompt steering nesting', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(teardownTestDb);

  beforeEach(() => {
    cleanTestDb();
    seedSession({ id: 's1' });
  });

  it('creates an initial batch with kind=initial and no parent', () => {
    const { batchId } = handleUserPrompt('s1', 'first', { kind: 'initial' });
    const batches = listBatchesBySession('s1', { scope: ALL_PROJECTS_SCOPE });
    expect(batches).toHaveLength(1);
    expect(batches[0].id).toBe(batchId);
    expect(batches[0].kind).toBe('initial');
    expect(batches[0].parent_prompt_batch_id).toBeNull();
    expect(batches[0].ended_at).toBeNull();
  });

  it('steering creates a child, keeps parent open, parent_prompt_batch_id points at parent', () => {
    const { batchId: parentId } = handleUserPrompt('s1', 'first', { kind: 'initial' });
    const { batchId: childId } = handleUserPrompt('s1', 'steer me', { kind: 'steering' });

    const batches = listBatchesBySession('s1', { scope: ALL_PROJECTS_SCOPE });
    expect(batches).toHaveLength(2);

    const parent = batches.find((b) => b.id === parentId)!;
    const child = batches.find((b) => b.id === childId)!;

    // Parent should still be open
    expect(parent.ended_at).toBeNull();

    // Child should be steering with parent link
    expect(child.kind).toBe('steering');
    expect(child.parent_prompt_batch_id).toBe(parentId);
  });

  it('steering with no open parent falls back to kind=initial with null parent', () => {
    // Close any batches first by sending an initial and then closing it
    const { batchId: firstId } = handleUserPrompt('s1', 'first', { kind: 'initial' });
    const db = getDatabase();
    db.prepare(`UPDATE prompt_batches SET ended_at = ? WHERE id = ?`).run(nowSec(), firstId);

    // Now send steering — no open parent exists
    const { batchId: fallbackId } = handleUserPrompt('s1', 'steer with no parent', { kind: 'steering' });

    const batches = listBatchesBySession('s1', { scope: ALL_PROJECTS_SCOPE });
    const fallback = batches.find((b) => b.id === fallbackId)!;
    expect(fallback.kind).toBe('initial');
    expect(fallback.parent_prompt_batch_id).toBeNull();
  });

  it('backwards-compat: no options still creates a valid initial batch', () => {
    const { batchId } = handleUserPrompt('s1', 'legacy prompt');
    const batches = listBatchesBySession('s1', { scope: ALL_PROJECTS_SCOPE });
    expect(batches).toHaveLength(1);
    expect(batches[0].id).toBe(batchId);
    expect(batches[0].kind).toBe('initial');
    expect(batches[0].parent_prompt_batch_id).toBeNull();
  });

  it('defaults origin to human when omitted', () => {
    const { batchId } = handleUserPrompt('s1', 'legacy prompt');
    const batches = listBatchesBySession('s1', { scope: ALL_PROJECTS_SCOPE });
    expect(batches.find((b) => b.id === batchId)!.origin).toBe('human');
  });

  it('round-trips an origin override (system / agent_dispatch) onto the row', () => {
    const { batchId: sysId } = handleUserPrompt('s1', '<task-notification>foo', { origin: 'system' });
    const { batchId: agentId } = handleUserPrompt('s1', '<teammate-message ...', { origin: 'agent_dispatch' });
    const batches = listBatchesBySession('s1', { scope: ALL_PROJECTS_SCOPE });
    expect(batches.find((b) => b.id === sysId)!.origin).toBe('system');
    expect(batches.find((b) => b.id === agentId)!.origin).toBe('agent_dispatch');
  });

  // A human prompt arriving while a non-human batch (system task-notification /
  // agent_dispatch teammate-message) is the open parent must NOT nest under it
  // — it owns its own turn. Regression for the audit finding where a question
  // queued during a task-notification became that notification's steering child
  // with no response of its own.
  it('promotes a human steering prompt to initial when the open parent is system-origin', () => {
    const { batchId: notifId } = handleUserPrompt('s1', '<task-notification>done', { kind: 'initial', origin: 'system' });
    const { batchId: humanId } = handleUserPrompt('s1', 'a real question', { kind: 'steering', origin: 'human' });
    const batches = listBatchesBySession('s1', { scope: ALL_PROJECTS_SCOPE });
    const human = batches.find((b) => b.id === humanId)!;
    expect(human.kind).toBe('initial');
    expect(human.parent_prompt_batch_id).toBeNull();
    // The task-notification batch is untouched.
    expect(batches.find((b) => b.id === notifId)!.kind).toBe('initial');
  });

  it('still nests a human steering prompt under a human initial parent', () => {
    const { batchId: parentId } = handleUserPrompt('s1', 'human turn', { kind: 'initial', origin: 'human' });
    const { batchId: steerId } = handleUserPrompt('s1', 'refine it', { kind: 'steering', origin: 'human' });
    const batches = listBatchesBySession('s1', { scope: ALL_PROJECTS_SCOPE });
    const steer = batches.find((b) => b.id === steerId)!;
    expect(steer.kind).toBe('steering');
    expect(steer.parent_prompt_batch_id).toBe(parentId);
  });

  // Human-Anchored Turn: a system-origin prompt is recorded as a point-in-time,
  // already-closed batch. It must NOT close the open human batch (the human turn
  // stays the active anchor for activities/responses), and the system batch is
  // born closed (ended_at set), so it is never the "most-recent-open" target.
  describe('system-origin prompts are point-in-time closed records', () => {
    it('does not close the open human batch when a system prompt arrives', () => {
      const { batchId: humanId } = handleUserPrompt('s1', 'real work', { kind: 'initial', origin: 'human' });
      handleUserPrompt('s1', '<task-notification>done', { kind: 'initial', origin: 'system' });
      const batches = listBatchesBySession('s1', { scope: ALL_PROJECTS_SCOPE });
      const human = batches.find((b) => b.id === humanId)!;
      // The human turn remains the active anchor.
      expect(human.ended_at).toBeNull();
    });

    it('records the system batch closed (ended_at == created_at)', () => {
      const { batchId: sysId } = handleUserPrompt('s1', '<task-notification>done', { kind: 'initial', origin: 'system' });
      const sys = listBatchesBySession('s1', { scope: ALL_PROJECTS_SCOPE }).find((b) => b.id === sysId)!;
      expect(sys.ended_at).not.toBeNull();
      expect(sys.ended_at).toBe(sys.created_at);
    });

    it('records an agent_dispatch (teammate-message) batch closed too', () => {
      const { batchId: agentId } = handleUserPrompt('s1', '<teammate-message ...', { kind: 'initial', origin: 'agent_dispatch' });
      const agent = listBatchesBySession('s1', { scope: ALL_PROJECTS_SCOPE }).find((b) => b.id === agentId)!;
      expect(agent.ended_at).not.toBeNull();
    });

    it('leaves the human batch as the only open anchor after interleaved system events', () => {
      handleUserPrompt('s1', 'human turn', { kind: 'initial', origin: 'human' });
      handleUserPrompt('s1', '<task-notification>a', { kind: 'initial', origin: 'system' });
      handleUserPrompt('s1', '<task-notification>b', { kind: 'initial', origin: 'system' });
      const open = listBatchesBySession('s1', { scope: ALL_PROJECTS_SCOPE }).filter((b) => b.ended_at === null);
      expect(open).toHaveLength(1);
      expect(open[0].origin).toBe('human');
    });

    it('a human prompt still closes the prior human turn (normal turn boundary)', () => {
      const { batchId: firstId } = handleUserPrompt('s1', 'first', { kind: 'initial', origin: 'human' });
      handleUserPrompt('s1', 'second', { kind: 'initial', origin: 'human' });
      const first = listBatchesBySession('s1', { scope: ALL_PROJECTS_SCOPE }).find((b) => b.id === firstId)!;
      expect(first.ended_at).not.toBeNull();
    });
  });
});
