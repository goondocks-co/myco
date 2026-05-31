import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db.js';
import { getDatabase } from '@myco/db/client.js';
import { registerAgent } from '@myco/db/queries/agents.js';
import { insertSkillRecord } from '@myco/db/queries/skill-records.js';
import { setTeamSyncEnabled } from '@myco/db/queries/team-sync-state.js';
import { initTeamContext, resetTeamContext } from '@myco/daemon/team-context.js';
import { handleDeleteSkillRecord, createSkillRecordDeleteHandler, isSafeSkillNameForFs } from '@myco/daemon/api/skills.js';
import type { MycoRequestContext } from '@myco/tools/request-context.js';
import type { GroveProjectId } from '@myco/grove/ids.js';

const PROJECT_ID = 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as GroveProjectId;

const REQUEST_CONTEXT: MycoRequestContext = {
  projectRoot: '/workspace/project-a',
  projectId: PROJECT_ID,
  groveId: 'grove-a',
  machineId: 'machine-a',
  sessionId: null,
  projectVaultDir: '/workspace/project-a/.myco',
  databasePath: '/tmp/grove-a/myco.db',
  source: 'headers',
};

describe('skill record API deletion', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => {
    cleanTestDb();
    registerAgent({ id: 'agent-test', name: 'Agent Test', created_at: 10 });
  });
  afterEach(() => { resetTeamContext(); });

  it('journals a delete tombstone via the skill_records_team_ad trigger when enabled', async () => {
    insertSkillRecord({
      id: 'skill-scoped',
      project_id: PROJECT_ID,
      agent_id: 'agent-test',
      name: 'scoped-skill',
      display_name: 'Scoped Skill',
      description: 'Project-scoped skill',
      path: '.agents/skills/scoped-skill/SKILL.md',
      created_at: 10,
      updated_at: 10,
    });
    initTeamContext('machine-a');
    // The delete tombstone is now journaled by the skill_records_team_ad
    // trigger, which gates on this Grove's per-Grove team_sync_state flag.
    setTeamSyncEnabled(true);

    const response = await handleDeleteSkillRecord({
      params: { id: 'skill-scoped' },
      requestContext: REQUEST_CONTEXT,
    } as never);

    expect(response.status ?? 200).toBe(200);
    const row = getDatabase().prepare(
      "SELECT payload FROM team_outbox WHERE table_name = 'skill_records' AND row_id = ? AND operation = 'delete'",
    ).get('skill-scoped') as { payload: string };
    // The trigger payload carries id + machine_id (no project_id/name — D1
    // only needs the row id to apply the delete).
    expect(JSON.parse(row.payload)).toMatchObject({ id: 'skill-scoped' });
  });

  it('does not journal a delete tombstone when the Grove flag is disabled', async () => {
    insertSkillRecord({
      id: 'skill-disabled',
      project_id: PROJECT_ID,
      agent_id: 'agent-test',
      name: 'disabled-skill',
      display_name: 'Disabled Skill',
      description: 'Project-scoped skill',
      path: '.agents/skills/disabled-skill/SKILL.md',
      created_at: 10,
      updated_at: 10,
    });
    initTeamContext('machine-a');
    setTeamSyncEnabled(false);

    const response = await handleDeleteSkillRecord({
      params: { id: 'skill-disabled' },
      requestContext: REQUEST_CONTEXT,
    } as never);

    expect(response.status ?? 200).toBe(200);
    const n = getDatabase().prepare(
      "SELECT COUNT(*) AS n FROM team_outbox WHERE table_name = 'skill_records' AND row_id = ?",
    ).get('skill-disabled') as { n: number };
    expect(n.n).toBe(0);
  });
});

describe('isSafeSkillNameForFs (H.2 path-traversal gate)', () => {
  it('accepts slug-shaped names', () => {
    expect(isSafeSkillNameForFs('my-skill')).toBe(true);
    expect(isSafeSkillNameForFs('skill1')).toBe(true);
    expect(isSafeSkillNameForFs('a')).toBe(true);
    expect(isSafeSkillNameForFs('123-abc')).toBe(true);
  });

  it('rejects traversal, separators, uppercase, leading hyphen, and absolute paths', () => {
    // The function gates `fs.rmSync({ recursive: true, force: true })`.
    // Every shape below would otherwise resolve outside `.agents/skills/`
    // (or shadow a different file via shell-special chars).
    expect(isSafeSkillNameForFs('../etc')).toBe(false);
    expect(isSafeSkillNameForFs('..')).toBe(false);
    expect(isSafeSkillNameForFs('foo/bar')).toBe(false);
    expect(isSafeSkillNameForFs('foo\\bar')).toBe(false);
    expect(isSafeSkillNameForFs('-leading-hyphen')).toBe(false);
    expect(isSafeSkillNameForFs('UPPER')).toBe(false);
    expect(isSafeSkillNameForFs('with space')).toBe(false);
    expect(isSafeSkillNameForFs('')).toBe(false);
    expect(isSafeSkillNameForFs('/absolute')).toBe(false);
    // Length cap (101 chars).
    expect(isSafeSkillNameForFs('a'.repeat(101))).toBe(false);
    expect(isSafeSkillNameForFs('a'.repeat(100))).toBe(true);
  });
});

describe('createSkillRecordDeleteHandler — path-traversal containment (H.2)', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => {
    cleanTestDb();
    registerAgent({ id: 'agent-test', name: 'Agent Test', created_at: 10 });
  });
  afterEach(() => { resetTeamContext(); });

  it('refuses to fs.rmSync a skill whose name fails the charset gate', async () => {
    // The DB allows arbitrary `name` text (no CHECK constraint), and
    // team-sync replays peer rows into local DB. A peer-supplied name
    // `../../etc` reaching `fs.rmSync({ recursive: true, force: true })`
    // is a destructive primitive gated on attacker input — the cleanup
    // handler must refuse it without touching disk.
    const projectRoot = mkdtempSync(join(tmpdir(), 'myco-skill-traverse-'));
    const vaultDir = join(projectRoot, '.myco');
    mkdirSync(vaultDir, { recursive: true });
    // Plant the "target" the attacker hopes to delete OUTSIDE skills root.
    const sentinel = join(projectRoot, 'should-not-be-deleted.txt');
    writeFileSync(sentinel, 'preserve me', 'utf-8');

    insertSkillRecord({
      id: 'skill-evil',
      project_id: PROJECT_ID,
      agent_id: 'agent-test',
      name: '../should-not-be-deleted.txt' as never, // bypasses our type narrow, mirrors what a hostile peer payload could land in the DB
      display_name: 'Evil',
      description: 'Traversal attempt',
      path: '.agents/skills/evil/SKILL.md',
      created_at: 10,
      updated_at: 10,
    });

    const logs: string[] = [];
    const fakeLogger = {
      info: () => {},
      warn: (_kind: string, msg: string) => { logs.push(msg); },
      error: () => {},
      debug: () => {},
    };
    const handler = createSkillRecordDeleteHandler({ vaultDir, logger: fakeLogger as never });
    await handler({
      params: { id: 'skill-evil' },
      requestContext: { ...REQUEST_CONTEXT, projectRoot, projectVaultDir: vaultDir },
    } as never);

    // Sentinel survives — handler refused to walk the traversed path.
    expect(existsSync(sentinel)).toBe(true);
    // And we logged a refusal so an operator can grep for the rejection.
    expect(logs.some((m) => m.startsWith('Refused skill cleanup'))).toBe(true);
  });
});
