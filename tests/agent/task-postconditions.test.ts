import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db';
import { registerAgent } from '@myco/db/queries/agents.js';
import { setState } from '@myco/db/queries/agent-state.js';
import { insertReport } from '@myco/db/queries/reports.js';
import { insertRun } from '@myco/db/queries/runs.js';
import { insertTurn } from '@myco/db/queries/turns.js';
import { insertWriteIntent } from '@myco/db/queries/write-intents.js';
import { validateTaskPostconditions } from '@myco/agent/task-postconditions.js';
import { DEFAULT_AGENT_ID, epochSeconds } from '@myco/constants.js';

const TEST_PROJECT_ID = 'proj_skill_evolve_postconditions';
const TEST_RUN_ID = 'run-skill-evolve';
const CUSTOM_AGENT_ID = 'custom-skill-evolve-agent';
const TITLE_SUMMARY_RUN_ID = 'run-title-summary';

function inventoryPayload(runId = TEST_RUN_ID) {
  return {
    run_id: runId,
    merge_candidates: [
      { source: 'narrow-a', target: 'broad-a', reason: 'overlap' },
    ],
    narrow_candidates: [
      { skill: 'tiny-skill', absorb_into: 'broad-a', reason: 'single workflow' },
    ],
  };
}

function classificationPayload(
  runId = TEST_RUN_ID,
  classification: 'CURRENT' | 'STALE' = 'STALE',
) {
  return {
    run_id: runId,
    classifications: [
      {
        skill_id: 'skill-a',
        name: 'skill-a',
        classification,
        target_skill: null,
        details: 'needs update',
      },
    ],
    deferred_skills: ['skill-b'],
  };
}

function seedRun(options: { dryRun?: boolean; agentId?: string } = {}) {
  insertRun({
    id: TEST_RUN_ID,
    project_id: TEST_PROJECT_ID,
    agent_id: options.agentId ?? DEFAULT_AGENT_ID,
    task: 'skill-evolve',
    status: 'running',
    started_at: epochSeconds(),
    dryRun: options.dryRun ?? false,
  });
}

function insertSkillEvolveReports(
  runId = TEST_RUN_ID,
  assessPayload = classificationPayload(runId),
  agentId = DEFAULT_AGENT_ID,
) {
  insertReport({
    run_id: runId,
    agent_id: agentId,
    action: 'skill-evolve-inventory',
    summary: 'Inventory complete',
    details: JSON.stringify({ merge_count: 1, narrow_count: 1 }),
    created_at: epochSeconds(),
  });
  insertReport({
    run_id: runId,
    agent_id: agentId,
    action: 'assess',
    summary: 'Assess complete',
    details: JSON.stringify(assessPayload),
    created_at: epochSeconds() + 1,
  });
}

