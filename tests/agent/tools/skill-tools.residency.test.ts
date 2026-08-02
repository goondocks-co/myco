import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { withDatabase, openDatabase, type Database } from '@myco/db/client.js';
import { createSchema } from '@myco/db/schema.js';
import { registerAgent } from '@myco/db/queries/agents.js';
import { getSkillRecordByName } from '@myco/db/queries/skill-records.js';
import { insertContentClaim, getActiveContentClaim } from '@myco/db/queries/content-claims.js';
import { epochSeconds } from '@myco/constants.js';
import { assertGroveProjectId, createProjectId, GLOBAL_SCOPE } from '@myco/grove/ids.js';
import type { MycoRequestContext } from '@myco/grove/request-context.js';
import { createSkillTools } from '@myco/agent/tools/skill-tools.js';
import { collectSkillWriteIssues } from '@myco/agent/tools/skill-write-validator.js';
import type { VaultToolDeps } from '@myco/agent/tools/types.js';

/**
 * Task B1 — the Team Host residency write gate. A run served on the HOST for a
 * remote member (overlay-origin, `requestContext.hostServed`) must land the
 * skill RECORD in the Grove DB but write NO file to the host's disk: the host
 * holds the DB, never the member's working tree. A local run must behave exactly
 * as before (file written). These tests drive `vault_write_skill` end to end
 * against a real temp projectRoot + in-memory vault, and assert the on-disk
 * `.agents/skills/` target directly — proving the phantom write is gone.
 */

const VALID_SKILL_CONTENT = (dirName: string) => `---
name: myco:${dirName}
description: A durable procedure for exercising the residency publish gate in a hermetic test harness so behavior is observable.
managed_by: myco
user-invocable: false
allowed-tools: Read, Edit
---

# Residency Gate Fixture

## When to use

Use this fixture whenever the residency write gate needs a valid published skill body.

## Procedure

Follow the documented steps to keep the write path deterministic and reviewable.
`;

interface Handled {
  handler: (args: unknown, extra: unknown) => Promise<{ content: Array<{ type: 'text'; text: string }> }>;
  name: string;
}

function findTool(tools: unknown[], name: string): Handled {
  const found = (tools as Handled[]).find((t) => t.name === name);
  if (!found) throw new Error(`tool ${name} not found`);
  return found;
}

async function callTool(tool: Handled, args: unknown): Promise<Record<string, unknown>> {
  const res = await tool.handler(args, {});
  return JSON.parse(res.content[0].text) as Record<string, unknown>;
}

