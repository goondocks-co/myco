import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db';
import { upsertSession } from '@myco/db/queries/sessions.js';
import { insertBatch, rehomeSystemActivitiesToHumanAnchor } from '@myco/db/queries/batches.js';
import { insertActivity, listActivities } from '@myco/db/queries/activities.js';
import { ALL_PROJECTS_SCOPE } from '@myco/grove/ids.js';

const now = () => Math.floor(Date.now() / 1000);

/**
 * Activity re-homing backstop: an activity stranded on a system-origin batch
 * (legacy capture, or a live race) must be moved onto the nearest preceding
 * human batch, since the myco agent only analyzes human-origin batches.
 */
describe('rehomeSystemActivitiesToHumanAnchor', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => { cleanTestDb(); });

  function seed(id: string) {
    upsertSession({ id, agent: 'claude-code', started_at: now(), created_at: now() });
  }

  it('moves a system-batch activity onto the preceding human batch', () => {
    seed('s1');
    const human = insertBatch({ session_id: 's1', origin: 'human', started_at: now(), created_at: now() });
    const system = insertBatch({ session_id: 's1', origin: 'system', started_at: now() + 1, created_at: now() + 1 });
    insertActivity({ session_id: 's1', tool_name: 'mcp__myco__myco_search', timestamp: now(), created_at: now(), prompt_batch_id: system.id });

    const changed = rehomeSystemActivitiesToHumanAnchor('s1');
    expect(changed).toBe(1);

    const onHuman = listActivities({ prompt_batch_id: human.id, scope: ALL_PROJECTS_SCOPE });
    const onSystem = listActivities({ prompt_batch_id: system.id, scope: ALL_PROJECTS_SCOPE });
    expect(onHuman).toHaveLength(1);
    expect(onSystem).toHaveLength(0);
  });

  it('leaves human-batch activities untouched', () => {
    seed('s2');
    const human = insertBatch({ session_id: 's2', origin: 'human', started_at: now(), created_at: now() });
    insertActivity({ session_id: 's2', tool_name: 'Read', timestamp: now(), created_at: now(), prompt_batch_id: human.id });

    const changed = rehomeSystemActivitiesToHumanAnchor('s2');
    expect(changed).toBe(0);
    expect(listActivities({ prompt_batch_id: human.id, scope: ALL_PROJECTS_SCOPE })).toHaveLength(1);
  });

  it('does not orphan a system activity that precedes any human batch (no anchor → leave in place)', () => {
    seed('s3');
    const system = insertBatch({ session_id: 's3', origin: 'system', started_at: now(), created_at: now() });
    insertActivity({ session_id: 's3', tool_name: 'Read', timestamp: now(), created_at: now(), prompt_batch_id: system.id });

    const changed = rehomeSystemActivitiesToHumanAnchor('s3');
    expect(changed).toBe(0);
    // The NOT NULL FK forbids orphaning — it stays on the system batch.
    expect(listActivities({ prompt_batch_id: system.id, scope: ALL_PROJECTS_SCOPE })).toHaveLength(1);
  });

  it('anchors to the NEAREST preceding human batch across multiple turns', () => {
    seed('s4');
    const human1 = insertBatch({ session_id: 's4', origin: 'human', started_at: now(), created_at: now() });
    const human2 = insertBatch({ session_id: 's4', origin: 'human', started_at: now() + 10, created_at: now() + 10 });
    const system = insertBatch({ session_id: 's4', origin: 'system', started_at: now() + 11, created_at: now() + 11 });
    insertActivity({ session_id: 's4', tool_name: 'Bash', timestamp: now() + 11, created_at: now() + 11, prompt_batch_id: system.id });

    rehomeSystemActivitiesToHumanAnchor('s4');
    expect(listActivities({ prompt_batch_id: human2.id, scope: ALL_PROJECTS_SCOPE })).toHaveLength(1);
    expect(listActivities({ prompt_batch_id: human1.id, scope: ALL_PROJECTS_SCOPE })).toHaveLength(0);
  });

  it('re-homes agent_dispatch (teammate-message) batch activities too', () => {
    seed('s5');
    const human = insertBatch({ session_id: 's5', origin: 'human', started_at: now(), created_at: now() });
    const dispatch = insertBatch({ session_id: 's5', origin: 'agent_dispatch', started_at: now() + 1, created_at: now() + 1 });
    insertActivity({ session_id: 's5', tool_name: 'mcp__myco__myco_spores', timestamp: now(), created_at: now(), prompt_batch_id: dispatch.id });

    const changed = rehomeSystemActivitiesToHumanAnchor('s5');
    expect(changed).toBe(1);
    expect(listActivities({ prompt_batch_id: human.id, scope: ALL_PROJECTS_SCOPE })).toHaveLength(1);
  });

  it('is idempotent — a second pass changes nothing', () => {
    seed('s6');
    const human = insertBatch({ session_id: 's6', origin: 'human', started_at: now(), created_at: now() });
    const system = insertBatch({ session_id: 's6', origin: 'system', started_at: now() + 1, created_at: now() + 1 });
    insertActivity({ session_id: 's6', tool_name: 'Bash', timestamp: now(), created_at: now(), prompt_batch_id: system.id });

    expect(rehomeSystemActivitiesToHumanAnchor('s6')).toBe(1);
    expect(rehomeSystemActivitiesToHumanAnchor('s6')).toBe(0);
    expect(listActivities({ prompt_batch_id: human.id, scope: ALL_PROJECTS_SCOPE })).toHaveLength(1);
  });
});
