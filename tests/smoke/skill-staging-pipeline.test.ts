/**
 * Smoke test for the skill staging pipeline against a real on-disk
 * SQLite database. Complements the in-memory integration tests by
 * exercising WAL mode and the fresh-install DDL on a real file.
 *
 * macOS /var/folders → /private/var/folders symlinks are resolved via
 * realpathSync on the tmp path so downstream assertions are stable.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('@myco/intelligence/embed-query.js', () => ({ tryEmbed: async () => null }));

import { initDatabase, closeDatabase, getDatabase, SQLITE_DB_FILE } from '@myco/db/client.js';
import { createSchema, SCHEMA_VERSION } from '@myco/db/schema.js';
import { registerAgent } from '@myco/db/queries/agents.js';
import { insertCandidate, getCandidate, updateCandidate } from '@myco/db/queries/skill-candidates.js';
import { getSkillRecordByName, listSkillRecords } from '@myco/db/queries/skill-records.js';
import { insertRun } from '@myco/db/queries/runs.js';
import { createVaultTools } from '@myco/agent/tools.js';
import { cleanupStagedSkill, stagingPath } from '@myco/agent/tools/skill-staging.js';
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';

// ---------------------------------------------------------------------------
// Test harness constants
// ---------------------------------------------------------------------------

const AGENT_ID = 'smoke-agent';
const RUN_ID = 'smoke-run-001';

const epochNow = () => Math.floor(Date.now() / 1000);

function validSkillContent(name: string, body = '# Steps\n\n1. First step\n2. Second step') {
  return `---
name: myco:${name}
description: Smoke test skill ${name} exercising the staging pipeline end-to-end
managed_by: myco
user-invocable: true
allowed-tools: Read, Grep, Glob
---

${body}`;
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

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('smoke: skill staging pipeline (real on-disk SQLite)', () => {
  let tmpDir: string;
  let vaultDir: string;
  let dbPath: string;

  beforeAll(() => {
    // fs.realpathSync resolves /var/folders symlinks to /private/var/folders
    // so any downstream path comparison against the tmp dir is stable.
    const raw = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-smoke-staging-'));
    tmpDir = fs.realpathSync(raw);
    vaultDir = path.join(tmpDir, '.myco');
    fs.mkdirSync(vaultDir, { recursive: true });
    dbPath = path.join(vaultDir, SQLITE_DB_FILE);

    // Fresh v10 install via the app's normal initDatabase + createSchema
    // path — exercises WAL mode, the full fresh-install DDL, and the
    // schema_version row insert on a real SQLite file.
    closeDatabase(); // clear any singleton from a prior test
    const db = initDatabase(dbPath);
    createSchema(db, 'local');

    // Seed the agent + run rows that vault tools require as FKs
    registerAgent({
      id: AGENT_ID,
      name: 'Smoke Agent',
      created_at: epochNow(),
    });
    insertRun({
      id: RUN_ID,
      agent_id: AGENT_ID,
      status: 'running',
      started_at: epochNow(),
    });
  });

  afterAll(() => {
    closeDatabase();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // --------------------------------------------------------------------------
  // Schema lands at v10 on a fresh install against a real on-disk file
  // --------------------------------------------------------------------------

  it('fresh install records schema v13 and exposes approved_at on skill_candidates', () => {
    const db = getDatabase();

    const row = db
      .prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1')
      .get() as { version: number };
    expect(row.version).toBe(SCHEMA_VERSION);
    expect(row.version).toBe(13);

    const cols = db
      .prepare('PRAGMA table_info(skill_candidates)')
      .all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === 'approved_at')).toBe(true);
  });

  // --------------------------------------------------------------------------
  // Happy path — full stage → finalize cycle in one test. Both halves
  // assert the full filesystem + DB state at each checkpoint so a
  // regression in either stage or finalize fails with a clear message.
  // --------------------------------------------------------------------------

  it('stage → finalize: atomic promotion, staging cleaned, approved_at preserved', async () => {
    const candidateId = 'cand-smoke-happy';
    const now = epochNow();
    insertCandidate({
      id: candidateId,
      agent_id: AGENT_ID,
      topic: 'Smoke happy topic',
      rationale: 'Smoke rationale',
      created_at: now,
      updated_at: now,
    });
    updateCandidate(candidateId, { status: 'approved', updated_at: now });
    const approvedAtBefore = getCandidate(candidateId)!.approved_at;
    expect(approvedAtBefore).toBeGreaterThan(0);

    const tools = createVaultTools(AGENT_ID, RUN_ID, {
      projectRoot: tmpDir,
      vaultDir,
    });

    // -------- Stage --------
    const stageTool = findTool(tools, 'vault_stage_skill');
    const stageResult = parseResult(
      await stageTool.handler(
        {
          candidate_id: candidateId,
          name: 'smoke-happy',
          display_name: 'Smoke Happy',
          description: 'End-to-end smoke test — exercises the happy path',
          content: validSkillContent('smoke-happy'),
          rationale: 'smoke run',
        },
        undefined,
      ),
    ) as { status: string; staging_path: string };

    expect(stageResult.status).toBe('staged');
    expect(stageResult.staging_path).toContain(candidateId);

    const stagedFile = stagingPath(vaultDir, candidateId);
    expect(fs.existsSync(stagedFile)).toBe(true);
    const manifestFile = path.join(path.dirname(stagedFile), 'manifest.json');
    expect(fs.existsSync(manifestFile)).toBe(true);

    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf-8'));
    expect(manifest.name).toBe('smoke-happy');
    expect(manifest.candidate_id).toBe(candidateId);

    // Nothing written to the live area yet
    expect(
      fs.existsSync(path.join(tmpDir, '.agents', 'skills', 'smoke-happy', 'SKILL.md')),
    ).toBe(false);
    expect(getSkillRecordByName('smoke-happy')).toBeNull();
    expect(getCandidate(candidateId)!.status).toBe('approved');

    // -------- Finalize --------
    const finalizeTool = findTool(tools, 'vault_finalize_skill');
    const finalizeResult = parseResult(
      await finalizeTool.handler({ candidate_id: candidateId }, undefined),
    ) as { name: string; path: string; generation: number };

    expect(finalizeResult.name).toBe('smoke-happy');
    expect(finalizeResult.generation).toBe(1);
    expect(finalizeResult.path).toBe('.agents/skills/smoke-happy/SKILL.md');

    const liveFile = path.join(tmpDir, '.agents', 'skills', 'smoke-happy', 'SKILL.md');
    expect(fs.existsSync(liveFile)).toBe(true);
    expect(fs.readFileSync(liveFile, 'utf-8')).toContain('Smoke test skill smoke-happy');

    const record = getSkillRecordByName('smoke-happy');
    expect(record).not.toBeNull();
    expect(record!.description).toContain('End-to-end smoke test');

    const afterFinalize = getCandidate(candidateId)!;
    expect(afterFinalize.status).toBe('generated');
    expect(afterFinalize.approved_at).toBe(approvedAtBefore);
    expect(afterFinalize.skill_id).toBe(record!.id);

    // Staging cleaned; exactly one live skill now registered
    expect(fs.existsSync(stagedFile)).toBe(false);
    const records = listSkillRecords({ agent_id: AGENT_ID });
    expect(records).toHaveLength(1);
    expect(records[0].name).toBe('smoke-happy');
  });

  // --------------------------------------------------------------------------
  // Failure path — inverse of the original orphan-skill bug
  // --------------------------------------------------------------------------

  it('draft stages, validate fails, executor cleanup: no orphan anywhere', async () => {
    // Fresh candidate for the failure path
    const candidateId = 'cand-smoke-orphan';
    const now = epochNow();
    insertCandidate({
      id: candidateId,
      agent_id: AGENT_ID,
      topic: 'Smoke orphan topic',
      rationale: 'Test inverse of original orphan bug',
      created_at: now,
      updated_at: now,
    });
    updateCandidate(candidateId, { status: 'approved', updated_at: now });
    const approvedAtBeforeFailure = getCandidate(candidateId)!.approved_at!;
    expect(approvedAtBeforeFailure).toBeGreaterThan(0);

    // Stage (draft phase)
    const tools = createVaultTools(AGENT_ID, RUN_ID, {
      projectRoot: tmpDir,
      vaultDir,
    });
    const stageTool = findTool(tools, 'vault_stage_skill');
    await stageTool.handler(
      {
        candidate_id: candidateId,
        name: 'smoke-orphan',
        display_name: 'Smoke Orphan',
        description: 'This skill should never become live because validate will fail',
        content: validSkillContent('smoke-orphan'),
        rationale: 'pre-failure draft',
      },
      undefined,
    );

    // Confirm staged
    expect(fs.existsSync(stagingPath(vaultDir, candidateId))).toBe(true);

    // Simulate validate-phase failure path: the agent runs out of turns
    // and never calls vault_finalize_skill. The task executor's failure
    // hook fires cleanupStagedSkill. We call the same helper directly
    // here — this is exactly what src/agent/executor.ts does on
    // required-phase failure for skill-generate.
    cleanupStagedSkill(vaultDir, candidateId);

    // No orphan anywhere
    expect(fs.existsSync(stagingPath(vaultDir, candidateId))).toBe(false);
    expect(getSkillRecordByName('smoke-orphan')).toBeNull();
    expect(
      fs.existsSync(path.join(tmpDir, '.agents', 'skills', 'smoke-orphan', 'SKILL.md')),
    ).toBe(false);

    // Candidate still approved, audit trail intact — ready for the
    // next generate cycle to retry.
    const afterFailure = getCandidate(candidateId)!;
    expect(afterFailure.status).toBe('approved');
    expect(afterFailure.approved_at).toBe(approvedAtBeforeFailure);
    expect(afterFailure.skill_id).toBeNull();

    // No stray staging dirs anywhere (not just for this candidate)
    const stagingRootPath = path.join(vaultDir, 'staging', 'skills');
    if (fs.existsSync(stagingRootPath)) {
      const entries = fs.readdirSync(stagingRootPath);
      expect(entries).toEqual([]);
    }
  });
});
