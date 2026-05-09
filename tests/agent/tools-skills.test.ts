/**
 * Tests for vault skill lifecycle tools.
 *
 * Exercises vault_skill_candidates, vault_skill_records, and vault_write_skill
 * tool handlers directly against an in-memory database.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, mock } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod/v4';

// Mock embedding before imports
mock.module('@myco/intelligence/embed-query.js', () => ({ tryEmbed: async () => null }));

import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db';
import { ensureProjectManifest } from '@myco/config/project-manifest.js';
import { getDatabase } from '@myco/db/client.js';
import { insertCandidate, updateCandidate } from '@myco/db/queries/skill-candidates.js';
import { insertSkillRecord } from '@myco/db/queries/skill-records.js';
import { insertRun } from '@myco/db/queries/runs.js';
import { createVaultTools } from '@myco/agent/tools.js';
import { MAX_SKILL_DESCRIPTION_CHARS } from '@myco/agent/tools/skill-validator.js';
import { CANDIDATE_STATUS } from '@myco/constants/skill-candidate-status.js';
import type { MycoRequestContext } from '@myco/tools/request-context.js';
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { ALL_PROJECTS_SCOPE, projectScope, type GroveProjectId } from '@myco/grove/ids.js';

import { TEST_REQUEST_CONTEXT } from '../helpers/request-context';
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

/**
 * Flip a candidate to 'approved' so downstream tools (vault_stage_skill,
 * vault_write_skill create path, vault_finalize_skill) accept it. The
 * structural gate rejects non-approved candidates, matching the real
 * skill-generate workflow where only human-approved candidates reach
 * these tools.
 */
function approveCandidate(id: string, projectId?: string | null): void {
  const scope = projectId == null ? ALL_PROJECTS_SCOPE : projectScope(projectId as GroveProjectId);
  updateCandidate(id, { status: CANDIDATE_STATUS.APPROVED, updated_at: epochNow() }, scope);
}

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