describe('task postconditions', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => {
    cleanTestDb();
    registerAgent({ id: DEFAULT_AGENT_ID, name: 'Myco Agent', created_at: epochSeconds() });
  });

  it('accepts skill-evolve when reports and persisted state agree', () => {
    seedRun();
    insertSkillEvolveReports();
    setState(DEFAULT_AGENT_ID, TEST_PROJECT_ID, 'skill-evolve-inventory', JSON.stringify(inventoryPayload()), epochSeconds());
    setState(DEFAULT_AGENT_ID, TEST_PROJECT_ID, 'skill-evolve-classifications', JSON.stringify(classificationPayload()), epochSeconds());

    expect(validateTaskPostconditions({ runId: TEST_RUN_ID, taskName: 'skill-evolve' })).toBeNull();
  });

  it('validates persisted skill-evolve state under the run agent', () => {
    registerAgent({ id: CUSTOM_AGENT_ID, name: 'Custom Agent', created_at: epochSeconds() });
    seedRun({ agentId: CUSTOM_AGENT_ID });
    insertSkillEvolveReports(TEST_RUN_ID, classificationPayload(TEST_RUN_ID, 'STALE'), CUSTOM_AGENT_ID);
    setState(
      DEFAULT_AGENT_ID,
      TEST_PROJECT_ID,
      'skill-evolve-inventory',
      JSON.stringify(inventoryPayload(TEST_RUN_ID)),
      epochSeconds(),
    );
    setState(
      DEFAULT_AGENT_ID,
      TEST_PROJECT_ID,
      'skill-evolve-classifications',
      JSON.stringify(classificationPayload(TEST_RUN_ID, 'CURRENT')),
      epochSeconds(),
    );
    setState(
      CUSTOM_AGENT_ID,
      TEST_PROJECT_ID,
      'skill-evolve-inventory',
      JSON.stringify(inventoryPayload(TEST_RUN_ID)),
      epochSeconds(),
    );
    setState(
      CUSTOM_AGENT_ID,
      TEST_PROJECT_ID,
      'skill-evolve-classifications',
      JSON.stringify(classificationPayload(TEST_RUN_ID, 'STALE')),
      epochSeconds(),
    );

    expect(validateTaskPostconditions({ runId: TEST_RUN_ID, taskName: 'skill-evolve' })).toBeNull();
  });

  it('fails skill-evolve when the inventory report is missing', () => {
    seedRun();

    expect(validateTaskPostconditions({ runId: TEST_RUN_ID, taskName: 'skill-evolve' }))
      .toBe('skill-evolve completed without a skill-evolve-inventory report');
  });

  it('fails skill-evolve when classification state does not match the assess report', () => {
    seedRun();
    insertSkillEvolveReports(TEST_RUN_ID, classificationPayload(TEST_RUN_ID, 'STALE'));
    setState(DEFAULT_AGENT_ID, TEST_PROJECT_ID, 'skill-evolve-inventory', JSON.stringify(inventoryPayload()), epochSeconds());
    setState(DEFAULT_AGENT_ID, TEST_PROJECT_ID, 'skill-evolve-classifications', JSON.stringify(classificationPayload(TEST_RUN_ID, 'CURRENT')), epochSeconds());

    expect(validateTaskPostconditions({ runId: TEST_RUN_ID, taskName: 'skill-evolve' }))
      .toBe('skill-evolve classifications state does not match assess report');
  });

  it('accepts dry-run skill-evolve when set-state write intents agree with the assess report', () => {
    seedRun({ dryRun: true });
    insertSkillEvolveReports();
    insertWriteIntent({
      runId: TEST_RUN_ID,
      toolName: 'vault_set_state',
      toolInput: JSON.stringify({
        key: 'skill-evolve-inventory',
        value: JSON.stringify(inventoryPayload()),
      }),
      syntheticOutput: '{}',
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

    expect(validateTaskPostconditions({ runId: TEST_RUN_ID, taskName: 'skill-evolve', dryRun: true })).toBeNull();
  });

  it('accepts skill-evolve when report details summarize longer persisted classification details', () => {
    seedRun({ dryRun: true });
    insertSkillEvolveReports(TEST_RUN_ID, classificationPayload(TEST_RUN_ID, 'STALE'));
    insertWriteIntent({
      runId: TEST_RUN_ID,
      toolName: 'vault_set_state',
      toolInput: JSON.stringify({
        key: 'skill-evolve-inventory',
        value: JSON.stringify(inventoryPayload()),
      }),
      syntheticOutput: '{}',
    });
    insertWriteIntent({
      runId: TEST_RUN_ID,
      toolName: 'vault_set_state',
      toolInput: JSON.stringify({
        key: 'skill-evolve-classifications',
        value: JSON.stringify({
          ...classificationPayload(TEST_RUN_ID, 'STALE'),
          classifications: [
            {
              ...classificationPayload(TEST_RUN_ID, 'STALE').classifications[0],
              details: 'Longer evidence payload for the act phase; report details may be summarized.',
            },
          ],
        }),
      }),
      syntheticOutput: '{}',
    });

    expect(validateTaskPostconditions({ runId: TEST_RUN_ID, taskName: 'skill-evolve', dryRun: true })).toBeNull();
  });

  it('fails dry-run skill-evolve without a classification write intent', () => {
    seedRun({ dryRun: true });
    insertSkillEvolveReports();
    insertWriteIntent({
      runId: TEST_RUN_ID,
      toolName: 'vault_set_state',
      toolInput: JSON.stringify({
        key: 'skill-evolve-inventory',
        value: JSON.stringify(inventoryPayload()),
      }),
      syntheticOutput: '{}',
    });

    expect(validateTaskPostconditions({ runId: TEST_RUN_ID, taskName: 'skill-evolve', dryRun: true }))
      .toBe('skill-evolve dry-run completed without a valid skill-evolve-classifications write intent');
  });
});

