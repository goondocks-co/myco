import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db.js';
import { getDatabase } from '@myco/db/client.js';
import { registerAgent } from '@myco/db/queries/agents.js';
import { insertSkillRecord } from '@myco/db/queries/skill-records.js';
import { setTeamSyncEnabled } from '@myco/db/queries/team-sync-state.js';
import { initTeamContext, resetTeamContext } from '@myco/team/context.js';
import { handleDeleteSkillRecord, createSkillRecordDeleteHandler, isSafeSkillNameForFs } from '@myco/daemon/api/skills.js';
import { tenantRoute } from '@myco/daemon/api/route-helpers.js';
import type { RequestPrincipal } from '@myco/daemon/request-principal.js';
import { resolveLegacyRequestContext, type MycoRequestContext } from '@myco/grove/request-context.js';
import { assertGroveProjectId, type GroveProjectId } from '@myco/grove/ids.js';

const PROJECT_ID = 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as GroveProjectId;

const REQUEST_CONTEXT: MycoRequestContext = {
  projectRoot: '/workspace/project-a',
  callerRoot: null,
  projectId: PROJECT_ID,
  groveId: 'grove-a',
  machineId: 'machine-a',
  sessionId: null,
  projectVaultDir: '/workspace/project-a/.myco',
  databasePath: '/tmp/grove-a/myco.db',
  source: 'headers',
  tenancySource: 'caller',
};

/**
 * Build a caller-sourced (authorized) request context for a tenant project.
 * `tenancySource: 'caller'` is the only provenance `tenantRoute` accepts; it
 * is what survives the context-switch auth gate. The fs cascade resolves the
 * project root from THIS context (not a baked-in anchor), so each test pins a
 * distinct `projectVaultDir`/`projectRoot` per tenant.
 */
function callerContext(opts: {
  vaultDir: string;
  projectId: string;
  groveId: string;
}): MycoRequestContext {
  return resolveLegacyRequestContext(opts.vaultDir, {
    projectId: assertGroveProjectId(opts.projectId),
    groveId: opts.groveId,
    machineId: 'machine-a',
    tenancySource: 'caller',
  });
}

/** Derive the principal a `tenantRoute` would hand the delete handler. */
function principalFor(ctx: MycoRequestContext): RequestPrincipal {
  return {
    identity: { machineId: ctx.machineId, userId: null },
    tenancy: {
      projectVaultDir: ctx.projectVaultDir as RequestPrincipal['tenancy']['projectVaultDir'],
      projectId: ctx.projectId,
      groveId: ctx.groveId ?? '',
      requestContext: {
        projectVaultDir: ctx.projectVaultDir,
        projectId: ctx.projectId,
        groveId: ctx.groveId ?? '',
      },
    },
  };
}

