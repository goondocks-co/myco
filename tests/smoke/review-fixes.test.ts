/**
 * Smoke tests for all fixes applied during the code review.
 *
 * Verifies the behavioral changes from the 28-finding review are correct.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db';
import { registerAgent } from '@myco/db/queries/agents.js';
import { insertRun, getRunningRunForTask, getLatestRunId, STATUS_RUNNING, STATUS_COMPLETED } from '@myco/db/queries/runs.js';
import { insertCandidate, deleteCandidate, getCandidate, updateCandidate } from '@myco/db/queries/skill-candidates.js';
import { insertSkillRecord, deleteSkillRecordCascade, getSkillRecord } from '@myco/db/queries/skill-records.js';
import { insertLineage, listLineageForSkill } from '@myco/db/queries/skill-lineage.js';
import { insertSkillUsage, countUsageForSkill } from '@myco/db/queries/skill-usage.js';
import { validateSkillContent } from '@myco/agent/tools.js';
import {
  parseAllowedTools,
  descriptionSimilarity,
  topicOverlapSimilarity,
  DESCRIPTION_DUPLICATE_THRESHOLD,
  TOPIC_OVERLAP_THRESHOLD,
  MAX_SKILL_DESCRIPTION_CHARS,
} from '@myco/agent/tools/skill-validator.js';
import { buildScheduledJobs, type ScheduledJobContext } from '@myco/daemon/task-scheduler.js';
import type { AgentTask } from '@myco/agent/types.js';
import { TOOL_DEFINITIONS } from '@myco/tools/definitions.js';
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
// P1 #2: Concurrency guard — getRunningRunForTask
// ---------------------------------------------------------------------------
describe('P1 #2: Concurrency guard query helpers', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => { cleanTestDb(); seedAgent(); });

  it('getRunningRunForTask returns running task ID', () => {
    insertRun({
      id: 'run-1', agent_id: AGENT_ID, task: 'vault-evolve',
      status: STATUS_RUNNING, started_at: now, created_at: now,
    });

    const result = getRunningRunForTask(AGENT_ID, 'vault-evolve');
    expect(result).toBe('run-1');
  });

  it('getRunningRunForTask returns null for different task', () => {
    insertRun({
      id: 'run-1', agent_id: AGENT_ID, task: 'vault-evolve',
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
  // The scheduler is now project-scoped (Phase 3 Grove rearchitecture).
  // These regression tests run against a single project to mirror the
  // pre-Grove "one project per daemon" assumption they originally
  // captured.
  function makeTask(name: string, schedule: AgentTask['schedule']): AgentTask {
    return { name, displayName: name, description: 'test', agent: 'a', prompt: 'p', isDefault: false, schedule };
  }

  const { assertGroveProjectId } = require('@myco/grove/ids.js') as typeof import('@myco/grove/ids.js');
  const PROJECT_ID = assertGroveProjectId('proj_' + 'a'.repeat(32));
  const GROVE_ID = 'grv_' + 'b'.repeat(32);

  function singleProjectScope(): Parameters<ScheduledJobContext['runTask']>[0] {
    // Tests only read grove.id and projectId off the scope; everything
    // else is shape-only for type compatibility.
    return {
      grove: { id: GROVE_ID } as never,
      groveHome: '',
      databasePath: '',
      db: {} as never,
      project: {} as never,
      projectId: PROJECT_ID,
      projectRoot: '',
      projectVaultDir: '',
      requestContext: {} as never,
    };
  }

  it('respects interval even after task failure', async () => {
    const tasks = [makeTask('t', { enabled: true, intervalSeconds: 3600, runIn: ['active'] })];
    const runTask = vi.fn().mockRejectedValue(new Error('fail'));
    const ctx: ScheduledJobContext = {
      forEachProject: async (visit) => { await visit(singleProjectScope()); },
      isTaskRunning: () => false,
      setTaskRunning: vi.fn(),
      runTask,
      preConditions: {},
      getProjectPowerState: () => 'active',
      onTaskError: () => {},
    };

    const { jobs } = buildScheduledJobs(tasks, {}, ctx);

    await jobs[0].fn();
    await new Promise((r) => setImmediate(r));
    expect(runTask).toHaveBeenCalledTimes(1);

    // Second tick immediately — interval gate blocks even though the
    // first run rejected. lastRun is stamped before dispatch so a
    // failing run can't induce a tight retry loop.
    runTask.mockClear();
    await jobs[0].fn();
    await new Promise((r) => setImmediate(r));
    expect(runTask).not.toHaveBeenCalled();
  });

  it('allows different tasks to run concurrently for the same project', async () => {
    const tasks = [
      makeTask('a', { enabled: true, intervalSeconds: 1, runIn: ['active'] }),
      makeTask('b', { enabled: true, intervalSeconds: 1, runIn: ['active'] }),
    ];
    const runningTasks = new Set<string>();
    const taskKey = (groveId: string, projectId: string, name: string) =>
      `${groveId}:${projectId}:${name}`;
    const ctx: ScheduledJobContext = {
      forEachProject: async (visit) => { await visit(singleProjectScope()); },
      isTaskRunning: (groveId, projectId, name) => runningTasks.has(taskKey(groveId, projectId, name)),
      setTaskRunning: (groveId, projectId, name, v) => {
        const k = taskKey(groveId, projectId, name);
        if (v) runningTasks.add(k);
        else runningTasks.delete(k);
      },
      runTask: vi.fn().mockResolvedValue(undefined),
      preConditions: {},
      getProjectPowerState: () => 'active',
    };

    const { jobs } = buildScheduledJobs(tasks, {}, ctx);

    // Simulate task 'a' running for the (grove, project); task 'b' must still dispatch.
    runningTasks.add(taskKey(GROVE_ID, PROJECT_ID, 'a'));
    await jobs[0].fn();
    await new Promise((r) => setImmediate(r));
    expect(ctx.runTask).toHaveBeenCalledTimes(1);
    expect(((ctx.runTask as ReturnType<typeof vi.fn>).mock.calls[0][1])).toBe('b');
  });

  it('blocks same task from running concurrently for the same project', async () => {
    const tasks = [makeTask('a', { enabled: true, intervalSeconds: 1, runIn: ['active'] })];
    const ctx: ScheduledJobContext = {
      forEachProject: async (visit) => { await visit(singleProjectScope()); },
      isTaskRunning: (_groveId, _projectId, name) => name === 'a',
      setTaskRunning: vi.fn(),
      runTask: vi.fn().mockResolvedValue(undefined),
      preConditions: {},
      getProjectPowerState: () => 'active',
    };

    const { jobs } = buildScheduledJobs(tasks, {}, ctx);
    await jobs[0].fn();
    await new Promise((r) => setImmediate(r));
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

  it('config schema accepts has-skill-survey-evidence in task override', async () => {
    const { MycoConfigSchema } = await import('@myco/config/schema.js');
    const result = MycoConfigSchema.safeParse({
      version: 3,
      config_version: 3,
      embedding: { provider: 'ollama', model: 'test' },
      daemon: { port: 21039 },
      capture: {},
      agent: {
        tasks: {
          'skill-survey': {
            schedule: { preCondition: 'has-skill-survey-evidence' },
          },
        },
      },
      context: {},
    });
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
    expect(result).toEqual({ id: 'skill-del', project_id: null, name: 'test-skill' });

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
describe('MCP tools: myco_skills', () => {
  it('tool definitions include myco_skills', () => {
    const names = TOOL_DEFINITIONS.map(t => t.name);
    expect(names).toContain('myco_skills');
  });

  it('myco_skills has correct schema', () => {
    const def = TOOL_DEFINITIONS.find(t => t.name === 'myco_skills');
    expect(def).toBeDefined();
    expect(def!.inputSchema.properties).toHaveProperty('id');
    expect(def!.inputSchema.properties).toHaveProperty('status');
    expect(def!.inputSchema.properties).toHaveProperty('limit');
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
    const issues = validateSkillContent(content, 'test-skill');
    expect(issues).toHaveLength(0);
  });

  it('rejects vault agent tool names in allowed-tools (comma format)', () => {
    const content = '---\nname: myco:test-skill\ndescription: A test skill\nmanaged_by: myco\nuser-invocable: true\nallowed-tools: vault_search_fts, vault_spores\n---\n\nBody';
    const issues = validateSkillContent(content, 'test-skill');
    expect(issues.some(i => i.includes('vault agent tool names'))).toBe(true);
  });

  it('rejects vault agent tool names in allowed-tools (YAML list format)', () => {
    const content = '---\nname: myco:test-skill\ndescription: A test skill\nmanaged_by: myco\nuser-invocable: true\nallowed-tools:\n  - vault_search_fts\n  - vault_spores\n---\n\nBody';
    const issues = validateSkillContent(content, 'test-skill');
    expect(issues.some(i => i.includes('vault agent tool names'))).toBe(true);
  });

  it('rejects allowed-tools: [None] — the model confabulation that prompted this gate', () => {
    const content = '---\nname: myco:test-skill\ndescription: A test skill\nmanaged_by: myco\nuser-invocable: true\nallowed-tools: [None]\n---\n\nBody';
    const issues = validateSkillContent(content, 'test-skill');
    expect(issues.some(i => i.includes('malformed'))).toBe(true);
  });

  it('rejects allowed-tools: None (bare sentinel)', () => {
    const content = '---\nname: myco:test-skill\ndescription: A test skill\nmanaged_by: myco\nuser-invocable: true\nallowed-tools: None\n---\n\nBody';
    const issues = validateSkillContent(content, 'test-skill');
    expect(issues.some(i => i.includes('malformed'))).toBe(true);
  });

  it('rejects unknown tool names in allowed-tools', () => {
    const content = '---\nname: myco:test-skill\ndescription: A test skill\nmanaged_by: myco\nuser-invocable: true\nallowed-tools: Read, ReadFile, Shell\n---\n\nBody';
    const issues = validateSkillContent(content, 'test-skill');
    expect(issues.some(i => i.includes('unknown tool name'))).toBe(true);
  });

  it('accepts inline YAML list format with valid tools', () => {
    const content = '---\nname: myco:test-skill\ndescription: A test skill\nmanaged_by: myco\nuser-invocable: true\nallowed-tools: [Read, Edit, Write]\n---\n\nBody';
    const issues = validateSkillContent(content, 'test-skill');
    expect(issues).toHaveLength(0);
  });

  it('rejects malformed YAML frontmatter even when required field substrings are present', () => {
    const content =
      '---\n' +
      'name: myco:test-skill\n' +
      'description: Use this skill for end-to-end delivery: planning, coding, verification\n' +
      'managed_by: myco\n' +
      'user-invocable: true\n' +
      'allowed-tools: Read, Grep, Glob\n' +
      '---\n\nBody';
    const issues = validateSkillContent(content, 'test-skill');
    expect(issues.some((issue) => issue.includes('Invalid YAML frontmatter'))).toBe(true);
  });

  it('rejects descriptions that exceed the Codex-compatible length limit', () => {
    const description = 'a'.repeat(MAX_SKILL_DESCRIPTION_CHARS + 1);
    const content =
      '---\n' +
      'name: myco:test-skill\n' +
      `description: ${description}\n` +
      'managed_by: myco\n' +
      'user-invocable: true\n' +
      'allowed-tools: Read, Grep, Glob\n' +
      '---\n\nBody';
    const issues = validateSkillContent(content, 'test-skill');
    expect(
      issues.some((issue) => issue.includes(`description exceeds maximum length of ${MAX_SKILL_DESCRIPTION_CHARS}`)),
    ).toBe(true);
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

  it('collapses plural/gerund variants via stemming', () => {
    // Without stemming these score 0; with stemming they share every
    // content word. Regression guard for the candidate dedup false
    // negatives that let dismissed candidates re-appear.
    const a = 'configure local model phase';
    const b = 'configuring local models phases';
    expect(descriptionSimilarity(a, b)).toBeGreaterThan(0.9);
  });
});

// ---------------------------------------------------------------------------
// topicOverlapSimilarity — the second dedup path for asymmetric topics
// ---------------------------------------------------------------------------
describe('topicOverlapSimilarity', () => {
  it('catches asymmetric kebab-vs-sentence topic duplicates', () => {
    // Every one of these pairs was live in the skill_candidates table as a
    // "new identified" candidate that duplicated an already-dismissed entry.
    // The previous Jaccard-only gate scored all four below 0.4 because the
    // kebab-case topic has 4-5 tokens while the dismissed topic has 6-7,
    // inflating the union. Overlap coefficient is robust to that asymmetry.
    const pairs: Array<[string, string]> = [
      [
        'add-idle-skip-watermark-to-agent-task',
        'Implementing DB Watermark Prefilters for Incremental Agent Tasks',
      ],
      [
        'run-agent-team-parallel-implementation',
        'Orchestrating a Myco Agent Team for Cross-Layer Implementation',
      ],
      [
        'configure-local-model-phases',
        'Configuring Ollama Local Models for Myco Agent Pipeline Tasks',
      ],
      [
        'apply-structural-enforcement-gate',
        'Implementing Structural Enforcement Gates in Agent-Facing MCP Tools',
      ],
      [
        'publish-npm-package-with-oidc-in-ci',
        'npm OIDC Trusted Publishing in GitHub Actions',
      ],
    ];
    for (const [a, b] of pairs) {
      const score = topicOverlapSimilarity(a, b);
      expect(
        score,
        `${a} vs ${b} should trip the overlap gate`,
      ).toBeGreaterThanOrEqual(TOPIC_OVERLAP_THRESHOLD);
    }
  });

  it('does not flag genuinely-new candidates', () => {
    // The one candidate in the user's recent list that IS new — must not
    // be flagged against any of the dismissed topics.
    const newTopic = 'implement-spa-sub-navigation-with-browser-history';
    const dismissed = [
      'Implementing DB Watermark Prefilters for Incremental Agent Tasks',
      'Adding a New Operations Tab to the Myco Daemon UI',
      'Orchestrating a Myco Agent Team for Cross-Layer Implementation',
      'Configuring Ollama Local Models for Myco Agent Pipeline Tasks',
      'Implementing Structural Enforcement Gates in Agent-Facing MCP Tools',
    ];
    for (const b of dismissed) {
      expect(
        topicOverlapSimilarity(newTopic, b),
        `${newTopic} vs ${b} must not trip`,
      ).toBeLessThan(TOPIC_OVERLAP_THRESHOLD);
    }
  });

  it('returns 0 for very short topics to avoid single-word false positives', () => {
    // Two distinct 2-token topics sharing one word would score 0.5 under
    // naive overlap coefficient. The 4-token minimum guard forces them
    // back through Jaccard, which correctly scores them below threshold.
    expect(topicOverlapSimilarity('daemon task', 'daemon symbiont')).toBe(0);
    expect(topicOverlapSimilarity('sync vault', 'sync graph')).toBe(0);
  });

  it('returns 0 for clearly unrelated topics', () => {
    expect(
      topicOverlapSimilarity(
        'structured error logging patterns for async handlers',
        'safe schema migration procedures for sqlite production',
      ),
    ).toBe(0);
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
