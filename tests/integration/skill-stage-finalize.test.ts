/**
 * Integration tests for the staging → finalize skill pipeline.
 *
 * These exercise the two new tools (vault_stage_skill, vault_finalize_skill)
 * in the realistic scenarios that motivated the 2026-04-08 audit:
 *
 *   1. Happy path: stage → finalize promotes atomically, cleans staging,
 *      and preserves approved_at on the candidate.
 *   2. Failure path: stage succeeds, something blocks finalize, staging
 *      is NOT promoted — no skill_records row, no .agents/skills/ file,
 *      candidate stays in its pre-finalize state. This is the inverse of
 *      the original orphan-skill bug.
 *   3. Cleanup on required-phase failure: the executor hook detects
 *      skill-generate failure and removes the staging directory.
 *
 * The executor-hook test imports the cleanup helper directly rather
 * than actually running the agent executor (the executor spawns a
 * subprocess and an LLM provider; that's covered by end-to-end smoke
 * tests in the daemon).
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Mock embedding like the skill-tools unit test suite
vi.mock('@myco/intelligence/embed-query.js', () => ({ tryEmbed: async () => null }));

import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db';
import { registerAgent } from '@myco/db/queries/agents.js';
import { insertCandidate, getCandidate, updateCandidate } from '@myco/db/queries/skill-candidates.js';
import { listSkillRecords, getSkillRecordByName } from '@myco/db/queries/skill-records.js';
import { insertRun } from '@myco/db/queries/runs.js';
import { createVaultTools } from '@myco/agent/tools.js';
import { cleanupStagedSkill, stagingPath, stagingManifestPath } from '@myco/agent/tools/skill-staging.js';
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';

const AGENT_ID = 'agent-int';
const RUN_ID = 'run-int-001';
const epochNow = () => Math.floor(Date.now() / 1000);

function validSkillContent(name: string, body = '# Content') {
  return `---\nname: myco:${name}\ndescription: ${name} description\nmanaged_by: myco\nuser-invocable: true\nallowed-tools: Read, Grep, Glob\n---\n\n${body}`;
}

function findTool(tools: ReturnType<typeof createVaultTools>, name: string) {
  const t = tools.find((tool) => tool.name === name);
  if (!t) throw new Error(`Tool not found: ${name}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return t as SdkMcpToolDefinition<any>;
}

function parseResult(result: { content: Array<{ type: string; text: string }> }): unknown {
  return JSON.parse(result.content[0].text);
}

describe('skill staging → finalize pipeline', () => {
  let tools: ReturnType<typeof createVaultTools>;
  let tmpDir: string;
  let vaultDir: string;

  beforeAll(() => {
    setupTestDb();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-stage-finalize-'));
    vaultDir = path.join(tmpDir, '.myco');
    fs.mkdirSync(vaultDir, { recursive: true });
  });

  afterAll(() => {
    teardownTestDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    cleanTestDb();
    const now = epochNow();
    registerAgent({ id: AGENT_ID, name: 'Integration Test Agent', created_at: now });
    insertRun({
      id: RUN_ID,
      agent_id: AGENT_ID,
      status: 'running',
      started_at: now,
    });

    // Wipe staging between tests to prevent candidate_id collisions
    fs.rmSync(path.join(vaultDir, 'staging'), { recursive: true, force: true });

    tools = createVaultTools(AGENT_ID, RUN_ID, { projectRoot: tmpDir, vaultDir });
  });

  // --------------------------------------------------------------------------
  // Happy path
  // --------------------------------------------------------------------------

  it('stage → finalize: atomic promotion, staging cleaned, approved_at preserved', async () => {
    // Seed an approved candidate with a known approved_at
    const now = epochNow();
    const candidate = insertCandidate({
      id: 'cand-happy',
      agent_id: AGENT_ID,
      topic: 'Happy path topic',
      rationale: 'Integration rationale',
      created_at: now - 100,
      updated_at: now - 100,
    });
    expect(candidate.approved_at).toBeNull();

    const approvedAt = now - 50;
    updateCandidate('cand-happy', { status: 'approved', updated_at: approvedAt });
    expect(getCandidate('cand-happy')!.approved_at).toBe(approvedAt);

    // Stage
    const stageTool = findTool(tools, 'vault_stage_skill');
    const stageResult = parseResult(
      await stageTool.handler(
        {
          candidate_id: 'cand-happy',
          name: 'happy-skill',
          display_name: 'Happy Skill',
          description: 'Test integration happy path',
          content: validSkillContent('happy-skill'),
          rationale: 'first stage',
        },
        undefined,
      ),
    ) as { status: string };
    expect(stageResult.status).toBe('staged');

    // After stage: live file/row MUST NOT exist
    expect(getSkillRecordByName('happy-skill')).toBeNull();
    expect(fs.existsSync(path.join(tmpDir, '.agents', 'skills', 'happy-skill', 'SKILL.md'))).toBe(false);
    expect(getCandidate('cand-happy')!.status).toBe('approved');

    // Finalize
    const finalizeTool = findTool(tools, 'vault_finalize_skill');
    const finalizeResult = parseResult(
      await finalizeTool.handler({ candidate_id: 'cand-happy' }, undefined),
    ) as { name: string; path: string; generation: number };
    expect(finalizeResult.name).toBe('happy-skill');
    expect(finalizeResult.generation).toBe(1);

    // Live file and row exist now
    expect(fs.existsSync(path.join(tmpDir, '.agents', 'skills', 'happy-skill', 'SKILL.md'))).toBe(true);
    expect(getSkillRecordByName('happy-skill')).not.toBeNull();

    // Candidate flipped, approved_at preserved
    const finalCandidate = getCandidate('cand-happy')!;
    expect(finalCandidate.status).toBe('generated');
    expect(finalCandidate.approved_at).toBe(approvedAt);
    expect(finalCandidate.skill_id).not.toBeNull();

    // Staging cleaned
    expect(fs.existsSync(stagingPath(vaultDir, 'cand-happy'))).toBe(false);
    expect(fs.existsSync(stagingManifestPath(vaultDir, 'cand-happy'))).toBe(false);
  });

  // --------------------------------------------------------------------------
  // Failure path — the inverse of the original orphan-skill bug
  // --------------------------------------------------------------------------

  it('draft success + validate failure (no finalize) + cleanup: candidate stays approved, no orphan', async () => {
    const now = epochNow();
    insertCandidate({
      id: 'cand-orphan',
      agent_id: AGENT_ID,
      topic: 'Orphan test',
      rationale: 'Integration rationale',
      created_at: now - 100,
      updated_at: now - 100,
    });
    const approvedAt = now - 50;
    updateCandidate('cand-orphan', { status: 'approved', updated_at: approvedAt });

    // Stage (draft phase succeeds)
    const stageTool = findTool(tools, 'vault_stage_skill');
    await stageTool.handler(
      {
        candidate_id: 'cand-orphan',
        name: 'orphan-skill',
        display_name: 'Orphan Skill',
        description: 'Integration orphan test',
        content: validSkillContent('orphan-skill'),
        rationale: 'draft',
      },
      undefined,
    );

    // Assert staging exists
    expect(fs.existsSync(stagingPath(vaultDir, 'cand-orphan'))).toBe(true);

    // Simulate validate phase failing (no finalize call) — then
    // the executor cleanup hook runs. We call the cleanup helper
    // directly here to mirror what the executor does.
    cleanupStagedSkill(vaultDir, 'cand-orphan');

    // Assert no orphan skill anywhere
    expect(getSkillRecordByName('orphan-skill')).toBeNull();
    expect(listSkillRecords({ agent_id: AGENT_ID })).toEqual([]);
    expect(fs.existsSync(path.join(tmpDir, '.agents', 'skills', 'orphan-skill', 'SKILL.md'))).toBe(false);
    expect(fs.existsSync(stagingPath(vaultDir, 'cand-orphan'))).toBe(false);

    // Candidate is still approved and still carries its audit timestamp —
    // ready for the next generate cycle.
    const stillApproved = getCandidate('cand-orphan')!;
    expect(stillApproved.status).toBe('approved');
    expect(stillApproved.approved_at).toBe(approvedAt);
    expect(stillApproved.skill_id).toBeNull();
  });

  // --------------------------------------------------------------------------
  // Iterative rewrite — the draft phase may re-stage multiple times
  // --------------------------------------------------------------------------

  it('iterative drafts: last stage wins and finalize uses it', async () => {
    const now = epochNow();
    insertCandidate({
      id: 'cand-iter',
      agent_id: AGENT_ID,
      topic: 'Iterative test',
      rationale: 'r',
      created_at: now,
      updated_at: now,
    });
    updateCandidate('cand-iter', { status: 'approved', updated_at: now });

    const stageTool = findTool(tools, 'vault_stage_skill');
    await stageTool.handler(
      {
        candidate_id: 'cand-iter',
        name: 'iter-skill',
        display_name: 'Iter Skill',
        description: 'First pass',
        content: validSkillContent('iter-skill', '# Version 1'),
        rationale: 'first',
      },
      undefined,
    );

    // Re-stage with refined content (validate phase found an issue)
    await stageTool.handler(
      {
        candidate_id: 'cand-iter',
        name: 'iter-skill',
        display_name: 'Iter Skill',
        description: 'Refined pass',
        content: validSkillContent('iter-skill', '# Version 2 with additional concrete examples'),
        rationale: 'revision',
      },
      undefined,
    );

    // Finalize — should promote v2
    const finalizeTool = findTool(tools, 'vault_finalize_skill');
    await finalizeTool.handler({ candidate_id: 'cand-iter' }, undefined);

    const liveFile = path.join(tmpDir, '.agents', 'skills', 'iter-skill', 'SKILL.md');
    expect(fs.readFileSync(liveFile, 'utf-8')).toContain('# Version 2');
  });

  // --------------------------------------------------------------------------
  // Edge: concurrent live skill appeared between stage and finalize
  // --------------------------------------------------------------------------

  it('finalize refuses if a live skill with the same name appeared after stage', async () => {
    const now = epochNow();
    insertCandidate({
      id: 'cand-race',
      agent_id: AGENT_ID,
      topic: 'Race test',
      rationale: 'r',
      created_at: now,
      updated_at: now,
    });
    updateCandidate('cand-race', { status: 'approved', updated_at: now });

    // Stage
    const stageTool = findTool(tools, 'vault_stage_skill');
    await stageTool.handler(
      {
        candidate_id: 'cand-race',
        name: 'race-skill',
        display_name: 'Race Skill',
        description: 'Race test description',
        content: validSkillContent('race-skill'),
        rationale: 'first',
      },
      undefined,
    );

    // Simulate a concurrent write that creates the same-named live skill
    // (e.g., an evolve task ran in parallel). Use the DB helper directly
    // so this mirrors any external path.
    const writeTool = findTool(tools, 'vault_write_skill');
    await writeTool.handler(
      {
        name: 'race-skill',
        display_name: 'Race Skill',
        description: 'Different origin',
        content: validSkillContent('race-skill', '# Concurrent'),
      },
      undefined,
    );

    // Finalize must refuse
    const finalizeTool = findTool(tools, 'vault_finalize_skill');
    const result = parseResult(
      await finalizeTool.handler({ candidate_id: 'cand-race' }, undefined),
    ) as { error?: string };
    expect(result.error).toMatch(/already exists/i);

    // The live (concurrent) skill is intact, not overwritten
    const liveFile = path.join(tmpDir, '.agents', 'skills', 'race-skill', 'SKILL.md');
    expect(fs.readFileSync(liveFile, 'utf-8')).toContain('# Concurrent');

    // Staging still exists — finalize doesn't clean up on failure
    expect(fs.existsSync(stagingPath(vaultDir, 'cand-race'))).toBe(true);
  });
});
