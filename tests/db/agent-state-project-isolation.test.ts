import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { getDatabase } from '@myco/db/client.js';
import {
  setupTestDb,
  cleanTestDb,
  teardownTestDb,
} from '../helpers/db.js';
import {
  setState,
  getState,
  getStatesForAgent,
} from '@myco/db/queries/agent-state.js';
import { createProjectId } from '@myco/grove/ids.js';

const AGENT_ID = 'myco-skill-survey';

function seedAgent(id: string, now: number): void {
  const db = getDatabase();
  db.prepare(
    `INSERT OR IGNORE INTO agents (id, name, created_at) VALUES (?, ?, ?)`,
  ).run(id, `agent-${id}`, now);
}

describe('agent_state project isolation', () => {
  beforeAll(() => {
    setupTestDb();
  });

  beforeEach(() => {
    cleanTestDb();
  });

  afterAll(() => {
    teardownTestDb();
  });

  it('two projects in the same Grove maintain independent watermarks', () => {
    const projectA = createProjectId();
    const projectB = createProjectId();
    const now = 1700000000;
    seedAgent(AGENT_ID, now);

    setState(AGENT_ID, projectA, 'survey_watermark', '12345', now);

    const stateB = getState(AGENT_ID, projectB, 'survey_watermark');
    expect(stateB).toBeNull();

    const stateA = getState(AGENT_ID, projectA, 'survey_watermark');
    expect(stateA?.value).toBe('12345');
  });

  it('listing states for an agent filters by project', () => {
    const projectA = createProjectId();
    const projectB = createProjectId();
    const now = 1700000000;
    seedAgent(AGENT_ID, now);

    setState(AGENT_ID, projectA, 'cursor', 'a-cursor', now);
    setState(AGENT_ID, projectB, 'cursor', 'b-cursor', now);

    const aStates = getStatesForAgent(AGENT_ID, projectA);
    expect(aStates).toHaveLength(1);
    expect(aStates[0]?.value).toBe('a-cursor');

    const bStates = getStatesForAgent(AGENT_ID, projectB);
    expect(bStates).toHaveLength(1);
    expect(bStates[0]?.value).toBe('b-cursor');
  });
});
