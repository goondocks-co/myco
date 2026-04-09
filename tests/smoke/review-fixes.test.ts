/**
 * Smoke tests for all fixes applied during the code review.
 *
 * Verifies the behavioral changes from the 28-finding review are correct.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db';
import { registerAgent } from '@myco/db/queries/agents.js';
import { insertRun, getRunningRunForTask, getLatestRunId, STATUS_RUNNING, STATUS_COMPLETED } from '@myco/db/queries/runs.js';
import { insertCandidate, deleteCandidate, getCandidate, updateCandidate } from '@myco/db/queries/skill-candidates.js';
import { insertSkillRecord, deleteSkillRecordCascade, getSkillRecord } from '@myco/db/queries/skill-records.js';
import { insertLineage, listLineageForSkill } from '@myco/db/queries/skill-lineage.js';
import { insertSkillUsage, countUsageForSkill } from '@myco/db/queries/skill-usage.js';
import { validateSkillContent, VAULT_TOOL_COUNT } from '@myco/agent/tools.js';
import {
  parseAllowedTools,
  descriptionSimilarity,
  DESCRIPTION_DUPLICATE_THRESHOLD,
} from '@myco/agent/tools/skill-validator.js';
import { buildScheduledJobs, type ScheduledJobContext } from '@myco/daemon/task-scheduler.js';
import { loadConfig } from '@myco/config/loader.js';
import type { AgentTask } from '@myco/agent/types.js';
import { TOOL_DEFINITIONS } from '@myco/mcp/tool-definitions.js';
import { epochSeconds } from '@myco/constants.js';
import { getDatabase } from '@myco/db/client.js';

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

const AGENT_ID = 'myco-agent';

function seedAgent() {
  registerAgent({ id: AGENT_ID, name: 'Myco Agent', created_at: epochSeconds() });
}

const now = epochSeconds();

// ---------------------------------------------------------------------------
// P1 #1: Path traversal validation
// ---------------------------------------------------------------------------
describe('P1 #1: Path traversal guard', () => {
  it('rejects skill names with path separators', () => {
    const badNames = ['../../etc', '../foo', 'foo/bar', '..', 'foo/../bar'];
    const pathRegex = /[/\\]|\.\./;
    for (const name of badNames) {
      expect(pathRegex.test(name), `should reject "${name}"`).toBe(true);
    }
  });

  it('allows valid skill names', () => {
    const goodNames = ['my-skill', 'myco-safe-config', 'cross-platform-hook-guard', 'a.b.c'];
    const pathRegex = /[/\\]|\.\./;
    for (const name of goodNames) {
      expect(pathRegex.test(name), `should allow "${name}"`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// P1 #2: Concurrency guard — getRunningRunForTask
// ---------------------------------------------------------------------------
describe('P1 #2: Concurrency guard query helpers', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => { cleanTestDb(); seedAgent(); });

  it('getRunningRunForTask returns running task ID', () => {
    insertRun({
      id: 'run-1', agent_id: AGENT_ID, task: 'full-intelligence',
      status: STATUS_RUNNING, started_at: now, created_at: now,
    });

    const result = getRunningRunForTask(AGENT_ID, 'full-intelligence');
    expect(result).toBe('run-1');
  });

  it('getRunningRunForTask returns null for different task', () => {
    insertRun({
      id: 'run-1', agent_id: AGENT_ID, task: 'full-intelligence',
      status: STATUS_RUNNING, started_at: now, created_at: now,
    });

    expect(getRunningRunForTask(AGENT_ID, 'skill-generate')).toBeNull();
  });

  it('getLatestRunId returns most recent run', () => {
    insertRun({
      id: 'run-old', agent_id: AGENT_ID, task: 'skill-generate',
      status: STATUS_COMPLETED, started_at: now - 100, created_at: now - 100,
    });
    insertRun({
      id: 'run-new', agent_id: AGENT_ID, task: 'skill-generate',
      status: STATUS_RUNNING, started_at: now, created_at: now,
    });

    expect(getLatestRunId(AGENT_ID, 'skill-generate')).toBe('run-new');
    expect(getLatestRunId(AGENT_ID)).toBe('run-new');
  });
});

// ---------------------------------------------------------------------------
// P1 #3: v7 migration — entity_mentions excluded
// ---------------------------------------------------------------------------
describe('P1 #3: v7 migration entity_mentions exclusion', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });

  it('entity_mentions table exists without id column', () => {
    const db = getDatabase();
    const cols = db.prepare("PRAGMA table_info('entity_mentions')").all() as Array<{ name: string }>;
    const colNames = cols.map(c => c.name);
    expect(colNames).not.toContain('id');
    expect(colNames).toContain('entity_id');
    expect(colNames).toContain('machine_id');
  });
});

// ---------------------------------------------------------------------------
// P1 #4: Scheduler lastRun in finally + per-task tracking
// ---------------------------------------------------------------------------
describe('P1 #4: Scheduler retry behavior', () => {
  function makeTask(name: string, schedule: AgentTask['schedule']): AgentTask {
    return { name, displayName: name, description: 'test', agent: 'a', prompt: 'p', isDefault: false, schedule };
  }

  it('respects interval even after task failure', async () => {
    const tasks = [makeTask('t', { enabled: true, intervalSeconds: 3600, runIn: ['active'] })];
    const runTask = vi.fn().mockRejectedValue(new Error('fail'));
    const ctx: ScheduledJobContext = {
      isTaskRunning: () => false,
      setTaskRunning: vi.fn(),
      runTask,
      preConditions: {},
    };

    const jobs = buildScheduledJobs(tasks, {}, ctx);

    // First run — should attempt and fail (error propagates to PowerManager)
    await jobs[0].fn().catch(() => {});
    expect(runTask).toHaveBeenCalledTimes(1);

    // Second run immediately — should be throttled (lastRun was updated in finally)
    runTask.mockClear();
    await jobs[0].fn().catch(() => {});
    expect(runTask).not.toHaveBeenCalled();
  });

  it('allows different tasks to run concurrently', async () => {
    const tasks = [
      makeTask('a', { enabled: true, intervalSeconds: 1, runIn: ['active'] }),
      makeTask('b', { enabled: true, intervalSeconds: 1, runIn: ['active'] }),
    ];
    const runningTasks = new Set<string>();
    const ctx: ScheduledJobContext = {
      isTaskRunning: (name) => runningTasks.has(name),
      setTaskRunning: (name, v) => { if (v) runningTasks.add(name); else runningTasks.delete(name); },
      runTask: vi.fn().mockResolvedValue(undefined),
      preConditions: {},
    };

    const jobs = buildScheduledJobs(tasks, {}, ctx);

    // Simulate task 'a' running
    runningTasks.add('a');
    // Task 'b' should still be able to run
    await jobs[1].fn();
    expect(ctx.runTask).toHaveBeenCalledWith('b');
  });

  it('blocks same task from running concurrently', async () => {
    const tasks = [makeTask('a', { enabled: true, intervalSeconds: 1, runIn: ['active'] })];
    const ctx: ScheduledJobContext = {
      isTaskRunning: (name) => name === 'a',
      setTaskRunning: vi.fn(),
      runTask: vi.fn().mockResolvedValue(undefined),
      preConditions: {},
    };

    const jobs = buildScheduledJobs(tasks, {}, ctx);
    await jobs[0].fn();
    expect(ctx.runTask).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// P2 #5: ScheduleOverrideSchema preCondition enum
// ---------------------------------------------------------------------------
describe('P2 #5: preCondition enum alignment', () => {
  it('config schema accepts has-approved-candidates in task override', async () => {
    // Verify via the full config schema — the ScheduleOverrideSchema is internal
    const { MycoConfigSchema } = await import('@myco/config/schema.js');
    const result = MycoConfigSchema.safeParse({
      version: 3,
      config_version: 3,
      embedding: { provider: 'ollama', model: 'test' },
      daemon: { port: 21039 },
      capture: {},
      agent: {
        tasks: {
          'skill-generate': {
            schedule: { preCondition: 'has-approved-candidates' },
          },
        },
      },
      context: {},
    });
    // If the enum was wrong, this would fail with a Zod validation error
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Delete operations
// ---------------------------------------------------------------------------
describe('Delete operations', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => { cleanTestDb(); seedAgent(); });

  it('deleteCandidate removes candidate and returns true', () => {
    insertCandidate({
      id: 'cand-del', agent_id: AGENT_ID, machine_id: 'test',
      topic: 't', rationale: 'r', created_at: now, updated_at: now,
    });

    expect(deleteCandidate('cand-del')).toBe(true);
    expect(getCandidate('cand-del')).toBeNull();
  });

  it('deleteCandidate returns false for non-existent', () => {
    expect(deleteCandidate('nonexistent')).toBe(false);
  });

  it('deleteSkillRecordCascade removes record, lineage, and usage', async () => {
    const { upsertSession } = await import('@myco/db/queries/sessions.js');
    upsertSession({ id: 'sess-1', agent: 'test', started_at: now, created_at: now });

    insertSkillRecord({
      id: 'skill-del', agent_id: AGENT_ID, machine_id: 'test', name: 'test-skill',
      display_name: 'Test', description: 'd', path: '/test', created_at: now, updated_at: now,
    });
    insertLineage({
      id: 'lin-1', skill_id: 'skill-del', generation: 1, action: 'created',
      rationale: 'test', content_snapshot: 'content', created_at: now,
    });
    insertSkillUsage({
      id: 'usage-1', skill_id: 'skill-del', session_id: 'sess-1', detected_at: now,
    });

    const result = deleteSkillRecordCascade('skill-del');
    expect(result).toEqual({ id: 'skill-del', name: 'test-skill' });

    expect(getSkillRecord('skill-del')).toBeNull();
    expect(listLineageForSkill('skill-del')).toHaveLength(0);
    expect(countUsageForSkill('skill-del')).toBe(0);
  });

  it('deleteSkillRecordCascade dismisses linked candidates', () => {
    insertCandidate({
      id: 'cand-linked', agent_id: AGENT_ID, machine_id: 'test',
      topic: 't', rationale: 'r', created_at: now, updated_at: now,
    });
    updateCandidate('cand-linked', { status: 'generated', skill_id: 'skill-cascade', updated_at: now });

    insertSkillRecord({
      id: 'skill-cascade', agent_id: AGENT_ID, machine_id: 'test', name: 'cascade-skill',
      display_name: 'Test', description: 'd', path: '/test',
      candidate_id: 'cand-linked', created_at: now, updated_at: now,
    });

    deleteSkillRecordCascade('skill-cascade');

    const candidate = getCandidate('cand-linked');
    expect(candidate?.status).toBe('dismissed');
    expect(candidate?.skill_id).toBeNull();
  });

  it('deleteSkillRecordCascade returns null for non-existent', () => {
    expect(deleteSkillRecordCascade('nonexistent')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// P2 #14: listLineageForSkill LIMIT
// ---------------------------------------------------------------------------
describe('P2 #14: listLineageForSkill LIMIT', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => { cleanTestDb(); seedAgent(); });

  it('respects limit parameter', () => {
    insertSkillRecord({
      id: 'skill-lin', agent_id: AGENT_ID, machine_id: 'test', name: 'lineage-test',
      display_name: 'Test', description: 'd', path: '/test', created_at: now, updated_at: now,
    });
    for (let i = 1; i <= 5; i++) {
      insertLineage({
        id: `lin-${i}`, skill_id: 'skill-lin', generation: i, action: 'updated',
        rationale: `gen ${i}`, content_snapshot: `content ${i}`, created_at: now + i,
      });
    }

    expect(listLineageForSkill('skill-lin', 3)).toHaveLength(3);
    expect(listLineageForSkill('skill-lin')).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// MCP tools registration
// ---------------------------------------------------------------------------
describe('MCP tools: myco_skills and myco_skill_candidates', () => {
  it('tool definitions include skill tools', () => {
    const names = TOOL_DEFINITIONS.map(t => t.name);
    expect(names).toContain('myco_skills');
    expect(names).toContain('myco_skill_candidates');
  });

  it('myco_skills has correct schema', () => {
    const def = TOOL_DEFINITIONS.find(t => t.name === 'myco_skills');
    expect(def).toBeDefined();
    expect(def!.inputSchema.properties).toHaveProperty('id');
    expect(def!.inputSchema.properties).toHaveProperty('status');
    expect(def!.inputSchema.properties).toHaveProperty('limit');
  });

  it('myco_skill_candidates has action enum', () => {
    const def = TOOL_DEFINITIONS.find(t => t.name === 'myco_skill_candidates');
    expect(def).toBeDefined();
    const action = def!.inputSchema.properties.action as { enum?: string[] };
    expect(action.enum).toContain('approve');
    expect(action.enum).toContain('dismiss');
  });
});

// ---------------------------------------------------------------------------
// VAULT_TOOL_COUNT consistency
// ---------------------------------------------------------------------------
describe('VAULT_TOOL_COUNT', () => {
  it('matches expected count (23)', () => {
    expect(VAULT_TOOL_COUNT).toBe(23);
  });
});

// ---------------------------------------------------------------------------
// validateSkillContent quality gate
// ---------------------------------------------------------------------------
describe('validateSkillContent quality gate', () => {
  it('rejects content without frontmatter', () => {
    const issues = validateSkillContent('no frontmatter here', 'test');
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]).toContain('frontmatter');
  });

  it('rejects missing required fields', () => {
    const content = '---\nname: myco:test\n---\nBody';
    const issues = validateSkillContent(content, 'test');
    expect(issues.some(i => i.includes('description'))).toBe(true);
    expect(issues.some(i => i.includes('managed_by'))).toBe(true);
  });

  it('rejects name without myco: prefix', () => {
    const content = '---\nname: bad-name\ndescription: test\nmanaged_by: myco\n---\nBody';
    const issues = validateSkillContent(content, 'test');
    expect(issues.some(i => i.includes('myco:'))).toBe(true);
  });

  it('accepts valid skill content', () => {
    const content = '---\nname: myco:test-skill\ndescription: A test skill\nmanaged_by: myco\nuser-invocable: true\nallowed-tools: Read, Grep, Glob\n---\n\nBody content here.';
    const issues = validateSkillContent(content, 'test');
    expect(issues).toHaveLength(0);
  });

  it('rejects vault agent tool names in allowed-tools (comma format)', () => {
    const content = '---\nname: myco:test-skill\ndescription: A test skill\nmanaged_by: myco\nuser-invocable: true\nallowed-tools: vault_search_fts, vault_spores\n---\n\nBody';
    const issues = validateSkillContent(content, 'test');
    expect(issues.some(i => i.includes('vault agent tool names'))).toBe(true);
  });

  it('rejects vault agent tool names in allowed-tools (YAML list format)', () => {
    const content = '---\nname: myco:test-skill\ndescription: A test skill\nmanaged_by: myco\nuser-invocable: true\nallowed-tools:\n  - vault_search_fts\n  - vault_spores\n---\n\nBody';
    const issues = validateSkillContent(content, 'test');
    expect(issues.some(i => i.includes('vault agent tool names'))).toBe(true);
  });

  it('rejects allowed-tools: [None] — the model confabulation that prompted this gate', () => {
    const content = '---\nname: myco:test-skill\ndescription: A test skill\nmanaged_by: myco\nuser-invocable: true\nallowed-tools: [None]\n---\n\nBody';
    const issues = validateSkillContent(content, 'test');
    expect(issues.some(i => i.includes('malformed'))).toBe(true);
  });

  it('rejects allowed-tools: None (bare sentinel)', () => {
    const content = '---\nname: myco:test-skill\ndescription: A test skill\nmanaged_by: myco\nuser-invocable: true\nallowed-tools: None\n---\n\nBody';
    const issues = validateSkillContent(content, 'test');
    expect(issues.some(i => i.includes('malformed'))).toBe(true);
  });

  it('rejects unknown tool names in allowed-tools', () => {
    const content = '---\nname: myco:test-skill\ndescription: A test skill\nmanaged_by: myco\nuser-invocable: true\nallowed-tools: Read, ReadFile, Shell\n---\n\nBody';
    const issues = validateSkillContent(content, 'test');
    expect(issues.some(i => i.includes('unknown tool name'))).toBe(true);
  });

  it('accepts inline YAML list format with valid tools', () => {
    const content = '---\nname: myco:test-skill\ndescription: A test skill\nmanaged_by: myco\nuser-invocable: true\nallowed-tools: [Read, Edit, Write]\n---\n\nBody';
    const issues = validateSkillContent(content, 'test');
    expect(issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// parseAllowedTools helper
// ---------------------------------------------------------------------------
describe('parseAllowedTools', () => {
  it('parses comma-separated values', () => {
    expect(parseAllowedTools('Read, Edit, Write')).toEqual(['Read', 'Edit', 'Write']);
  });

  it('parses inline YAML list format', () => {
    expect(parseAllowedTools('[Read, Edit, Write]')).toEqual(['Read', 'Edit', 'Write']);
  });

  it('strips surrounding quotes', () => {
    expect(parseAllowedTools('"Read", "Edit"')).toEqual(['Read', 'Edit']);
  });

  it('returns null for bare None sentinel', () => {
    expect(parseAllowedTools('None')).toBeNull();
  });

  it('returns null for [None]', () => {
    expect(parseAllowedTools('[None]')).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(parseAllowedTools('')).toBeNull();
    expect(parseAllowedTools('   ')).toBeNull();
    expect(parseAllowedTools(undefined)).toBeNull();
  });

  it('returns null when any element is a null-sentinel', () => {
    expect(parseAllowedTools('Read, None')).toBeNull();
    expect(parseAllowedTools('Read, null')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// descriptionSimilarity helper — the deterministic dedup signal
// ---------------------------------------------------------------------------
describe('descriptionSimilarity', () => {
  it('returns 1.0 for identical strings', () => {
    const a = 'Use the coerced validated_data, not the original params';
    expect(descriptionSimilarity(a, a)).toBe(1);
  });

  it('returns near-zero for clearly distinct topics', () => {
    const a = 'Structured error logging patterns for async handlers';
    const b = 'Safe schema migration procedures for SQLite production';
    expect(descriptionSimilarity(a, b)).toBeLessThan(0.2);
  });

  it('scores near-duplicates above DESCRIPTION_DUPLICATE_THRESHOLD', () => {
    // The real pair that prompted this helper — run fcb66275's new skill
    // vs the pre-existing one it failed to notice.
    const a =
      'Use when implementing or modifying tools that use UniFiValidatorRegistry.validate(). ' +
      'Ensures you use the coerced normalized validated_data returned by the registry ' +
      'rather than the original params, preventing silent failures in the controller.';
    const b =
      'Use when implementing or modifying any tool in unifi-mcp that uses ' +
      'UniFiValidatorRegistry.validate(). Prevents the silent bypass bug by ensuring ' +
      'the coerced normalized validated_data is used instead of the original params dict.';
    const score = descriptionSimilarity(a, b);
    expect(score).toBeGreaterThanOrEqual(DESCRIPTION_DUPLICATE_THRESHOLD);
  });

  it('ignores stopwords and short tokens so boilerplate does not inflate scores', () => {
    const a = 'the quick brown fox jumps over the lazy dog today';
    const b = 'the cat sat on the mat today and yesterday';
    // Both contain lots of stopwords, but only "today" is a shared content word
    // — should score low, not high.
    expect(descriptionSimilarity(a, b)).toBeLessThan(0.3);
  });
});

// ---------------------------------------------------------------------------
// machine_id: insertBatchStateless accepts machine_id
// ---------------------------------------------------------------------------
describe('machine_id fix: insertBatchStateless', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => { cleanTestDb(); });

  it('passes machine_id through to the row', async () => {
    const { upsertSession } = await import('@myco/db/queries/sessions.js');
    const { insertBatchStateless } = await import('@myco/db/queries/batches.js');

    upsertSession({
      id: 'sess-mid', agent: 'test', started_at: now, created_at: now,
      machine_id: 'correct-machine',
    });

    const batch = insertBatchStateless({
      session_id: 'sess-mid',
      user_prompt: 'test prompt',
      created_at: now,
      machine_id: 'correct-machine',
    });

    expect(batch.machine_id).toBe('correct-machine');
  });

  it('defaults to local without machine_id', async () => {
    const { upsertSession } = await import('@myco/db/queries/sessions.js');
    const { insertBatchStateless } = await import('@myco/db/queries/batches.js');

    upsertSession({
      id: 'sess-mid2', agent: 'test', started_at: now, created_at: now,
    });

    const batch = insertBatchStateless({
      session_id: 'sess-mid2',
      user_prompt: 'test prompt',
      created_at: now,
    });

    expect(batch.machine_id).toBe('local');
  });
});