describe('title-summary task postconditions', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => {
    cleanTestDb();
    registerAgent({ id: DEFAULT_AGENT_ID, name: 'Myco Agent', created_at: epochSeconds() });
    insertRun({
      id: TITLE_SUMMARY_RUN_ID,
      project_id: TEST_PROJECT_ID,
      agent_id: DEFAULT_AGENT_ID,
      task: 'title-summary',
      status: 'running',
      started_at: epochSeconds(),
    });
  });

  it('accepts a summary report when sessions were updated', () => {
    insertTurn({
      run_id: TITLE_SUMMARY_RUN_ID,
      agent_id: DEFAULT_AGENT_ID,
      turn_number: 1,
      tool_name: 'vault_update_session',
    });
    insertReport({
      run_id: TITLE_SUMMARY_RUN_ID,
      agent_id: DEFAULT_AGENT_ID,
      action: 'summary',
      summary: 'Sessions updated: 2, sessions skipped: 0',
      details: JSON.stringify({ run_id: TITLE_SUMMARY_RUN_ID, updated: 2, skipped: 0 }),
      created_at: epochSeconds(),
    });

    expect(validateTaskPostconditions({ runId: TITLE_SUMMARY_RUN_ID, taskName: 'title-summary' })).toBeNull();
  });

  it('accepts a zero-update summary report with structured details', () => {
    insertReport({
      run_id: TITLE_SUMMARY_RUN_ID,
      agent_id: DEFAULT_AGENT_ID,
      action: 'summary',
      summary: 'Sessions updated: 0, sessions skipped: 3 (already current)',
      details: JSON.stringify({ run_id: TITLE_SUMMARY_RUN_ID, updated: 0, skipped: 3 }),
      created_at: epochSeconds(),
    });

    expect(validateTaskPostconditions({ runId: TITLE_SUMMARY_RUN_ID, taskName: 'title-summary' })).toBeNull();
  });

  it('accepts a zero-update summary report with updated as a numeric string', () => {
    insertReport({
      run_id: TITLE_SUMMARY_RUN_ID,
      agent_id: DEFAULT_AGENT_ID,
      action: 'summary',
      summary: 'Sessions updated: 0, sessions skipped: 3 (already current)',
      details: JSON.stringify({ run_id: TITLE_SUMMARY_RUN_ID, updated: '0', skipped: 3 }),
      created_at: epochSeconds(),
    });

    expect(validateTaskPostconditions({ runId: TITLE_SUMMARY_RUN_ID, taskName: 'title-summary' })).toBeNull();
  });

  it('fails on a summary report with updated as an empty string', () => {
    insertReport({
      run_id: TITLE_SUMMARY_RUN_ID,
      agent_id: DEFAULT_AGENT_ID,
      action: 'summary',
      summary: 'Sessions updated: , sessions skipped: 0',
      details: JSON.stringify({ run_id: TITLE_SUMMARY_RUN_ID, updated: '', skipped: 0 }),
      created_at: epochSeconds(),
    });

    expect(validateTaskPostconditions({ runId: TITLE_SUMMARY_RUN_ID, taskName: 'title-summary' }))
      .toBe('title-summary completed without vault_update_session or a report showing zero updates');
  });

  it('accepts an explicit skip report (backward compat)', () => {
    insertReport({
      run_id: TITLE_SUMMARY_RUN_ID,
      agent_id: DEFAULT_AGENT_ID,
      action: 'skip',
      summary: 'No unprocessed sessions',
      details: null,
      created_at: epochSeconds(),
    });

    expect(validateTaskPostconditions({ runId: TITLE_SUMMARY_RUN_ID, taskName: 'title-summary' })).toBeNull();
  });

  it('fails when there is no update call and no report at all', () => {
    expect(validateTaskPostconditions({ runId: TITLE_SUMMARY_RUN_ID, taskName: 'title-summary' }))
      .toBe('title-summary completed without calling vault_report');
  });

  it('fails on a summary report without parseable zero-update details (the incident shape)', () => {
    insertReport({
      run_id: TITLE_SUMMARY_RUN_ID,
      agent_id: DEFAULT_AGENT_ID,
      action: 'summary',
      summary: 'Sessions updated: 0, sessions skipped: 0',
      details: null,
      created_at: epochSeconds(),
    });

    expect(validateTaskPostconditions({ runId: TITLE_SUMMARY_RUN_ID, taskName: 'title-summary' }))
      .toBe('title-summary completed without vault_update_session or a report showing zero updates');
  });

  it('fails on a summary report with malformed details JSON', () => {
    insertReport({
      run_id: TITLE_SUMMARY_RUN_ID,
      agent_id: DEFAULT_AGENT_ID,
      action: 'summary',
      summary: 'Sessions updated: 0',
      details: '{not valid json',
      created_at: epochSeconds(),
    });

    expect(validateTaskPostconditions({ runId: TITLE_SUMMARY_RUN_ID, taskName: 'title-summary' }))
      .toBe('title-summary completed without vault_update_session or a report showing zero updates');
  });
});
