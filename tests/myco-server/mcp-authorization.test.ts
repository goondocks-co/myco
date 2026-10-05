import { describe, expect, it } from 'bun:test';
import { ensureMember } from '@myco-server-worker/auth/enrollment.js';
import { issueExternalGrant } from '@myco-server-worker/auth/grants.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { HARNESS_MEMBER_ID } from '@myco-server-worker/constants.js';
import { getRun, recordDispatch } from '@myco-server-worker/core/runs.js';
import { TOOL_DEFINITIONS, type ToolDefinition } from '@myco-server-worker/mcp/definitions.js';
import { RUN_DEFINITIONS } from '@myco-server-worker/mcp/run-definitions.js';
import { NO_OP, TOOL_REGISTRY, type RegistryEntry } from '@myco-server-worker/mcp/registry.js';
import { RUN_TOOL_REGISTRY } from '@myco-server-worker/mcp/run-surface.js';
import { authorizedDefinitionsFor, callTool } from '@myco-server-worker/mcp/server.js';
import { grantToolContext, runToolContext, type ToolContext } from '@myco-server-worker/mcp/context.js';
import { authorizeTool } from '@myco-server-worker/auth/mcp-authorization.js';
import { sqliteEnv } from './helpers/fixtures.js';

async function setup() {
  const e = sqliteEnv();
  const now = Date.now();
  const credential = await issueMemberToken(e.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, now);
  const ctx: ToolContext = {
    env: e.serverEnv, projectId: 'proj_1', now,
    principal: { kind: 'member', memberId: 'mem_machine_1', machineId: 'machine_1', tokenId: credential.tokenId },
  };
  return { ...e, ctx, now, credential };
}

