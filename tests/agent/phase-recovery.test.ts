import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db';
import { TEST_REQUEST_CONTEXT } from '../helpers/request-context';
import { registerAgent } from '@myco/db/queries/agents.js';
import { setState } from '@myco/db/queries/agent-state.js';
import { insertReport } from '@myco/db/queries/reports.js';
import { insertRun } from '@myco/db/queries/runs.js';
import { insertWriteIntent } from '@myco/db/queries/write-intents.js';
import { buildPhaseRecoveryContext } from '@myco/agent/phase-recovery.js';
import { DEFAULT_AGENT_ID, epochSeconds } from '@myco/constants.js';

const TEST_RUN_ID = 'run-recovery';

function inventoryPayload() {
  return {
    run_id: TEST_RUN_ID,
    merge_candidates: [],
    narrow_candidates: [
      { skill: 'narrow-skill', absorb_into: 'broad-skill', reason: 'single procedure' },
    ],
  };
}

function classificationPayload() {
  return {
    run_id: TEST_RUN_ID,
    classifications: [
      {
        skill_id: 'skill-a',
        name: 'skill-a',
        classification: 'STALE',
        target_skill: null,
        details: 'code path changed',
      },
    ],
    deferred_skills: [],
  };
}

function seedRun(options: { dryRun?: boolean } = {}) {
  insertRun({
    id: TEST_RUN_ID,
    project_id: TEST_REQUEST_CONTEXT.projectId,
    agent_id: DEFAULT_AGENT_ID,
    task: 'skill-evolve',
    status: 'failed',
    started_at: epochSeconds(),
    dryRun: options.dryRun ?? false,
  });
}

describe('phase recovery context', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => {
    cleanTestDb();
    registerAgent({ id: DEFAULT_AGENT_ID, name: 'Myco Agent', created_at: epochSeconds() });
  });

  it('does not add context outside skill-evolve restored phase dependencies', () => {
    seedRun();

    expect(buildPhaseRecoveryContext({
      taskName: 'vault-evolve',
      phaseName: 'assess',
      runId: TEST_RUN_ID,
      agentId: DEFAULT_AGENT_ID,
      requestContext: TEST_REQUEST_CONTEXT,
      restoredPhaseNames: new Set(['inventory']),
    })).toBeNull();
  });

  it('builds assess recovery context from persisted inventory state', () => {
    seedRun();
    setState(DEFAULT_AGENT_ID, TEST_REQUEST_CONTEXT.projectId, 'skill-evolve-inventory', JSON.stringify(inventoryPayload()), epochSeconds());
    insertReport({
      run_id: TEST_RUN_ID,
      agent_id: DEFAULT_AGENT_ID,
      action: 'skill-evolve-inventory',
      summary: 'Inventory selected one narrow skill',
      details: JSON.stringify({ narrow_count: 1 }),
      created_at: epochSeconds(),
    });

    const context = buildPhaseRecoveryContext({
      taskName: 'skill-evolve',
      phaseName: 'assess',
      runId: TEST_RUN_ID,
      agentId: DEFAULT_AGENT_ID,
      requestContext: TEST_REQUEST_CONTEXT,
      restoredPhaseNames: new Set(['inventory']),
    });

    expect(context).toContain('## Durable Phase Recovery Context');
    expect(context).toContain('"skill": "narrow-skill"');
    expect(context).toContain('Inventory selected one narrow skill');
  });

  it('builds dry-run act recovery context from persisted write intents', () => {
    seedRun({ dryRun: true });
    insertReport({
      run_id: TEST_RUN_ID,
      agent_id: DEFAULT_AGENT_ID,
      action: 'assess',
      summary: 'Assessment classified one stale skill',
      details: JSON.stringify(classificationPayload()),
      created_at: epochSeconds(),
    });
    insertWriteIntent({
      runId: TEST_RUN_ID,
      toolName: 'vault_set_state',
      toolInput: JSON.stringify({
        key: 'skill-evolve-classifications',
        value: JSON.stringify(classificationPayload()),
      }),
      syntheticOutput: '{}',
    });

    const context = buildPhaseRecoveryContext({
      taskName: 'skill-evolve',
      phaseName: 'act',
      runId: TEST_RUN_ID,
      agentId: DEFAULT_AGENT_ID,
      requestContext: TEST_REQUEST_CONTEXT,
      dryRun: true,
      restoredPhaseNames: new Set(['assess']),
    });

    expect(context).toContain('"classification": "STALE"');
    expect(context).toContain('Assessment classified one stale skill');
  });
});