function makeRequestContext(
  projectRoot: string,
  vaultDir: string,
  projectId: string,
): MycoRequestContext {
  return {
    projectRoot,
    projectId,
    groveId: `grove-${projectId}`,
    machineId: 'machine-test',
    sessionId: null,
    projectVaultDir: vaultDir,
    databasePath: path.join(vaultDir, 'vault.db'),
    source: 'explicit',
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('vault skill tools', () => {
  let tools: ReturnType<typeof createVaultTools>;
  let tmpDir: string;
  let vaultDir: string;

  beforeAll(() => {
    setupTestDb();
  });

  afterAll(() => {
    teardownTestDb();
  });

  beforeEach(() => {
    cleanTestDb();

    // Per-test mkdtemp so tests never share staging or .agents/skills/
    // state. Eliminates cross-test coupling by construction — no manual
    // rm -rf needed between tests.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-skills-test-'));
    vaultDir = path.join(tmpDir, '.myco');
    fs.mkdirSync(vaultDir, { recursive: true });
    ensureProjectManifest(vaultDir, { projectName: 'tools-skills-test' });

    createAgent(TEST_AGENT_ID);
    createRun(TEST_RUN_ID, TEST_AGENT_ID);

    tools = createVaultTools(TEST_AGENT_ID, TEST_RUN_ID, { requestContext: TEST_REQUEST_CONTEXT,
      projectRoot: tmpDir,
      vaultDir,
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createProjectTools(projectId: string): ReturnType<typeof createVaultTools> {
    return createVaultTools(TEST_AGENT_ID, TEST_RUN_ID, {
      projectRoot: tmpDir,
      vaultDir,
      requestContext: makeRequestContext(tmpDir, vaultDir, projectId),
    });
  }

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
        { action: 'create', topic: 'Author agent pipeline tasks', rationale: 'Rationale A' },
        undefined,
      );
      await t.handler(
        { action: 'create', topic: 'Configure cross-platform hook guard', rationale: 'Rationale B' },
        undefined,
      );

      const listResult = await t.handler({ action: 'list' }, undefined);
      const data = parseResult(listResult) as unknown[];
      expect(data).toHaveLength(2);
    });

    it('scopes candidate lifecycle actions to the request project', async () => {
      const projectATool = findTool(createProjectTools('proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), 'vault_skill_candidates');
      const projectBTool = findTool(createProjectTools('proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'), 'vault_skill_candidates');

      const createdA = parseResult(
        await projectATool.handler(
          { action: 'create', topic: 'Shared project topic', rationale: 'Project A rationale' },
          undefined,
        ),
      ) as { id: string; project_id: string; error?: string };
      const createdB = parseResult(
        await projectBTool.handler(
          { action: 'create', topic: 'Shared project topic', rationale: 'Project B rationale' },
          undefined,
        ),
      ) as { id: string; project_id: string; error?: string };

      expect(createdA.error).toBeUndefined();
      expect(createdB.error).toBeUndefined();
      expect(createdA.project_id).toBe('proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
      expect(createdB.project_id).toBe('proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');

      const listA = parseResult(
        await projectATool.handler({ action: 'list' }, undefined),
      ) as Array<{ id: string; project_id: string }>;
      expect(listA).toHaveLength(1);
      expect(listA[0].id).toBe(createdA.id);
      expect(listA[0].project_id).toBe('proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

      const crossGet = parseResult(
        await projectATool.handler({ action: 'get', id: createdB.id }, undefined),
      ) as { error?: string };
      expect(crossGet.error).toContain('Candidate not found');

      const crossUpdate = parseResult(
        await projectATool.handler(
          { action: 'update', id: createdB.id, status: 'dismissed' },
          undefined,
        ),
      ) as { error?: string };
      expect(crossUpdate.error).toContain('Candidate not found');

      const crossDelete = parseResult(
        await projectATool.handler({ action: 'delete', id: createdB.id }, undefined),
      ) as { error?: string };
      expect(crossDelete.error).toContain('Candidate not found');

      const stillInB = parseResult(
        await projectBTool.handler({ action: 'get', id: createdB.id }, undefined),
      ) as { id: string; project_id: string };
      expect(stillInB.id).toBe(createdB.id);
      expect(stillInB.project_id).toBe('proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    });

    // Cross-status dedup — skill-survey must not re-identify topics
    // that were already dismissed, generated, approved, or left as
    // open identified candidates. The existing active-skill check is
    // not enough; the full candidate table must be consulted. This is
    // the structural fix for the 2026-04-08 "dismissed candidates keep
    // coming back" workflow bug.
    describe('create: cross-status candidate dedup', () => {
      function makeTool() {
        return findTool(tools, 'vault_skill_candidates');
      }

      async function seedCandidate(
        topic: string,
        targetStatus: string,
      ): Promise<string> {
        const t = makeTool();
        const created = parseResult(
          await t.handler({ action: 'create', topic, rationale: 'seed' }, undefined),
        ) as { id: string };
        if (targetStatus !== 'identified') {
          updateCandidate(created.id, { status: targetStatus, updated_at: epochNow() }, ALL_PROJECTS_SCOPE);
        }
        return created.id;
      }

      it('allows creation with warning when topic overlaps a dismissed candidate', async () => {
        await seedCandidate('How to add a new MCP tool to the Myco vault daemon', 'dismissed');

        const t = makeTool();
        const result = parseResult(
          await t.handler(
            {
              action: 'create',
              topic: 'Add a new MCP tool to the Myco vault daemon',
              rationale: 'Re-identified from a later survey run',
            },
            undefined,
          ),
        ) as { id?: string; warning?: string; similar_dismissed_candidate?: { topic: string } };

        // Dismissed overlap produces a soft warning, not a hard rejection
        expect(result.id).toBeDefined();
        expect(result.warning).toBeDefined();
        expect(result.warning).toMatch(/dismissed/);
        expect(result.similar_dismissed_candidate?.topic).toMatch(/MCP tool/);
      });

      it('rejects a new candidate whose topic overlaps a generated candidate', async () => {
        await seedCandidate('Register a recurring PowerManager job', 'generated');

        const t = makeTool();
        const result = parseResult(
          await t.handler(
            {
              action: 'create',
              topic: 'Register a new PowerManager job',
              rationale: 'Duplicate of already-generated skill',
            },
            undefined,
          ),
        ) as { error?: string; existing_candidate?: { status: string } };

        expect(result.error).toBeDefined();
        expect(result.error).toMatch(/already fulfilled|generated/);
        expect(result.existing_candidate?.status).toBe('generated');
      });

      it('rejects a new candidate whose topic overlaps an approved candidate', async () => {
        await seedCandidate('Configure Cloudflare team sync for Myco', 'approved');

        const t = makeTool();
        const result = parseResult(
          await t.handler(
            {
              action: 'create',
              topic: 'Configure Cloudflare team sync',
              rationale: 'Duplicate of an already-queued candidate',
            },
            undefined,
          ),
        ) as { error?: string; existing_candidate?: { status: string } };

        expect(result.error).toBeDefined();
        expect(result.error).toMatch(/already queued|approved/);
        expect(result.existing_candidate?.status).toBe('approved');
      });

      it('rejects a new candidate whose topic overlaps an identified candidate', async () => {
        await seedCandidate('Install and initialize Myco in a new project', 'identified');

        const t = makeTool();
        const result = parseResult(
          await t.handler(
            {
              action: 'create',
              topic: 'Install and initialize Myco',
              rationale: 'Duplicate of a pending identified candidate',
            },
            undefined,
          ),
        ) as { error?: string; existing_candidate?: { status: string } };

        expect(result.error).toBeDefined();
        expect(result.error).toMatch(/review queue|update existing|identified/);
        expect(result.existing_candidate?.status).toBe('identified');
      });

      it('allows a genuinely distinct topic alongside a dismissed one', async () => {
        await seedCandidate('How to author an agent pipeline task', 'dismissed');

        const t = makeTool();
        const result = parseResult(
          await t.handler(
            {
              action: 'create',
              topic: 'How to render a notification banner in the UI',
              rationale: 'Unrelated topic',
            },
            undefined,
          ),
        ) as { error?: string; id?: string };

        expect(result.error).toBeUndefined();
        expect(result.id).toBeDefined();
      });
    });

    // Privilege separation — humans approve, agents cannot. The MCP boundary
    // parses args against the tool's inputSchema before invoking the handler.
    // These tests exercise the schema directly (the test harness calls handler
    // without schema validation) to prove the Zod enum refuses values the
    // agent is not allowed to set.
    describe('status enum narrowing (privilege separation)', () => {
      it('inputSchema.status rejects "approved"', () => {
        const t = findTool(tools, 'vault_skill_candidates');
        const parsed = z.object(t.inputSchema).safeParse({
          action: 'update',
          id: 'some-id',
          status: 'approved',
        });
        expect(parsed.success).toBe(false);
      });

      it('inputSchema.status rejects "generated"', () => {
        const t = findTool(tools, 'vault_skill_candidates');
        const parsed = z.object(t.inputSchema).safeParse({
          action: 'update',
          id: 'some-id',
          status: 'generated',
        });
        expect(parsed.success).toBe(false);
      });

      it('inputSchema.status accepts "identified" and "dismissed"', () => {
        const t = findTool(tools, 'vault_skill_candidates');
        for (const allowed of ['identified', 'dismissed'] as const) {
          const parsed = z.object(t.inputSchema).safeParse({
            action: 'update',
            id: 'some-id',
            status: allowed,
          });
          expect(parsed.success, `expected ${allowed} to be accepted`).toBe(true);
        }
      });
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

    it('scopes record lifecycle actions to the request project', async () => {
      const now = epochNow();
      insertSkillRecord({
        id: 'skill-project-a',
        project_id: 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        agent_id: TEST_AGENT_ID,
        name: 'project-a-skill',
        display_name: 'Project A Skill',
        description: 'Project A scoped skill',
        path: '.agents/skills/project-a-skill/SKILL.md',
        created_at: now,
        updated_at: now,
      });
      insertSkillRecord({
        id: 'skill-project-b',
        project_id: 'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        agent_id: TEST_AGENT_ID,
        name: 'project-b-skill',
        display_name: 'Project B Skill',
        description: 'Project B scoped skill',
        path: '.agents/skills/project-b-skill/SKILL.md',
        created_at: now,
        updated_at: now,
      });

      const projectATool = findTool(createProjectTools('proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), 'vault_skill_records');
      const projectBTool = findTool(createProjectTools('proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'), 'vault_skill_records');

      const listA = parseResult(
        await projectATool.handler({ action: 'list' }, undefined),
      ) as Array<{ id: string; project_id: string }>;
      expect(listA).toHaveLength(1);
      expect(listA[0].id).toBe('skill-project-a');
      expect(listA[0].project_id).toBe('proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

      const crossGet = parseResult(
        await projectATool.handler({ action: 'get', id: 'skill-project-b' }, undefined),
      ) as { error?: string };
      expect(crossGet.error).toContain('Skill record not found');

      const crossUpdate = parseResult(
        await projectATool.handler(
          { action: 'update', id: 'skill-project-b', status: 'stale' },
          undefined,
        ),
      ) as { error?: string };
      expect(crossUpdate.error).toContain('Skill record not found');

      const crossDelete = parseResult(
        await projectATool.handler({ action: 'delete', id: 'skill-project-b' }, undefined),
      ) as { error?: string };
      expect(crossDelete.error).toContain('Skill record not found');

      const stillInB = parseResult(
        await projectBTool.handler({ action: 'get', id: 'skill-project-b' }, undefined),
      ) as { id: string; project_id: string };
      expect(stillInB.id).toBe('skill-project-b');
      expect(stillInB.project_id).toBe('proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
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

    it('rejects names with path separators or dot-dot segments', async () => {
      const t = findTool(tools, 'vault_write_skill');
      const liveSkillsDir = path.join(tmpDir, '.agents', 'skills');

      for (const name of ['../../etc', '../foo', 'foo/bar', '..', 'foo/../bar']) {
        const result = parseResult(
          await t.handler(
            {
              name,
              display_name: 'Invalid Skill',
              description: 'Should be rejected before any write occurs',
              content: validSkillContent(name),
            },
            undefined,
          ),
        ) as { error?: string };

        expect(result.error).toContain('Invalid skill name');
      }

      expect(fs.existsSync(liveSkillsDir)).toBe(false);
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
      // Create a candidate first, then flip to approved so the
      // skill-write tools' structural gate accepts it.
      const candidateTool = findTool(tools, 'vault_skill_candidates');
      const candidateResult = await candidateTool.handler(
        { action: 'create', topic: 'My topic', rationale: 'My rationale' },
        undefined,
      );
      const candidate = parseResult(candidateResult) as { id: string };
      approveCandidate(candidate.id);

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

    it('creates skill records and candidate transitions in the request project', async () => {
      const projectATools = createProjectTools('proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
      const projectBTools = createProjectTools('proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
      const candidateToolA = findTool(projectATools, 'vault_skill_candidates');
      const created = parseResult(
        await candidateToolA.handler(
          { action: 'create', topic: 'Scoped skill write', rationale: 'Project A only' },
          undefined,
        ),
      ) as { id: string; project_id: string };
      approveCandidate(created.id, 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

      const writeToolA = findTool(projectATools, 'vault_write_skill');
      const written = parseResult(
        await writeToolA.handler(
          {
            name: 'scoped-skill-write',
            display_name: 'Scoped Skill Write',
            description: 'Materialized in one request project',
            content: validSkillContent('scoped-skill-write', '# Scoped Skill Write'),
            candidate_id: created.id,
          },
          undefined,
        ),
      ) as { id: string; name: string; error?: string };
      expect(written.error).toBeUndefined();
      expect(written.name).toBe('scoped-skill-write');

      const recordA = parseResult(
        await findTool(projectATools, 'vault_skill_records').handler(
          { action: 'get', id: 'scoped-skill-write' },
          undefined,
        ),
      ) as { id: string; project_id: string; candidate_id: string };
      expect(recordA.id).toBe(written.id);
      expect(recordA.project_id).toBe('proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
      expect(recordA.candidate_id).toBe(created.id);

      const candidateA = parseResult(
        await candidateToolA.handler({ action: 'get', id: created.id }, undefined),
      ) as { status: string; skill_id: string; project_id: string };
      expect(candidateA.status).toBe('generated');
      expect(candidateA.skill_id).toBe(written.id);
      expect(candidateA.project_id).toBe('proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

      const recordB = parseResult(
        await findTool(projectBTools, 'vault_skill_records').handler(
          { action: 'get', id: 'scoped-skill-write' },
          undefined,
        ),
      ) as { error?: string };
      expect(recordB.error).toContain('Skill record not found');

      const candidateB = parseResult(
        await findTool(projectBTools, 'vault_skill_candidates').handler(
          { action: 'get', id: created.id },
          undefined,
        ),
      ) as { error?: string };
      expect(candidateB.error).toContain('Candidate not found');
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
      approveCandidate(candidate.id);

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
      approveCandidate(candidate.id);

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

  // -------------------------------------------------------------------------
  // vault_stage_skill — provisional writes used by skill-generate's draft
  // phase. Writes SKILL.md + manifest.json to .myco/staging/skills/<cand>/
  // but does NOT touch the live DB or .agents/skills/ directory.
  // -------------------------------------------------------------------------

  describe('vault_stage_skill', () => {
    it('stages a SKILL.md + manifest without creating a skill_records row', async () => {
      // Seed a candidate
      const candidateTool = findTool(tools, 'vault_skill_candidates');
      const candidateResult = await candidateTool.handler(
        { action: 'create', topic: 'Staging topic', rationale: 'Test rationale' },
        undefined,
      );
      const candidate = parseResult(candidateResult) as { id: string };
      approveCandidate(candidate.id);

      // Stage a skill
      const stageTool = findTool(tools, 'vault_stage_skill');
      const result = await stageTool.handler(
        {
          candidate_id: candidate.id,
          name: 'staged-skill',
          display_name: 'Staged Skill',
          description: 'A skill written to staging',
          content: validSkillContent('staged-skill', '# Staged'),
          rationale: 'Initial stage',
        },
        undefined,
      );
      const data = parseResult(result) as {
        candidate_id: string;
        staging_path: string;
        status: string;
      };

      // Assert staging metadata returned
      expect(data.candidate_id).toBe(candidate.id);
      expect(data.status).toBe('staged');
      expect(data.staging_path).toContain(candidate.id);
      expect(fs.existsSync(data.staging_path)).toBe(true);

      // Assert NO skill record was created
      const recordsTool = findTool(tools, 'vault_skill_records');
      const recordsResult = await recordsTool.handler({ action: 'list' }, undefined);
      expect(parseResult(recordsResult)).toEqual([]);

      // Assert the live .agents/skills/ directory does NOT contain the skill
      const liveFile = path.join(tmpDir, '.agents', 'skills', 'staged-skill', 'SKILL.md');
      expect(fs.existsSync(liveFile)).toBe(false);

      // Candidate stays in 'approved' state — staging does not advance
      // the lifecycle to 'generated' (that's finalize's job).
      const getResult = await candidateTool.handler(
        { action: 'get', id: candidate.id },
        undefined,
      );
      const updated = parseResult(getResult) as { status: string; skill_id: string | null };
      expect(updated.status).toBe('approved');
      expect(updated.skill_id).toBeNull();
    });

    it('rejects invalid skill directory names before writing staging files', async () => {
      const candidateTool = findTool(tools, 'vault_skill_candidates');
      const candidate = parseResult(
        await candidateTool.handler(
          { action: 'create', topic: 'Invalid name topic', rationale: 'r' },
          undefined,
        ),
      ) as { id: string };
      approveCandidate(candidate.id);

      const stageTool = findTool(tools, 'vault_stage_skill');
      const stagingDir = path.join(vaultDir, 'staging', 'skills');

      for (const name of ['../../etc', '../foo', 'foo/bar', '..', 'foo/../bar']) {
        const result = parseResult(
          await stageTool.handler(
            {
              candidate_id: candidate.id,
              name,
              display_name: 'Invalid Staged Skill',
              description: 'Should be rejected before staging',
              content: validSkillContent(name),
            },
            undefined,
          ),
        ) as { error?: string };

        expect(result.error).toContain('Invalid skill name');
      }

      expect(fs.existsSync(stagingDir)).toBe(false);
    });

    it('overwrites a prior staged version for the same candidate (iterative drafts)', async () => {
      const candidateTool = findTool(tools, 'vault_skill_candidates');
      const candidate = parseResult(
        await candidateTool.handler(
          { action: 'create', topic: 'Iteration test', rationale: 'r' },
          undefined,
        ),
      ) as { id: string };
      approveCandidate(candidate.id);

      const stageTool = findTool(tools, 'vault_stage_skill');
      await stageTool.handler(
        {
          candidate_id: candidate.id,
          name: 'iter-skill',
          display_name: 'Iter Skill',
          description: 'First draft',
          content: validSkillContent('iter-skill', '# Version 1'),
          rationale: 'first pass',
        },
        undefined,
      );

      const secondResult = await stageTool.handler(
        {
          candidate_id: candidate.id,
          name: 'iter-skill',
          display_name: 'Iter Skill',
          description: 'Second draft',
          content: validSkillContent('iter-skill', '# Version 2'),
          rationale: 'revision',
        },
        undefined,
      );
      const parsed = parseResult(secondResult) as { staging_path: string; status: string };
      expect(parsed.status).toBe('staged');

      // Read back via staging helper and confirm it reflects v2
      expect(fs.readFileSync(parsed.staging_path, 'utf-8')).toContain('# Version 2');
    });

    it('rejects staging when validation fails on the content', async () => {
      const candidateTool = findTool(tools, 'vault_skill_candidates');
      const candidate = parseResult(
        await candidateTool.handler(
          { action: 'create', topic: 'Invalid staging', rationale: 'r' },
          undefined,
        ),
      ) as { id: string };
      approveCandidate(candidate.id);

      const stageTool = findTool(tools, 'vault_stage_skill');
      const result = await stageTool.handler(
        {
          candidate_id: candidate.id,
          name: 'broken-skill',
          display_name: 'Broken',
          description: 'Bad content',
          content: 'no frontmatter here — should fail validation',
          rationale: 'test',
        },
        undefined,
      );
      const parsed = parseResult(result) as { error?: string };
      expect(parsed.error).toBeDefined();
      expect(parsed.error).toMatch(/validation failed/i);
    });

    it('rejects staging when description overlaps an existing active skill', async () => {
      // Seed an active skill via vault_write_skill
      const writeTool = findTool(tools, 'vault_write_skill');
      await writeTool.handler(
        {
          name: 'existing-live',
          display_name: 'Existing Live',
          description: 'Structured error logging patterns for async background handlers',
          content: validSkillContent('existing-live', '# Live'),
        },
        undefined,
      );

      // Try to stage a new skill with a near-duplicate description
      const candidateTool = findTool(tools, 'vault_skill_candidates');
      const candidate = parseResult(
        await candidateTool.handler(
          { action: 'create', topic: 'Overlap test', rationale: 'r' },
          undefined,
        ),
      ) as { id: string };
      approveCandidate(candidate.id);

      const stageTool = findTool(tools, 'vault_stage_skill');
      const result = await stageTool.handler(
        {
          candidate_id: candidate.id,
          name: 'overlap-stage',
          display_name: 'Overlap Stage',
          description: 'Structured error logging patterns for async background handlers, retried',
          content: validSkillContent('overlap-stage', '# Stage'),
          rationale: 'test',
        },
        undefined,
      );
      const parsed = parseResult(result) as { error?: string };
      expect(parsed.error).toContain('overlaps with existing active skill');
    });
  });

  // -------------------------------------------------------------------------
  // Approved-status gate — skill-write tools must refuse to operate on
  // candidates that are not in 'approved' state. This is the structural
  // enforcement that prevents skill-generate from writing skills for
  // candidates a human never signed off on.
  // -------------------------------------------------------------------------

  describe('approved-status gate', () => {
    async function stage(candidateId: string, name: string) {
      const stageTool = findTool(tools, 'vault_stage_skill');
      return parseResult(
        await stageTool.handler(
          {
            candidate_id: candidateId,
            name,
            display_name: name,
            description: `Gate test for ${name}`,
            content: validSkillContent(name),
            rationale: 'gate test',
          },
          undefined,
        ),
      ) as { error?: string; status?: string };
    }

    it('vault_stage_skill rejects a candidate in identified state', async () => {
      const candidateTool = findTool(tools, 'vault_skill_candidates');
      const candidate = parseResult(
        await candidateTool.handler(
          { action: 'create', topic: 'Gate identified', rationale: 'r' },
          undefined,
        ),
      ) as { id: string; status: string };
      expect(candidate.status).toBe('identified');

      const result = await stage(candidate.id, 'gate-identified');
      expect(result.error).toBeDefined();
      expect(result.error).toMatch(/identified/);
      expect(result.error).toMatch(/approved/);
    });

    it('vault_stage_skill rejects a candidate in dismissed state', async () => {
      const candidateTool = findTool(tools, 'vault_skill_candidates');
      const candidate = parseResult(
        await candidateTool.handler(
          { action: 'create', topic: 'Gate dismissed', rationale: 'r' },
          undefined,
        ),
      ) as { id: string };
      updateCandidate(candidate.id, { status: 'dismissed', updated_at: epochNow() }, ALL_PROJECTS_SCOPE);

      const result = await stage(candidate.id, 'gate-dismissed');
      expect(result.error).toBeDefined();
      expect(result.error).toMatch(/dismissed|not approved/i);
    });

    it('vault_stage_skill rejects a candidate in generated state', async () => {
      // A generated candidate is already fulfilled — re-staging would
      // create a duplicate under a different name.
      const candidateTool = findTool(tools, 'vault_skill_candidates');
      const candidate = parseResult(
        await candidateTool.handler(
          { action: 'create', topic: 'Gate generated', rationale: 'r' },
          undefined,
        ),
      ) as { id: string };
      updateCandidate(candidate.id, { status: 'generated', updated_at: epochNow() }, ALL_PROJECTS_SCOPE);

      const result = await stage(candidate.id, 'gate-generated');
      expect(result.error).toBeDefined();
      expect(result.error).toMatch(/generated|already fulfilled|not approved/i);
    });

    it('vault_stage_skill rejects when candidate_id does not exist', async () => {
      const result = await stage('cand-does-not-exist', 'gate-missing');
      expect(result.error).toBeDefined();
      expect(result.error).toMatch(/not found|missing/i);
    });

    it('vault_stage_skill accepts a candidate in approved state', async () => {
      const candidateTool = findTool(tools, 'vault_skill_candidates');
      const candidate = parseResult(
        await candidateTool.handler(
          { action: 'create', topic: 'Gate approved', rationale: 'r' },
          undefined,
        ),
      ) as { id: string };
      approveCandidate(candidate.id);

      const result = await stage(candidate.id, 'gate-approved');
      expect(result.error).toBeUndefined();
      expect(result.status).toBe('staged');
    });

    it('vault_stage_skill rejects malformed YAML frontmatter', async () => {
      const candidateTool = findTool(tools, 'vault_skill_candidates');
      const candidate = parseResult(
        await candidateTool.handler(
          { action: 'create', topic: 'Gate malformed yaml', rationale: 'r' },
          undefined,
        ),
      ) as { id: string };
      approveCandidate(candidate.id);

      const stageTool = findTool(tools, 'vault_stage_skill');
      const result = parseResult(
        await stageTool.handler(
          {
            candidate_id: candidate.id,
            name: 'gate-malformed-yaml',
            display_name: 'Gate Malformed YAML',
            description: 'Malformed YAML skill',
            content:
              '---\n' +
              'name: myco:gate-malformed-yaml\n' +
              'description: Use this skill for end-to-end delivery: planning, coding, verification\n' +
              'managed_by: myco\n' +
              'user-invocable: true\n' +
              'allowed-tools: Read, Grep, Glob\n' +
              '---\n\n# Broken',
            rationale: 'gate test',
          },
          undefined,
        ),
      ) as { error?: string; issues?: string[] };

      expect(result.error).toContain('validation failed');
      expect(result.issues?.some((issue) => issue.includes('Invalid YAML frontmatter'))).toBe(true);
    });

    it('vault_stage_skill rejects descriptions over the compatibility limit', async () => {
      const candidateTool = findTool(tools, 'vault_skill_candidates');
      const candidate = parseResult(
        await candidateTool.handler(
          { action: 'create', topic: 'Gate long description', rationale: 'r' },
          undefined,
        ),
      ) as { id: string };
      approveCandidate(candidate.id);

      const tooLongDescription = 'a'.repeat(MAX_SKILL_DESCRIPTION_CHARS + 1);
      const stageTool = findTool(tools, 'vault_stage_skill');
      const result = parseResult(
        await stageTool.handler(
          {
            candidate_id: candidate.id,
            name: 'gate-long-description',
            display_name: 'Gate Long Description',
            description: tooLongDescription,
            content:
              '---\n' +
              'name: myco:gate-long-description\n' +
              `description: ${tooLongDescription}\n` +
              'managed_by: myco\n' +
              'user-invocable: true\n' +
              'allowed-tools: Read, Grep, Glob\n' +
              '---\n\n# Too long',
            rationale: 'gate test',
          },
          undefined,
        ),
      ) as { error?: string; issues?: string[] };

      expect(result.error).toContain('validation failed');
      expect(
        result.issues?.some((issue) =>
          issue.includes(`description exceeds maximum length of ${MAX_SKILL_DESCRIPTION_CHARS}`)),
      ).toBe(true);
    });

    it('vault_write_skill rejects create path when candidate is not approved', async () => {
      const candidateTool = findTool(tools, 'vault_skill_candidates');
      const candidate = parseResult(
        await candidateTool.handler(
          { action: 'create', topic: 'Gate write identified', rationale: 'r' },
          undefined,
        ),
      ) as { id: string };
      // Leave candidate in 'identified' state.

      const writeTool = findTool(tools, 'vault_write_skill');
      const result = parseResult(
        await writeTool.handler(
          {
            name: 'gate-write-identified',
            display_name: 'Gate Write',
            description: 'Test write gate against identified candidate',
            content: validSkillContent('gate-write-identified'),
            candidate_id: candidate.id,
          },
          undefined,
        ),
      ) as { error?: string };
      expect(result.error).toBeDefined();
      expect(result.error).toMatch(/identified/);
      expect(result.error).toMatch(/approved/);
    });

    it('vault_write_skill allows evolve path regardless of candidate_id status', async () => {
      // Seed a live skill first (no candidate linkage).
      const writeTool = findTool(tools, 'vault_write_skill');
      await writeTool.handler(
        {
          name: 'evolve-no-candidate',
          display_name: 'Evolve Gate Test',
          description: 'Seed for evolve-path gate test',
          content: validSkillContent('evolve-no-candidate', '# V1'),
        },
        undefined,
      );

      // Evolve path is triggered by same-name write. Candidate status is
      // irrelevant here — the caller is updating an existing skill, not
      // creating a new one. No structural gate should fire.
      const result = parseResult(
        await writeTool.handler(
          {
            name: 'evolve-no-candidate',
            display_name: 'Evolve Gate Test',
            description: 'Updated during evolve path',
            content: validSkillContent('evolve-no-candidate', '# V2'),
          },
          undefined,
        ),
      ) as { generation?: number; error?: string };
      expect(result.error).toBeUndefined();
      expect(result.generation).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // vault_finalize_skill — promotes a staged skill to live. Reads the
  // manifest.json + SKILL.md written by vault_stage_skill, re-runs the
  // dedup + validation gates as defense in depth, then atomically creates
  // the skill_records row, lineage entry, candidate transition to
  // 'generated', disk file, and symbiont symlinks. Cleans up staging on
  // success.
  // -------------------------------------------------------------------------

  describe('vault_finalize_skill', () => {
    async function stageForFinalize(candidateId: string, name: string) {
      const stageTool = findTool(tools, 'vault_stage_skill');
      return parseResult(
        await stageTool.handler(
          {
            candidate_id: candidateId,
            name,
            display_name: name,
            description: `Description for ${name}`,
            content: validSkillContent(name, `# ${name}`),
            rationale: 'Initial draft',
          },
          undefined,
        ),
      );
    }

    it('promotes a staged skill to .agents/skills and creates DB rows', async () => {
      // Seed candidate + stage content
      const candidateTool = findTool(tools, 'vault_skill_candidates');
      const candidate = parseResult(
        await candidateTool.handler(
          { action: 'create', topic: 'Finalize topic', rationale: 'r' },
          undefined,
        ),
      ) as { id: string };
      approveCandidate(candidate.id);
      await stageForFinalize(candidate.id, 'finalize-me');

      // Finalize
      const finalizeTool = findTool(tools, 'vault_finalize_skill');
      const result = await finalizeTool.handler(
        { candidate_id: candidate.id },
        undefined,
      );
      const data = parseResult(result) as {
        id: string;
        name: string;
        path: string;
        generation: number;
      };

      expect(data.name).toBe('finalize-me');
      expect(data.generation).toBe(1);
      expect(data.path).toBe('.agents/skills/finalize-me/SKILL.md');

      // Disk file
      const liveFile = path.join(tmpDir, '.agents', 'skills', 'finalize-me', 'SKILL.md');
      expect(fs.existsSync(liveFile)).toBe(true);

      // DB row
      const recordsTool = findTool(tools, 'vault_skill_records');
      const record = parseResult(
        await recordsTool.handler({ action: 'get', id: 'finalize-me' }, undefined),
      ) as { name: string };
      expect(record.name).toBe('finalize-me');

      // Candidate flipped to generated
      const updated = parseResult(
        await candidateTool.handler({ action: 'get', id: candidate.id }, undefined),
      ) as { status: string; skill_id: string };
      expect(updated.status).toBe('generated');
      expect(updated.skill_id).toBe(data.id);

      // Staging cleaned up
      const stagingFile = path.join(
        vaultDir,
        'staging',
        'skills',
        candidate.id,
        'SKILL.md',
      );
      expect(fs.existsSync(stagingFile)).toBe(false);
    });

    it('errors when no staged content exists for the candidate', async () => {
      const finalizeTool = findTool(tools, 'vault_finalize_skill');
      const result = await finalizeTool.handler(
        { candidate_id: 'cand-never-staged' },
        undefined,
      );
      const parsed = parseResult(result) as { error?: string };
      expect(parsed.error).toBeDefined();
      expect(parsed.error).toMatch(/no staged/i);
    });

    it('re-runs dedup gate on the staged content before promoting', async () => {
      // Seed a live skill with a distinctive description
      const writeTool = findTool(tools, 'vault_write_skill');
      await writeTool.handler(
        {
          name: 'live-defense',
          display_name: 'Live Defense',
          description: 'Very specific error retry patterns for async worker queues and jobs',
          content: validSkillContent('live-defense', '# Live'),
        },
        undefined,
      );

      // Stage a skill with a fresh candidate whose description does NOT overlap
      // (to bypass stage-time gate), then mutate the staged content to overlap
      // before finalize.
      const candidateTool = findTool(tools, 'vault_skill_candidates');
      const candidate = parseResult(
        await candidateTool.handler(
          { action: 'create', topic: 'Defense test', rationale: 'r' },
          undefined,
        ),
      ) as { id: string };
      approveCandidate(candidate.id);

      const stageTool = findTool(tools, 'vault_stage_skill');
      await stageTool.handler(
        {
          candidate_id: candidate.id,
          name: 'defense-stage',
          display_name: 'Defense Stage',
          description: 'Completely unrelated topic about caching',
          content: validSkillContent('defense-stage', '# Defense'),
          rationale: 'Defense test',
        },
        undefined,
      );

      // Tamper the manifest to overlap with the live skill's description.
      const manifestPath = path.join(
        vaultDir,
        'staging',
        'skills',
        candidate.id,
        'manifest.json',
      );
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      manifest.description =
        'Very specific error retry patterns for async worker queues and jobs, tuned';
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

      // Finalize should reject
      const finalizeTool = findTool(tools, 'vault_finalize_skill');
      const result = await finalizeTool.handler(
        { candidate_id: candidate.id },
        undefined,
      );
      const parsed = parseResult(result) as { error?: string };
      expect(parsed.error).toContain('overlaps with existing active skill');

      // Assert no skill record created and no live file
      const liveFile = path.join(tmpDir, '.agents', 'skills', 'defense-stage', 'SKILL.md');
      expect(fs.existsSync(liveFile)).toBe(false);
      const recordsTool = findTool(tools, 'vault_skill_records');
      const records = parseResult(
        await recordsTool.handler({ action: 'list' }, undefined),
      ) as Array<{ name: string }>;
      expect(records.find((r) => r.name === 'defense-stage')).toBeUndefined();
    });

    it('removes symbiont symlinks when finalize rolls back after creating them', async () => {
      const candidateTool = findTool(tools, 'vault_skill_candidates');
      const candidate = parseResult(
        await candidateTool.handler(
          { action: 'create', topic: 'Rollback cleanup topic', rationale: 'r' },
          undefined,
        ),
      ) as { id: string };
      approveCandidate(candidate.id);
      await stageForFinalize(candidate.id, 'rollback-symlink-cleanup');

      // Tamper the staged manifest so the DB transaction fails on the
      // inserted skill_records.candidate_id FK after the live file and
      // symbiont symlinks have already been created.
      const manifestPath = path.join(
        vaultDir,
        'staging',
        'skills',
        candidate.id,
        'manifest.json',
      );
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      manifest.candidate_id = 'cand-missing-after-stage';
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

      const finalizeTool = findTool(tools, 'vault_finalize_skill');
      const result = parseResult(
        await finalizeTool.handler({ candidate_id: candidate.id }, undefined),
      ) as { error?: string };

      expect(result.error).toContain('database transaction failed');

      const liveFile = path.join(
        tmpDir,
        '.agents',
        'skills',
        'rollback-symlink-cleanup',
        'SKILL.md',
      );
      const claudeSymlink = path.join(
        tmpDir,
        '.claude',
        'skills',
        'rollback-symlink-cleanup',
      );
      const cursorSymlink = path.join(
        tmpDir,
        '.cursor',
        'skills',
        'rollback-symlink-cleanup',
      );

      expect(fs.existsSync(liveFile)).toBe(false);
      expect(fs.existsSync(claudeSymlink)).toBe(false);
      expect(fs.existsSync(cursorSymlink)).toBe(false);
    });

    it('preserves approved_at on the candidate after transition to generated', async () => {
      // Seed an already-approved candidate with a known approved_at
      const candidateTool = findTool(tools, 'vault_skill_candidates');
      const candidateRaw = parseResult(
        await candidateTool.handler(
          { action: 'create', topic: 'Approved audit', rationale: 'r' },
          undefined,
        ),
      ) as { id: string };

      // Flip to approved via the REST handler path (simulates UI click).
      // The agent tool has been locked down in Task 2, so we use the
      // query helper directly to simulate the human approval.
      const { updateCandidate } = await import('@myco/db/queries/skill-candidates.js');
      const approvedAt = epochNow();
      updateCandidate(candidateRaw.id, {
        status: 'approved',
        updated_at: approvedAt,
      }, ALL_PROJECTS_SCOPE);

      await stageForFinalize(candidateRaw.id, 'audit-preserve');
      const finalizeTool = findTool(tools, 'vault_finalize_skill');
      await finalizeTool.handler(
        { candidate_id: candidateRaw.id },
        undefined,
      );

      const final = parseResult(
        await candidateTool.handler({ action: 'get', id: candidateRaw.id }, undefined),
      ) as { status: string; approved_at: number | null };
      expect(final.status).toBe('generated');
      expect(final.approved_at).toBe(approvedAt);
    });
  });
});