describe('MCP authorization declarations', () => {
  it('covers exactly each served and run-only operation enum, including intentionally unserved operations', () => {
    const check = (definitions: readonly ToolDefinition[], registry: Readonly<Record<string, { ops: Readonly<Record<string, RegistryEntry>> }>>) => {
      expect(Object.keys(registry).sort()).toEqual(definitions.map((definition) => definition.name).sort());
      for (const definition of definitions) {
        const ops = definition.inputSchema.properties.op?.enum?.filter((op): op is string => typeof op === 'string') ?? [NO_OP];
        expect(Object.keys(registry[definition.name].ops).sort()).toEqual([...ops].sort());
        for (const entry of Object.values(registry[definition.name].ops)) {
          expect(entry.authorization.transport).toBe('mcp');
          expect(entry.authorization.subjects.length).toBeGreaterThan(0);
        }
      }
    };
    check(TOOL_DEFINITIONS, TOOL_REGISTRY);
    check(RUN_DEFINITIONS, RUN_TOOL_REGISTRY);
  });

  it('uses each declaration for discovery and dispatch and never invokes a handler with no declaration', async () => {
    const { ctx, sqlite } = await setup();
    const entry = TOOL_REGISTRY.myco_spores.ops.save;
    const declaration = entry.authorization;
    expect((await authorizedDefinitionsFor(ctx)).find((definition) => definition.name === 'myco_spores')?.inputSchema.properties.op?.enum).toContain('save');
    try {
      Reflect.deleteProperty(entry, 'authorization');
      expect((await authorizedDefinitionsFor(ctx)).find((definition) => definition.name === 'myco_spores')?.inputSchema.properties.op?.enum).not.toContain('save');
      await expect(callTool(ctx, 'myco_spores', { op: 'save', project: 'proj_1', type: 'gotcha', content: 'must not write' }))
        .rejects.toMatchObject({ code: 'unknown_tool', message: 'Unknown tool: myco_spores' });
    } finally { entry.authorization = declaration; }
    expect(sqlite.query('SELECT COUNT(*) AS count FROM spores').get()).toEqual({ count: 0 });
    const forbidden = { ...declaration, action: 'admin' as const };
    try {
      entry.authorization = forbidden;
      expect((await authorizedDefinitionsFor(ctx)).find((definition) => definition.name === 'myco_spores')?.inputSchema.properties.op?.enum).not.toContain('save');
      await expect(callTool(ctx, 'myco_spores', { op: 'save', project: 'proj_1', type: 'gotcha', content: 'must not write' })).rejects.toMatchObject({ code: 'unknown_tool' });
    } finally { entry.authorization = declaration; }
    expect(sqlite.query('SELECT COUNT(*) AS count FROM spores').get()).toEqual({ count: 0 });
  });

  it('preserves not_served refusals but advertises only operations the declaration authorizes', async () => {
    const { ctx } = await setup();
    const definitions = await authorizedDefinitionsFor(ctx);
    expect(definitions.find((definition) => definition.name === 'myco_plans')?.inputSchema.properties.op?.enum).toEqual(['list', 'get', 'save']);
    expect(definitions.find((definition) => definition.name === 'myco_cortex')?.inputSchema.properties.op?.enum).toEqual(['instructions', 'canopy_map', 'projects_activity']);
    await expect(callTool(ctx, 'myco_plans', { op: 'delete', id: 'nope' })).rejects.toMatchObject({ code: 'not_served' });
  });

  it('preserves grant write semantics and denies ordinary member and grant access to run-only controls', async () => {
    const { ctx, db, now } = await setup();
    const grant = await issueExternalGrant(db, { projectId: 'proj_1' }, 'review', 'mem_machine_1', now);
    const scoped = grantToolContext(ctx.env, { projectId: 'proj_1', grantId: grant.id, body: '', now });
    const definitions = await authorizedDefinitionsFor(scoped);
    expect(definitions.find((definition) => definition.name === 'myco_spores')?.inputSchema.properties.op?.enum).toEqual(['list', 'get', 'save', 'supersede']);
    expect(definitions.find((definition) => definition.name === 'myco_plans')?.inputSchema.properties.op?.enum).toEqual(['list', 'get']);
    for (const principal of [ctx, scoped]) {
      await expect(callTool(principal, 'myco_run', { op: 'report' })).rejects.toMatchObject({ code: 'unknown_tool' });
      expect((await authorizedDefinitionsFor(principal)).some((definition) => definition.name.startsWith('myco_run'))).toBe(false);
    }
  });

  it('resolves exact run credential, Project and current attempt before any run operation', async () => {
    const { ctx, db, sqlite, now } = await setup();
    await ensureMember(db, HARNESS_MEMBER_ID, now, 'member', 'harness runtime');
    const token = await issueMemberToken(db, { memberId: HARNESS_MEMBER_ID, machineId: 'harness' }, now);
    sqlite.run(`INSERT INTO agents (id, name, source, enabled, created_at) VALUES ('authorization-agent', 'Authorization', 'built-in', 1, ?)`, [now]);
    await recordDispatch(db, { projectId: 'proj_1' }, { id: 'authorization-run', agentId: 'authorization-agent', task: 'title-summary', provider: null, model: null, runContext: null, dispatchedBy: token.tokenId, startedAt: now });
    sqlite.run(`UPDATE agent_runs SET status = 'running' WHERE id = 'authorization-run'`);
    const row = await getRun(db, { projectId: 'proj_1' }, 'authorization-run');
    if (row === null) throw new Error('run fixture missing');
    const run = runToolContext(ctx.env, { projectId: 'proj_1', run: { ...row, projectId: 'proj_1' }, tokenId: token.tokenId, body: '', now });
    const declaration = RUN_TOOL_REGISTRY.myco_run.ops.report.authorization;
    expect(await authorizeTool(run, declaration, {})).toBe(true);
    if (run.principal.kind !== 'run') throw new Error('run principal missing');
    for (const principal of [
      { ...run.principal, runId: 'other-run' },
      { ...run.principal, tokenId: ctx.principal.kind === 'member' ? ctx.principal.tokenId : '' },
      { ...run.principal, attempt: now + 1 },
      { ...run.principal, attempt: undefined },
    ]) expect(await authorizeTool({ ...run, principal }, declaration, {})).toBe(false);
    expect(await authorizeTool({ ...run, projectId: 'proj_2' }, declaration, {})).toBe(false);
    sqlite.run(`UPDATE agent_runs SET resumed_at = ? WHERE id = 'authorization-run'`, [now + 1]);
    expect(await authorizeTool(run, declaration, {})).toBe(false);
    let admitted = false;
    await expect(callTool(run, 'myco_run', { op: 'report' }, () => { admitted = true; })).rejects.toMatchObject({ code: 'unknown_tool' });
    expect(admitted).toBe(false);
  });

  it('refuses a revoked identity during discovery and dispatch', async () => {
    const { ctx, sqlite, credential } = await setup();
    sqlite.run('UPDATE member_credentials SET revoked_at = ? WHERE id = ?', [ctx.now, credential.tokenId]);
    await expect(authorizedDefinitionsFor(ctx)).rejects.toMatchObject({ code: 'unknown_tool' });
    await expect(callTool(ctx, 'myco_spores', { op: 'list' })).rejects.toMatchObject({ code: 'unknown_tool' });
  });
});