describe('Task B1 — skill working-tree write gate (overlay-origin)', () => {
  let db: Database;
  let projectRoot: string;
  const agentId = 'test-agent';
  const runId = 'residency-run-1';
  const projectId = assertGroveProjectId(createProjectId());

  beforeEach(() => {
    db = openDatabase(':memory:');
    createSchema(db);
    withDatabase(db, () => {
      registerAgent({ id: agentId, name: 'Test Agent', created_at: epochSeconds() });
    });
    projectRoot = mkdtempSync(path.join(tmpdir(), 'myco-residency-'));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  function deps(hostServed: boolean): VaultToolDeps {
    const requestContext: MycoRequestContext = {
      projectRoot,
      callerRoot: null,
      projectId,
      groveId: null,
      machineId: 'test-machine',
      sessionId: null,
      projectVaultDir: path.join(projectRoot, '.myco'),
      databasePath: ':memory:',
      source: 'headers',
      tenancySource: 'caller',
      hostServed,
    };
    return {
      agentId,
      runId,
      projectRoot,
      vaultDir: path.join(projectRoot, '.myco'),
      requestContext,
      recordTurn: () => null,
    };
  }

  function skillFilePath(name: string): string {
    return path.join(projectRoot, '.agents', 'skills', name, 'SKILL.md');
  }

  test('host-served create: RECORD lands in the Grove DB but NO file is written to the host tree', async () => {
    const name = 'host-served-create';
    await withDatabase(db, async () => {
      const write = findTool(createSkillTools(deps(true)), 'vault_write_skill');
      const result = await callTool(write, {
        name,
        display_name: 'Host Served Create',
        description: 'A durable procedure for exercising the residency publish gate in a hermetic test harness so behavior is observable.',
        content: VALID_SKILL_CONTENT(name),
      });

      // The DB record still lands (generation is unchanged by the gate).
      expect(result.error).toBeUndefined();
      expect(result.name).toBe(name);
      const record = getSkillRecordByName(name, GLOBAL_SCOPE);
      expect(record).not.toBeNull();
      expect(record?.generation).toBe(1);
    });

    // The phantom write is gone: nothing under .agents/skills exists on the host.
    expect(existsSync(skillFilePath(name))).toBe(false);
    expect(existsSync(path.join(projectRoot, '.agents', 'skills'))).toBe(false);
  });

  test('local create: DB-only as well — local and host-served now behave identically (claim-gated materialization)', async () => {
    const name = 'local-create';
    await withDatabase(db, async () => {
      const write = findTool(createSkillTools(deps(false)), 'vault_write_skill');
      const result = await callTool(write, {
        name,
        display_name: 'Local Create',
        description: 'A durable procedure for exercising the residency publish gate in a hermetic test harness so behavior is observable.',
        content: VALID_SKILL_CONTENT(name),
      });
      expect(result.error).toBeUndefined();
      expect(getSkillRecordByName(name, GLOBAL_SCOPE)).not.toBeNull();
    });

    // Disk delivery is the claim Publish flow's job everywhere — the residency
    // gate stopped being conditional when agent writes went DB-only.
    expect(existsSync(skillFilePath(name))).toBe(false);
    expect(existsSync(path.join(projectRoot, '.agents', 'skills'))).toBe(false);
  });

  test('host-served evolve: DB record bumps generation but the on-disk file is NOT rewritten', async () => {
    const name = 'evolve-target';
    // Seed generation 1 in the DB, then materialize the file the way the claim
    // Publish flow would (agent writes no longer materialize anything).
    await withDatabase(db, async () => {
      const write = findTool(createSkillTools(deps(false)), 'vault_write_skill');
      await callTool(write, {
        name,
        display_name: 'Evolve Target',
        description: 'A durable procedure for exercising the residency publish gate in a hermetic test harness so behavior is observable.',
        content: VALID_SKILL_CONTENT(name),
      });
    });
    mkdirSync(path.dirname(skillFilePath(name)), { recursive: true });
    writeFileSync(skillFilePath(name), VALID_SKILL_CONTENT(name), 'utf-8');
    const contentA = readFileSync(skillFilePath(name), 'utf-8');

    // Now evolve the SAME skill on a host-served run with different content (B).
    const contentB = VALID_SKILL_CONTENT(name).replace('# Residency Gate Fixture', '# Residency Gate Fixture (evolved on host)');
    await withDatabase(db, async () => {
      const write = findTool(createSkillTools(deps(true)), 'vault_write_skill');
      const result = await callTool(write, {
        name,
        display_name: 'Evolve Target',
        description: 'A durable procedure for exercising the residency publish gate in a hermetic test harness so behavior is observable, revised slightly for the evolve pass.',
        content: contentB,
      });
      expect(result.error).toBeUndefined();
      // The record was updated (generation bumped) — generation is not gated.
      expect(getSkillRecordByName(name, GLOBAL_SCOPE)?.generation).toBe(2);
    });

    // The host never rewrote the member's working-tree file: content is still A.
    expect(readFileSync(skillFilePath(name), 'utf-8')).toBe(contentA);
  });
});

describe('Task B1 — fabrication gate (skill-drift read) degrades on a host-served run', () => {
  // The fabrication gate scans the working tree for the paths/symbols a skill
  // claims. On the host that tree is absent, so the scan would flag every real
  // claim as fabricated. `hostServed` skips the scan (skill-drift read #1).
  const CONTENT_WITH_CLAIM = `---
name: myco:claim-fixture
description: A durable procedure that references a source file path to trip the fabrication gate when the tree is scanned.
managed_by: myco
user-invocable: false
allowed-tools: Read
---

# Claim Fixture

## When to use

When verifying the fabrication gate reads \`packages/does-not-exist/phantom-file.ts\` claims.
`;

  let root: string;

  beforeEach(() => {
    // A non-empty code tree so the fabrication gate actually runs (it no-ops on
    // an empty tree), but WITHOUT the claimed path — so a live scan flags it.
    root = mkdtempSync(path.join(tmpdir(), 'myco-claim-'));
    writeFileSync(path.join(root, 'real.ts'), 'export function real() { return 1; }\n', 'utf-8');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('local run: a claimed path absent from the tree is flagged as fabrication', () => {
    const result = collectSkillWriteIssues({
      content: CONTENT_WITH_CLAIM,
      name: 'claim-fixture',
      root,
      hostServed: false,
    });
    expect(result.claim).not.toBeNull();
    expect(result.claim?.missing_paths).toContain('packages/does-not-exist/phantom-file.ts');
  });

  test('host-served run: the fabrication scan is skipped (no false rejection) even against a populated tree', () => {
    const result = collectSkillWriteIssues({
      content: CONTENT_WITH_CLAIM,
      name: 'claim-fixture',
      root,
      hostServed: true,
    });
    expect(result.claim).toBeNull();
  });
});

describe('Task B5 — skill delete cancels the active claim, fs cleanup respects residency', () => {
  let db: Database;
  let projectRoot: string;
  const agentId = 'test-agent';
  const runId = 'residency-delete-run-1';
  const projectId = assertGroveProjectId(createProjectId());

  beforeEach(() => {
    db = openDatabase(':memory:');
    createSchema(db);
    withDatabase(db, () => {
      registerAgent({ id: agentId, name: 'Test Agent', created_at: epochSeconds() });
    });
    projectRoot = mkdtempSync(path.join(tmpdir(), 'myco-residency-delete-'));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  function deps(hostServed: boolean): VaultToolDeps {
    const requestContext: MycoRequestContext = {
      projectRoot,
      callerRoot: null,
      projectId,
      groveId: null,
      machineId: 'test-machine',
      sessionId: null,
      projectVaultDir: path.join(projectRoot, '.myco'),
      databasePath: ':memory:',
      source: 'headers',
      tenancySource: 'caller',
      hostServed,
    };
    return {
      agentId,
      runId,
      projectRoot,
      vaultDir: path.join(projectRoot, '.myco'),
      requestContext,
      recordTurn: () => null,
    };
  }

  function skillFilePath(name: string): string {
    return path.join(projectRoot, '.agents', 'skills', name, 'SKILL.md');
  }

  /** Seed a skill record, materialize its file as the Publish flow would, and claim it. */
  async function seedClaimedSkill(name: string): Promise<string> {
    await withDatabase(db, async () => {
      const write = findTool(createSkillTools(deps(false)), 'vault_write_skill');
      await callTool(write, {
        name,
        display_name: 'Delete Fixture',
        description: 'A durable procedure for exercising the delete-cancels-claim gate in a hermetic test harness.',
        content: VALID_SKILL_CONTENT(name),
      });
    });
    // Agent writes are DB-only; simulate a prior human Publish for the file.
    mkdirSync(path.dirname(skillFilePath(name)), { recursive: true });
    writeFileSync(skillFilePath(name), VALID_SKILL_CONTENT(name), 'utf-8');
    expect(existsSync(skillFilePath(name))).toBe(true);

    let skillId = '';
    withDatabase(db, () => {
      const record = getSkillRecordByName(name, GLOBAL_SCOPE)!;
      skillId = record.id;
      const claimed = insertContentClaim({
        artifactKind: 'skill',
        artifactId: record.id,
        generation: record.generation,
        projectId,
        claimedBy: 'member-machine',
        claimedAt: epochSeconds(),
        expiresAt: epochSeconds() + 86400,
        machineId: 'member-machine',
      });
      expect(claimed.ok).toBe(true);
    });
    return skillId;
  }

  test('host-served delete: the record and its active claim are gone, but the member-tree file is NOT touched', async () => {
    const name = 'host-served-delete';
    const skillId = await seedClaimedSkill(name);

    await withDatabase(db, async () => {
      const records = findTool(createSkillTools(deps(true)), 'vault_skill_records');
      const result = await callTool(records, { action: 'delete', id: skillId });
      expect(result.deleted).toBe(true);
      expect(getSkillRecordByName(name, GLOBAL_SCOPE)).toBeNull();
      // The explicit cancel fires regardless of residency — it runs where the
      // Grove DB row lives, which is exactly where this delete is dispatched.
      expect(getActiveContentClaim('skill', skillId)).toBeNull();
    });

    // The host never removed the member's working-tree file or symlinks.
    expect(existsSync(skillFilePath(name))).toBe(true);
  });

  test('local delete: the record and its active claim are removed, but the published file stays (human git action removes it)', async () => {
    const name = 'local-delete';
    const skillId = await seedClaimedSkill(name);

    await withDatabase(db, async () => {
      const records = findTool(createSkillTools(deps(false)), 'vault_skill_records');
      const result = await callTool(records, { action: 'delete', id: skillId });
      expect(result.deleted).toBe(true);
      expect(getSkillRecordByName(name, GLOBAL_SCOPE)).toBeNull();
      expect(getActiveContentClaim('skill', skillId)).toBeNull();
    });

    // DB-only delete everywhere: the working tree is the user's; the retirement
    // notification tells them the file remains.
    expect(existsSync(skillFilePath(name))).toBe(true);
  });
});