/** Minimal logger that records `warn` messages for assertions. */
function recordingLogger(logs: string[]) {
  return {
    info: () => {},
    warn: (_kind: string, msg: string) => { logs.push(msg); },
    error: () => {},
    debug: () => {},
  } as never;
}

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

    const response = await handleDeleteSkillRecord(
      { params: { id: 'skill-scoped' }, requestContext: REQUEST_CONTEXT } as never,
      principalFor(REQUEST_CONTEXT),
    );

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

    const response = await handleDeleteSkillRecord(
      { params: { id: 'skill-disabled' }, requestContext: REQUEST_CONTEXT } as never,
      principalFor(REQUEST_CONTEXT),
    );

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
    const handler = createSkillRecordDeleteHandler({ logger: recordingLogger(logs) });
    const ctx = callerContext({ vaultDir, projectId: PROJECT_ID, groveId: 'grove-a' });
    await handler(
      { params: { id: 'skill-evil' }, requestContext: ctx } as never,
      principalFor(ctx),
    );

    // Sentinel survives — handler refused to walk the traversed path.
    expect(existsSync(sentinel)).toBe(true);
    // And we logged a refusal so an operator can grep for the rejection.
    expect(logs.some((m) => m.startsWith('Refused skill cleanup'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tenant-scoped fs cascade: deleting a skill record must remove the REQUEST
// project's `.agents/skills/<name>` directory — never the daemon's bootstrap
// anchor project. The bug: the handler baked in the anchor `vaultDir`, so a
// delete from project B walked project A's (the anchor's) skill files.
// ---------------------------------------------------------------------------

describe('createSkillRecordDeleteHandler — fs cascade is scoped to the request project, not the anchor', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => {
    cleanTestDb();
    registerAgent({ id: 'agent-test', name: 'Agent Test', created_at: 10 });
  });
  afterEach(() => { resetTeamContext(); });

  // Distinct on-disk project roots for the anchor (A) and the request tenant (B).
  function makeProject(prefix: string, skillName: string) {
    const projectRoot = mkdtempSync(join(tmpdir(), prefix));
    const vaultDir = join(projectRoot, '.myco');
    mkdirSync(vaultDir, { recursive: true });
    const skillDir = join(projectRoot, '.agents', 'skills', skillName);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '# skill', 'utf-8');
    return { projectRoot, vaultDir, skillDir };
  }

  it('removes project B’s skill dir and leaves the anchor (A) untouched', async () => {
    const SKILL_NAME = 'shared-skill';
    // Anchor project A — what the handler used to (wrongly) target.
    const anchor = makeProject('myco-anchor-A-', SKILL_NAME);
    // Request tenant project B — the project the delete actually came from.
    const tenantB = makeProject('myco-tenant-B-', SKILL_NAME);

    insertSkillRecord({
      id: 'skill-b',
      project_id: PROJECT_ID,
      agent_id: 'agent-test',
      name: SKILL_NAME,
      display_name: 'Shared Skill',
      description: 'Project B skill',
      path: `.agents/skills/${SKILL_NAME}/SKILL.md`,
      created_at: 10,
      updated_at: 10,
    });

    const logs: string[] = [];
    // The factory no longer takes a baked anchor vaultDir; the fs root comes
    // from the request principal/context.
    const handler = createSkillRecordDeleteHandler({ logger: recordingLogger(logs) });
    const ctx = callerContext({ vaultDir: tenantB.vaultDir, projectId: PROJECT_ID, groveId: 'grove-a' });

    const response = await handler(
      { params: { id: 'skill-b' }, requestContext: ctx, pathname: '/api/skill-records/skill-b' } as never,
      principalFor(ctx),
    );

    expect(response.status ?? 200).toBe(200);
    // B's skill dir is gone — the request project's files were cascaded.
    expect(existsSync(tenantB.skillDir)).toBe(false);
    // A's skill dir survives — the anchor project was NOT touched.
    expect(existsSync(anchor.skillDir)).toBe(true);
  });

  it('rejects a synthesized (anchor-fallback) context with 400 + tenancy-violation and never touches disk', async () => {
    const SKILL_NAME = 'guarded-skill';
    const anchor = makeProject('myco-anchor-syn-', SKILL_NAME);
    const tenantB = makeProject('myco-tenant-syn-', SKILL_NAME);

    insertSkillRecord({
      id: 'skill-syn',
      project_id: PROJECT_ID,
      agent_id: 'agent-test',
      name: SKILL_NAME,
      display_name: 'Guarded Skill',
      description: 'Synthesized-context skill',
      path: `.agents/skills/${SKILL_NAME}/SKILL.md`,
      created_at: 10,
      updated_at: 10,
    });

    const warnings: Array<{ kind: string; pathname?: unknown }> = [];
    const logger = {
      info: () => {},
      warn: (kind: string, _msg: string, ctx?: { pathname?: unknown }) => {
        warnings.push({ kind, pathname: ctx?.pathname });
      },
      error: () => {},
      debug: () => {},
    } as never;

    // Synthesized = the daemon's bootstrap-anchor fallback. `tenancySource`
    // omitted -> 'synthesized', which `tenantRoute` must reject before the
    // delete handler (and any fs.rmSync) runs.
    const synthesized = resolveLegacyRequestContext(tenantB.vaultDir, {
      projectId: assertGroveProjectId(PROJECT_ID),
      groveId: 'grove-a',
      machineId: 'machine-a',
      // tenancySource omitted -> 'synthesized'
    });

    const wrapped = tenantRoute(
      { machineId: 'machine-a', logger },
      createSkillRecordDeleteHandler({ logger }),
    );

    const response = await wrapped({
      params: { id: 'skill-syn' },
      requestContext: synthesized,
      pathname: '/api/skill-records/skill-syn',
    } as never);

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: { code: 'tenancy-violation' } });
    expect(warnings.some((w) => w.kind === 'tenancy.violation')).toBe(true);
    // The DB row survives (delete never ran) and NO disk was touched on
    // either the request project or the anchor.
    const stillThere = getDatabase().prepare(
      'SELECT COUNT(*) AS n FROM skill_records WHERE id = ?',
    ).get('skill-syn') as { n: number };
    expect(stillThere.n).toBe(1);
    expect(existsSync(tenantB.skillDir)).toBe(true);
    expect(existsSync(anchor.skillDir)).toBe(true);
  });
});
