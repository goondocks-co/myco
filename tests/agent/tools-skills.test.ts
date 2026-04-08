/**
 * Tests for vault skill lifecycle tools.
 *
 * Exercises vault_skill_candidates, vault_skill_records, and vault_write_skill
 * tool handlers directly against an in-memory database.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Mock embedding before imports
vi.mock('@myco/intelligence/embed-query.js', () => ({ tryEmbed: async () => null }));

import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db';
import { getDatabase } from '@myco/db/client.js';
import { insertCandidate } from '@myco/db/queries/skill-candidates.js';
import { insertSkillRecord } from '@myco/db/queries/skill-records.js';
import { insertRun } from '@myco/db/queries/runs.js';
import { createVaultTools } from '@myco/agent/tools.js';
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEST_AGENT_ID = 'test-agent';
const TEST_RUN_ID = 'run-skills-001';

/** Epoch seconds helper. */
const epochNow = () => Math.floor(Date.now() / 1000);

/** Build valid SKILL.md content with required frontmatter. */
function validSkillContent(name: string, body = '# Skill\n\nContent here.') {
  return `---\nname: myco:${name}\ndescription: Test skill\nmanaged_by: myco\nuser-invocable: true\nallowed-tools: Read, Grep, Glob\n---\n\n${body}`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Insert an agent directly into the agents table. */
function createAgent(id: string): void {
  const db = getDatabase();
  const now = epochNow();
  db.prepare(
    `INSERT INTO agents (id, name, created_at) VALUES (?, ?, ?)`,
  ).run(id, `agent-${id}`, now);
}

/** Insert an agent run directly (required FK for turns). */
function createRun(id: string, agentId: string): void {
  insertRun({
    id,
    agent_id: agentId,
    status: 'running',
    started_at: epochNow(),
  });
}

/** Look up a tool by name from the tools array. */
function findTool(tools: ReturnType<typeof createVaultTools>, name: string) {
  const t = tools.find((tool) => tool.name === name);
  if (!t) throw new Error(`Tool not found: ${name}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return t as SdkMcpToolDefinition<any>;
}

/** Parse the JSON text from a tool result. */
function parseResult(result: { content: Array<{ type: string; text: string }> }): unknown {
  return JSON.parse(result.content[0].text);
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('vault skill tools', () => {
  let tools: ReturnType<typeof createVaultTools>;
  let tmpDir: string;

  beforeAll(() => {
    setupTestDb();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-skills-test-'));
  });

  afterAll(() => {
    teardownTestDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    cleanTestDb();

    // Seed required parent rows
    createAgent(TEST_AGENT_ID);
    createRun(TEST_RUN_ID, TEST_AGENT_ID);

    // Create tools for this test with projectRoot set to tmpDir
    tools = createVaultTools(TEST_AGENT_ID, TEST_RUN_ID, { projectRoot: tmpDir });
  });

  // -------------------------------------------------------------------------
  // vault_skill_candidates
  // -------------------------------------------------------------------------

  describe('vault_skill_candidates', () => {
    it('list returns empty array when no candidates exist', async () => {
      const t = findTool(tools, 'vault_skill_candidates');
      const result = await t.handler({ action: 'list' }, undefined);
      const data = parseResult(result) as unknown[];
      expect(data).toEqual([]);
    });

    it('create returns candidate with topic', async () => {
      const t = findTool(tools, 'vault_skill_candidates');
      const result = await t.handler(
        {
          action: 'create',
          topic: 'Error handling patterns',
          rationale: 'Recurring pattern across sessions',
          confidence: 0.8,
        },
        undefined,
      );
      const candidate = parseResult(result) as {
        id: string;
        topic: string;
        rationale: string;
        confidence: number;
        agent_id: string;
      };
      expect(candidate.id).toBeDefined();
      expect(candidate.topic).toBe('Error handling patterns');
      expect(candidate.rationale).toBe('Recurring pattern across sessions');
      expect(candidate.confidence).toBe(0.8);
      expect(candidate.agent_id).toBe(TEST_AGENT_ID);
    });

    it('get retrieves a created candidate', async () => {
      const t = findTool(tools, 'vault_skill_candidates');
      const createResult = await t.handler(
        { action: 'create', topic: 'Test topic', rationale: 'Test rationale' },
        undefined,
      );
      const created = parseResult(createResult) as { id: string };

      const getResult = await t.handler(
        { action: 'get', id: created.id },
        undefined,
      );
      const fetched = parseResult(getResult) as { id: string; topic: string };
      expect(fetched.id).toBe(created.id);
      expect(fetched.topic).toBe('Test topic');
    });

    it('update modifies candidate fields', async () => {
      const t = findTool(tools, 'vault_skill_candidates');
      const createResult = await t.handler(
        { action: 'create', topic: 'Original', rationale: 'Original rationale' },
        undefined,
      );
      const created = parseResult(createResult) as { id: string };

      const updateResult = await t.handler(
        { action: 'update', id: created.id, status: 'validated', confidence: 0.95 },
        undefined,
      );
      const updated = parseResult(updateResult) as { status: string; confidence: number };
      expect(updated.status).toBe('validated');
      expect(updated.confidence).toBe(0.95);
    });

    it('list returns created candidates', async () => {
      const t = findTool(tools, 'vault_skill_candidates');
      await t.handler(
        { action: 'create', topic: 'Topic A', rationale: 'Rationale A' },
        undefined,
      );
      await t.handler(
        { action: 'create', topic: 'Topic B', rationale: 'Rationale B' },
        undefined,
      );

      const listResult = await t.handler({ action: 'list' }, undefined);
      const data = parseResult(listResult) as unknown[];
      expect(data).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // vault_skill_records
  // -------------------------------------------------------------------------

  describe('vault_skill_records', () => {
    it('list returns empty array when no records exist', async () => {
      const t = findTool(tools, 'vault_skill_records');
      const result = await t.handler({ action: 'list' }, undefined);
      const data = parseResult(result) as unknown[];
      expect(data).toEqual([]);
    });

    it('list returns records after insertion', async () => {
      const now = epochNow();
      insertSkillRecord({
        id: 'skill-rec-1',
        agent_id: TEST_AGENT_ID,
        name: 'error-handling',
        display_name: 'Error Handling',
        description: 'Patterns for error handling',
        path: '.agents/skills/error-handling/SKILL.md',
        created_at: now,
        updated_at: now,
      });

      const t = findTool(tools, 'vault_skill_records');
      const result = await t.handler({ action: 'list' }, undefined);
      const data = parseResult(result) as Array<{ name: string }>;
      expect(data).toHaveLength(1);
      expect(data[0].name).toBe('error-handling');
    });

    it('get retrieves a record by name', async () => {
      const now = epochNow();
      insertSkillRecord({
        id: 'skill-rec-2',
        agent_id: TEST_AGENT_ID,
        name: 'testing-patterns',
        display_name: 'Testing Patterns',
        description: 'Patterns for testing',
        path: '.agents/skills/testing-patterns/SKILL.md',
        created_at: now,
        updated_at: now,
      });

      const t = findTool(tools, 'vault_skill_records');
      const result = await t.handler({ action: 'get', id: 'testing-patterns' }, undefined);
      const record = parseResult(result) as { name: string; display_name: string };
      expect(record.name).toBe('testing-patterns');
      expect(record.display_name).toBe('Testing Patterns');
    });
  });

  // -------------------------------------------------------------------------
  // vault_write_skill
  // -------------------------------------------------------------------------

  describe('vault_write_skill', () => {
    it('creates a skill file and record', async () => {
      const t = findTool(tools, 'vault_write_skill');
      const result = await t.handler(
        {
          name: 'error-handling',
          display_name: 'Error Handling',
          description: 'Best practices for error handling',
          content: validSkillContent('error-handling', '# Error Handling\n\nAlways use try-catch blocks.'),
          rationale: 'Observed in multiple sessions',
        },
        undefined,
      );
      const data = parseResult(result) as {
        id: string;
        name: string;
        path: string;
        generation: number;
      };

      expect(data.id).toBeDefined();
      expect(data.name).toBe('error-handling');
      expect(data.path).toBe('.agents/skills/error-handling/SKILL.md');
      expect(data.generation).toBe(1);

      // Verify file was written to disk
      const filePath = path.join(tmpDir, '.agents', 'skills', 'error-handling', 'SKILL.md');
      expect(fs.existsSync(filePath)).toBe(true);
      expect(fs.readFileSync(filePath, 'utf-8')).toContain('# Error Handling');

      // Verify skill record exists in DB
      const recordsTool = findTool(tools, 'vault_skill_records');
      const recordsResult = await recordsTool.handler({ action: 'get', id: 'error-handling' }, undefined);
      const record = parseResult(recordsResult) as { name: string; generation: number };
      expect(record.name).toBe('error-handling');
      expect(record.generation).toBe(1);
    });

    it('updates existing skill and bumps generation', async () => {
      const t = findTool(tools, 'vault_write_skill');

      // Create initial skill
      await t.handler(
        {
          name: 'versioned-skill',
          display_name: 'Versioned Skill',
          description: 'A skill that gets updated',
          content: validSkillContent('versioned-skill', '# Version 1'),
        },
        undefined,
      );

      // Update the skill
      const result = await t.handler(
        {
          name: 'versioned-skill',
          display_name: 'Versioned Skill',
          description: 'Updated description',
          content: validSkillContent('versioned-skill', '# Version 2'),
          rationale: 'New evidence found',
        },
        undefined,
      );
      const data = parseResult(result) as { generation: number; name: string };
      expect(data.generation).toBe(2);
      expect(data.name).toBe('versioned-skill');

      // Verify file content was updated
      const filePath = path.join(tmpDir, '.agents', 'skills', 'versioned-skill', 'SKILL.md');
      expect(fs.readFileSync(filePath, 'utf-8')).toContain('# Version 2');
    });

    it('updates candidate status when candidate_id provided', async () => {
      // Create a candidate first
      const candidateTool = findTool(tools, 'vault_skill_candidates');
      const candidateResult = await candidateTool.handler(
        { action: 'create', topic: 'My topic', rationale: 'My rationale' },
        undefined,
      );
      const candidate = parseResult(candidateResult) as { id: string };

      // Write skill with candidate_id
      const t = findTool(tools, 'vault_write_skill');
      await t.handler(
        {
          name: 'from-candidate',
          display_name: 'From Candidate',
          description: 'Materialized from a candidate',
          content: validSkillContent('from-candidate', '# From Candidate'),
          candidate_id: candidate.id,
        },
        undefined,
      );

      // Verify candidate was updated to materialized
      const getResult = await candidateTool.handler(
        { action: 'get', id: candidate.id },
        undefined,
      );
      const updatedCandidate = parseResult(getResult) as { status: string; skill_id: string };
      expect(updatedCandidate.status).toBe('generated');
      expect(updatedCandidate.skill_id).toBeDefined();
    });

    it('rejects update that changes user-invocable value', async () => {
      const t = findTool(tools, 'vault_write_skill');

      // First write: user-invocable: true
      await t.handler(
        {
          name: 'protected-test',
          display_name: 'Protected Test',
          description: 'Test frontmatter preservation',
          content: validSkillContent('protected-test'),
        },
        undefined,
      );

      // Second write: change user-invocable to false — should be rejected
      const badContent = validSkillContent('protected-test').replace(
        'user-invocable: true',
        'user-invocable: false',
      );
      const result = await t.handler(
        {
          name: 'protected-test',
          display_name: 'Protected Test',
          description: 'Test frontmatter preservation',
          content: badContent,
        },
        undefined,
      );
      const parsed = parseResult(result) as { error?: string; violations?: string[] };
      expect(parsed.error).toContain('protected frontmatter fields were changed');
      expect(parsed.violations).toBeDefined();
      expect(parsed.violations!.some(v => v.includes('user-invocable'))).toBe(true);
    });

    it('rejects update that changes allowed-tools value', async () => {
      const t = findTool(tools, 'vault_write_skill');

      // First write
      await t.handler(
        {
          name: 'tools-test',
          display_name: 'Tools Test',
          description: 'Test allowed-tools preservation',
          content: validSkillContent('tools-test'),
        },
        undefined,
      );

      // Second write: change allowed-tools — should be rejected
      const badContent = validSkillContent('tools-test').replace(
        'allowed-tools: Read, Grep, Glob',
        'allowed-tools: Read, Edit, Write, Bash, Grep, Glob',
      );
      const result = await t.handler(
        {
          name: 'tools-test',
          display_name: 'Tools Test',
          description: 'Test allowed-tools preservation',
          content: badContent,
        },
        undefined,
      );
      const parsed = parseResult(result) as { error?: string; violations?: string[] };
      expect(parsed.error).toContain('protected frontmatter fields were changed');
      expect(parsed.violations!.some(v => v.includes('allowed-tools'))).toBe(true);
    });

    it('allows update that preserves protected fields', async () => {
      const t = findTool(tools, 'vault_write_skill');

      // First write
      await t.handler(
        {
          name: 'preserve-test',
          display_name: 'Preserve Test',
          description: 'Test preservation allows valid updates',
          content: validSkillContent('preserve-test', '# Version 1'),
        },
        undefined,
      );

      // Second write: different body but same frontmatter — should succeed
      const result = await t.handler(
        {
          name: 'preserve-test',
          display_name: 'Preserve Test',
          description: 'Updated description',
          content: validSkillContent('preserve-test', '# Version 2\n\nNew content.'),
        },
        undefined,
      );
      const parsed = parseResult(result) as { generation?: number };
      expect(parsed.generation).toBe(2);
    });

    // -----------------------------------------------------------------------
    // Dedup gates — prevent sibling skills for the same topic.
    // -----------------------------------------------------------------------

    it('rejects writes whose candidate_id is already fulfilled by a different skill', async () => {
      // Seed a candidate and fulfill it by writing a first skill.
      const candidateTool = findTool(tools, 'vault_skill_candidates');
      const candidateResult = await candidateTool.handler(
        { action: 'create', topic: 'Validator coercion', rationale: 'Seen twice in contributor PRs' },
        undefined,
      );
      const candidate = parseResult(candidateResult) as { id: string };

      const t = findTool(tools, 'vault_write_skill');
      await t.handler(
        {
          name: 'validator-coercion-pattern',
          display_name: 'Validator Coercion Pattern',
          description: 'Use the coerced validated_data, not the original params',
          content: validSkillContent('validator-coercion-pattern', '# Step 1'),
          candidate_id: candidate.id,
        },
        undefined,
      );

      // Second write for the same candidate under a different name — should be rejected
      const result = await t.handler(
        {
          name: 'validator-registry-coercion',
          display_name: 'Validator Registry Coercion',
          description: 'A different write targeting the same candidate',
          content: validSkillContent('validator-registry-coercion', '# Step 1'),
          candidate_id: candidate.id,
        },
        undefined,
      );

      const parsed = parseResult(result) as {
        error?: string;
        existing_skill?: { name: string };
      };
      expect(parsed.error).toContain('already fulfilled');
      expect(parsed.existing_skill?.name).toBe('validator-coercion-pattern');

      // The second skill's directory must NOT exist on disk — rejection is early.
      const rejectedPath = path.join(
        tmpDir, '.agents', 'skills', 'validator-registry-coercion', 'SKILL.md',
      );
      expect(fs.existsSync(rejectedPath)).toBe(false);
    });

    it('allows writes to the same name when candidate is already linked (evolve path)', async () => {
      const candidateTool = findTool(tools, 'vault_skill_candidates');
      const candidateResult = await candidateTool.handler(
        { action: 'create', topic: 'Evolution test', rationale: 'Needs to allow bumping generation' },
        undefined,
      );
      const candidate = parseResult(candidateResult) as { id: string };

      const t = findTool(tools, 'vault_write_skill');
      await t.handler(
        {
          name: 'evolution-test',
          display_name: 'Evolution Test',
          description: 'Initial version',
          content: validSkillContent('evolution-test', '# Version 1'),
          candidate_id: candidate.id,
        },
        undefined,
      );

      // Same name — should bump generation, not trip the dedup gate.
      const result = await t.handler(
        {
          name: 'evolution-test',
          display_name: 'Evolution Test',
          description: 'Initial version',
          content: validSkillContent('evolution-test', '# Version 2'),
          candidate_id: candidate.id,
        },
        undefined,
      );
      const parsed = parseResult(result) as { generation?: number; error?: string };
      expect(parsed.error).toBeUndefined();
      expect(parsed.generation).toBe(2);
    });

    it('rejects writes whose description overlaps an existing active skill', async () => {
      const t = findTool(tools, 'vault_write_skill');

      // Seed an active skill with a distinctive description.
      await t.handler(
        {
          name: 'validator-coercion-first',
          display_name: 'First Skill',
          description:
            'Use when implementing or modifying tools that use UniFiValidatorRegistry.validate(). ' +
            'Ensures you use the coerced normalized validated_data returned by the registry ' +
            'rather than the original params, preventing silent failures in the controller.',
          content: validSkillContent('validator-coercion-first', '# Content'),
        },
        undefined,
      );

      // New skill with a near-duplicate description — should be rejected.
      const result = await t.handler(
        {
          name: 'validator-coercion-second',
          display_name: 'Second Skill',
          description:
            'Use when implementing or modifying any tool in unifi-mcp that uses ' +
            'UniFiValidatorRegistry.validate(). Prevents the silent bypass bug by ensuring ' +
            'the coerced normalized validated_data is used instead of the original params dict.',
          content: validSkillContent('validator-coercion-second', '# Content'),
        },
        undefined,
      );

      const parsed = parseResult(result) as {
        error?: string;
        overlapping_skill?: { name: string };
        similarity?: number;
      };
      expect(parsed.error).toContain('overlaps with existing active skill');
      expect(parsed.overlapping_skill?.name).toBe('validator-coercion-first');
      expect(parsed.similarity).toBeGreaterThanOrEqual(0.4);
    });

    it('allows writes whose description is distinct from existing skills', async () => {
      const t = findTool(tools, 'vault_write_skill');

      await t.handler(
        {
          name: 'error-logging',
          display_name: 'Error Logging',
          description: 'Structured error logging patterns for async handlers',
          content: validSkillContent('error-logging', '# Logging'),
        },
        undefined,
      );

      // Completely unrelated topic — should be allowed.
      const result = await t.handler(
        {
          name: 'database-migrations',
          display_name: 'Database Migrations',
          description: 'Safe schema migration procedures for production SQLite',
          content: validSkillContent('database-migrations', '# Migrations'),
        },
        undefined,
      );
      const parsed = parseResult(result) as { generation?: number; error?: string };
      expect(parsed.error).toBeUndefined();
      expect(parsed.generation).toBe(1);
    });

    it('allows updating an existing skill that overlaps its own description', async () => {
      const t = findTool(tools, 'vault_write_skill');

      // Seed
      await t.handler(
        {
          name: 'self-overlap',
          display_name: 'Self Overlap',
          description: 'Structured error logging patterns for async background handlers',
          content: validSkillContent('self-overlap', '# V1'),
        },
        undefined,
      );

      // Update with a description that obviously overlaps its own prior description —
      // should NOT trip the dedup gate because existingSameName is found first.
      const result = await t.handler(
        {
          name: 'self-overlap',
          display_name: 'Self Overlap',
          description: 'Structured error logging patterns for async background handlers, refined',
          content: validSkillContent('self-overlap', '# V2'),
        },
        undefined,
      );
      const parsed = parseResult(result) as { generation?: number; error?: string };
      expect(parsed.error).toBeUndefined();
      expect(parsed.generation).toBe(2);
    });
  });
});
