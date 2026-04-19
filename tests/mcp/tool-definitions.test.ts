/**
 * Anti-drift tests for `tool-definitions.ts`.
 *
 * These guard against the class of bugs where:
 *   - a tool is registered in `TOOL_DEFINITIONS` but never dispatched in `server.ts`
 *   - a tool is dispatched in `server.ts` but never declared in `TOOL_DEFINITIONS`
 *   - a schema property exists but the handler doesn't forward it
 *   - core and collective tool name sets overlap
 *
 * Real-world bug this catches (2026-04-15 regression sweep):
 *   `myco_plans` declared an `id` schema property. The handler silently dropped it,
 *   so single-plan lookup appeared to work but always returned the full list.
 *   Anti-drift tests like `forwardsAllDocumentedQueryParams` would have caught it.
 */

import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TOOL_DEFINITIONS,
  COLLECTIVE_TOOL_DEFINITIONS,
} from '@myco/mcp/tool-definitions.js';
import { RETRIEVAL_GUIDANCE } from '@myco/context/cortex-brief.js';
import { handleMycoPlans } from '@myco/mcp/tools/plans.js';
import { handleMycoRemember } from '@myco/mcp/tools/remember.js';
import { handleMycoSavePlan } from '@myco/mcp/tools/save-plan.js';
import { handleMycoSupersede } from '@myco/mcp/tools/supersede.js';
import { handleMycoConsolidate } from '@myco/mcp/tools/consolidate.js';
import { handleMycoSearch } from '@myco/mcp/tools/search.js';
import { handleMycoSessions } from '@myco/mcp/tools/sessions.js';
import { handleMycoGraph } from '@myco/mcp/tools/graph.js';
import {
  handleCollectiveSearch,
  handleCollectiveProject,
} from '@myco/mcp/tools/collective.js';
import { DaemonClient } from '@myco/hooks/client.js';

function mockClient(data: unknown = {}, ok = true): DaemonClient {
  return {
    get: vi.fn().mockResolvedValue({ ok, data }),
    post: vi.fn().mockResolvedValue({ ok, data }),
    put: vi.fn().mockResolvedValue({ ok, data }),
  } as unknown as DaemonClient;
}

// Read server.ts once so we can assert every tool name appears in a dispatch case.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_TS = fs.readFileSync(
  path.resolve(__dirname, '../../packages/myco/src/mcp/server.ts'),
  'utf-8',
);

describe('TOOL_DEFINITIONS registration coverage', () => {
  it('every core tool name appears in server.ts dispatch', () => {
    for (const tool of TOOL_DEFINITIONS) {
      expect(SERVER_TS, `Tool ${tool.name} missing from server dispatch`).toContain(`case TOOL_`);
      // Name appears as a string either via the TOOL_ constant or as literal in the file.
      const literal = tool.name;
      expect(SERVER_TS).toMatch(new RegExp(`TOOL_${literal.toUpperCase().replace(/^MYCO_/, '').replace(/^COLLECTIVE_/, 'COLLECTIVE_')}|['"]${literal}['"]`));
    }
  });

  it('every collective tool name appears in server.ts dispatch', () => {
    for (const tool of COLLECTIVE_TOOL_DEFINITIONS) {
      const literal = tool.name;
      expect(SERVER_TS).toMatch(new RegExp(`TOOL_COLLECTIVE_[A-Z_]+|['"]${literal}['"]`));
    }
  });

  it('core and collective name sets do not overlap', () => {
    const core = new Set(TOOL_DEFINITIONS.map((t) => t.name));
    const collective = new Set(COLLECTIVE_TOOL_DEFINITIONS.map((t) => t.name));
    for (const name of collective) {
      expect(core.has(name), `Tool ${name} is both core and collective`).toBe(false);
    }
  });

  it('every tool has an object-shaped inputSchema with a properties map', () => {
    for (const tool of [...TOOL_DEFINITIONS, ...COLLECTIVE_TOOL_DEFINITIONS]) {
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.inputSchema.properties).toBeDefined();
    }
  });

  it('every Cortex-guided tool appears in generated retrieval guidance', () => {
    const cortexToolNames = [...TOOL_DEFINITIONS, ...COLLECTIVE_TOOL_DEFINITIONS]
      .filter((tool) => Boolean(tool.cortex))
      .map((tool) => tool.name)
      .sort();
    const retrievalGuidanceNames = RETRIEVAL_GUIDANCE.map((entry) => entry.tool).sort();

    expect(retrievalGuidanceNames).toEqual(cortexToolNames);
  });

  it('keeps non-guided tools out of Cortex retrieval guidance', () => {
    const skillsTool = TOOL_DEFINITIONS.find((tool) => tool.name === 'myco_skills');
    const skillCandidatesTool = TOOL_DEFINITIONS.find((tool) => tool.name === 'myco_skill_candidates');

    expect(skillsTool?.cortex).toBeUndefined();
    expect(skillCandidatesTool?.cortex).toBeUndefined();
    expect(RETRIEVAL_GUIDANCE.some((entry) => entry.tool === 'myco_skills')).toBe(false);
    expect(RETRIEVAL_GUIDANCE.some((entry) => entry.tool === 'myco_skill_candidates')).toBe(false);
  });

  // OpenAI's strict tool schema validator rejects schemas that carry
  // oneOf/anyOf/allOf/enum/not at the top level. Anthropic's API rejects
  // the same shapes. The xor between source_path and plan_key is enforced
  // by the daemon handler (zod refine in mcp-proxy.ts), so no top-level
  // combinator is needed — and adding one crashes provider clients such
  // as opencode + GPT-5.
  it('no tool schema has oneOf/anyOf/allOf/not at the top level', () => {
    const forbidden = ['oneOf', 'anyOf', 'allOf', 'not'] as const;
    for (const tool of [...TOOL_DEFINITIONS, ...COLLECTIVE_TOOL_DEFINITIONS]) {
      for (const key of forbidden) {
        expect(
          (tool.inputSchema as Record<string, unknown>)[key],
          `Tool ${tool.name} has forbidden top-level schema key '${key}'`,
        ).toBeUndefined();
      }
    }
  });

  it('every tool name starts with myco_ or collective_', () => {
    for (const tool of [...TOOL_DEFINITIONS, ...COLLECTIVE_TOOL_DEFINITIONS]) {
      expect(tool.name).toMatch(/^(myco_|collective_)/);
    }
  });

  // Bundle D harness-properties discipline: every Bundle D tool (and any tool
  // that carries annotations) must set all four MCP annotation fields so
  // clients can render the correct confirmation UI. Missing any one of these
  // is a regression. Bundle G extended the list with five new tools; they
  // share the same discipline.
  it('Bundle D + G tools declare full MCP annotations', () => {
    const required = [
      'myco_cortex', 'myco_plans', 'myco_runs',
      'myco_evaluations', 'myco_write_intents', 'myco_phase_audit',
      'myco_resume_run', 'myco_digest_revisions',
    ];
    for (const name of required) {
      const tool = TOOL_DEFINITIONS.find((t) => t.name === name);
      expect(tool, `Tool ${name} missing from TOOL_DEFINITIONS`).toBeDefined();
      expect(tool!.annotations, `Tool ${name} missing annotations`).toBeDefined();
      expect(typeof tool!.annotations!.readOnlyHint).toBe('boolean');
      expect(typeof tool!.annotations!.destructiveHint).toBe('boolean');
      expect(typeof tool!.annotations!.idempotentHint).toBe('boolean');
      expect(typeof tool!.annotations!.openWorldHint).toBe('boolean');
    }
  });

  // Pin every annotation VALUE for every Bundle D tool. The shape-only check
  // above would pass even if someone silently flipped an annotation (e.g.
  // set destructiveHint: false on myco_plans, suppressing the confirmation
  // UI). These assertions freeze the intended semantics.
  it('myco_cortex annotations are pinned (mixed read/mutating ops — conservative)', () => {
    const cortex = TOOL_DEFINITIONS.find((t) => t.name === 'myco_cortex');
    // Conservative single set covering all ops: refresh/build_prompt kick off
    // background runs, so readOnlyHint must stay false. None of the ops
    // destroy data, so destructiveHint is false. The set is not idempotent
    // because repeated build_prompt calls produce distinct runs. Everything
    // is local-only, so openWorldHint is false.
    expect(cortex?.annotations?.readOnlyHint).toBe(false);
    expect(cortex?.annotations?.destructiveHint).toBe(false);
    expect(cortex?.annotations?.idempotentHint).toBe(false);
    expect(cortex?.annotations?.openWorldHint).toBe(false);
  });

  it('myco_runs annotations are pinned (fully read-only, idempotent, local)', () => {
    const runs = TOOL_DEFINITIONS.find((t) => t.name === 'myco_runs');
    expect(runs?.annotations?.readOnlyHint).toBe(true);
    expect(runs?.annotations?.destructiveHint).toBe(false);
    expect(runs?.annotations?.idempotentHint).toBe(true);
    expect(runs?.annotations?.openWorldHint).toBe(false);
  });

  it('myco_plans annotations are pinned (destructive via op: "delete", idempotent, local)', () => {
    const plans = TOOL_DEFINITIONS.find((t) => t.name === 'myco_plans');
    // op: "delete" mutates and removes data, so readOnlyHint must be false
    // and destructiveHint true. Deleting an already-deleted plan is a no-op
    // (returns 404), so idempotentHint is true. Tombstones for remote
    // deletes are still local-only state, so openWorldHint is false.
    expect(plans?.annotations?.readOnlyHint).toBe(false);
    expect(plans?.annotations?.destructiveHint).toBe(true);
    expect(plans?.annotations?.idempotentHint).toBe(true);
    expect(plans?.annotations?.openWorldHint).toBe(false);
  });

  // Bundle G tools — 5 new MCP surfaces. Each annotation set is pinned
  // so a silent flip (e.g. someone marking op: "create" as read-only)
  // would fail the suite.
  it('myco_evaluations annotations are pinned (mixed ops — conservative)', () => {
    const tool = TOOL_DEFINITIONS.find((t) => t.name === 'myco_evaluations');
    // list/get are read-only, create starts background runs — mark
    // conservatively so clients confirm before auto-running create.
    expect(tool?.annotations?.readOnlyHint).toBe(false);
    expect(tool?.annotations?.destructiveHint).toBe(false);
    expect(tool?.annotations?.idempotentHint).toBe(false);
    expect(tool?.annotations?.openWorldHint).toBe(false);
  });

  it('myco_write_intents annotations are pinned (read-only, idempotent, local)', () => {
    const tool = TOOL_DEFINITIONS.find((t) => t.name === 'myco_write_intents');
    expect(tool?.annotations?.readOnlyHint).toBe(true);
    expect(tool?.annotations?.destructiveHint).toBe(false);
    expect(tool?.annotations?.idempotentHint).toBe(true);
    expect(tool?.annotations?.openWorldHint).toBe(false);
  });

  it('myco_phase_audit annotations are pinned (read-only, idempotent, local)', () => {
    const tool = TOOL_DEFINITIONS.find((t) => t.name === 'myco_phase_audit');
    expect(tool?.annotations?.readOnlyHint).toBe(true);
    expect(tool?.annotations?.destructiveHint).toBe(false);
    expect(tool?.annotations?.idempotentHint).toBe(true);
    expect(tool?.annotations?.openWorldHint).toBe(false);
  });

  it('myco_resume_run annotations are pinned (mutating, non-idempotent, local)', () => {
    const tool = TOOL_DEFINITIONS.find((t) => t.name === 'myco_resume_run');
    // Starts a new background phase; not destructive (no data removed)
    // but also not read-only. Each call starts a fresh phase if the run
    // is still resumable, so idempotentHint is false.
    expect(tool?.annotations?.readOnlyHint).toBe(false);
    expect(tool?.annotations?.destructiveHint).toBe(false);
    expect(tool?.annotations?.idempotentHint).toBe(false);
    expect(tool?.annotations?.openWorldHint).toBe(false);
  });

  it('myco_digest_revisions annotations are pinned (read-only, idempotent, local)', () => {
    const tool = TOOL_DEFINITIONS.find((t) => t.name === 'myco_digest_revisions');
    // List-only MCP surface — restore stays UI-only per policy.
    expect(tool?.annotations?.readOnlyHint).toBe(true);
    expect(tool?.annotations?.destructiveHint).toBe(false);
    expect(tool?.annotations?.idempotentHint).toBe(true);
    expect(tool?.annotations?.openWorldHint).toBe(false);
  });
});

/**
 * For each tool whose schema advertises query or body parameters, assert the
 * handler actually forwards them to the daemon. These tests exist specifically
 * to catch silent schema-vs-handler drift.
 */
describe('handler forwards every documented schema property', () => {
  it('myco_plans forwards id, status, and limit', async () => {
    const client = mockClient({ plans: [] });
    await handleMycoPlans({ id: 'p1', status: 'active', limit: 7 }, client);
    const url = (client.get as unknown as { mock: { calls: string[][] } }).mock.calls[0][0];
    expect(url).toContain('id=p1');
    expect(url).toContain('status=active');
    expect(url).toContain('limit=7');
  });

  it('myco_sessions forwards all documented filters', async () => {
    const client = mockClient({ sessions: [] });
    await handleMycoSessions({ plan: 'x', branch: 'main', user: 'alice', since: '2024-01-01', limit: 9 }, client);
    const url = (client.get as unknown as { mock: { calls: string[][] } }).mock.calls[0][0];
    expect(url).toContain('plan=x');
    expect(url).toContain('branch=main');
    expect(url).toContain('user=alice');
    expect(url).toContain('since=2024-01-01');
    expect(url).toContain('limit=9');
  });

  it('myco_search forwards query, type, limit', async () => {
    const client = mockClient({ results: [] });
    await handleMycoSearch({ query: 'auth', type: 'spore', limit: 4 }, client);
    const url = (client.get as unknown as { mock: { calls: string[][] } }).mock.calls[0][0];
    expect(url).toContain('q=auth');
    expect(url).toContain('type=spore');
    expect(url).toContain('limit=4');
  });

  it('myco_graph forwards note_id via path segment and direction/depth as query', async () => {
    const client = mockClient({ edges: [], entities: [] });
    await handleMycoGraph({ note_id: 'n1', direction: 'incoming', depth: 2 }, client);
    const url = (client.get as unknown as { mock: { calls: string[][] } }).mock.calls[0][0];
    // note_id appears as a path segment (not a query param) by design
    expect(url).toContain('/api/graph/n1');
    expect(url).toContain('direction=incoming');
    expect(url).toContain('depth=2');
  });

  it('myco_remember forwards content, type, tags via POST body', async () => {
    const client = mockClient({ id: 'g-1', observation_type: 'gotcha', status: 'active', created_at: 1 });
    await handleMycoRemember({ content: 'x', type: 'gotcha', tags: ['t1', 't2'] }, client);
    expect(client.post).toHaveBeenCalledWith('/api/mcp/remember', {
      content: 'x',
      type: 'gotcha',
      tags: ['t1', 't2'],
    });
  });

  it('myco_save_plan forwards session_id, content, source_path/plan_key, title, status, tags via POST body', async () => {
    const client = mockClient({
      id: 'plan-1',
      logical_key: 'session:s1:key:primary',
      title: 'Plan',
      status: 'active',
      source_path: null,
      session_id: 's1',
      prompt_batch_id: 3,
      tags: ['planning'],
      created_at: 1,
      updated_at: 1,
    });
    await handleMycoSavePlan({
      session_id: 's1',
      content: '# Plan',
      plan_key: 'primary',
      title: 'Plan',
      status: 'active',
      tags: ['planning'],
    }, client);
    expect(client.post).toHaveBeenCalledWith('/api/mcp/plans', {
      session_id: 's1',
      content: '# Plan',
      source_path: undefined,
      plan_key: 'primary',
      title: 'Plan',
      status: 'active',
      tags: ['planning'],
    });
  });

  it('myco_supersede forwards old_spore_id, new_spore_id, reason via POST body', async () => {
    const client = mockClient({ old_spore: 'a', new_spore: 'b', status: 'superseded' });
    await handleMycoSupersede({ old_spore_id: 'a', new_spore_id: 'b', reason: 'because' }, client);
    expect(client.post).toHaveBeenCalledWith('/api/mcp/supersede', {
      old_spore_id: 'a',
      new_spore_id: 'b',
      reason: 'because',
    });
  });

  it('myco_consolidate forwards source_spore_ids, consolidated_content, observation_type, tags, reason', async () => {
    const client = mockClient({
      new_spore_id: 'w-1',
      sources_superseded: ['a', 'b'],
      status: 'consolidated',
      created_at: 1,
    });
    await handleMycoConsolidate({
      source_spore_ids: ['a', 'b'],
      consolidated_content: 'merged',
      observation_type: 'gotcha',
      tags: ['t1'],
      reason: 'merge',
    }, client);
    expect(client.post).toHaveBeenCalledWith('/api/mcp/consolidate', {
      source_spore_ids: ['a', 'b'],
      consolidated_content: 'merged',
      observation_type: 'gotcha',
      tags: ['t1'],
      reason: 'merge',
    });
  });

  it('collective_search forwards query, project, limit, and semantic filters', async () => {
    const client = mockClient({ results: [] });
    await handleCollectiveSearch({
      query: 'q',
      project: 'p',
      limit: 2,
      types: ['spores'],
      status: 'active',
      observation_type: 'decision',
      since: 10,
      until: 20,
    }, client);
    const url = (client.get as unknown as { mock: { calls: string[][] } }).mock.calls[0][0];
    expect(url).toContain('q=q');
    expect(url).toContain('project=p');
    expect(url).toContain('limit=2');
    expect(url).toContain('types=spores');
    expect(url).toContain('status=active');
    expect(url).toContain('observation_type=decision');
    expect(url).toContain('since=10');
    expect(url).toContain('until=20');
  });

  it('collective_project forwards project and include_digest', async () => {
    const client = mockClient({ project: null });
    await handleCollectiveProject({ project: 'p', include_digest: true }, client);
    const url = (client.get as unknown as { mock: { calls: string[][] } }).mock.calls[0][0];
    expect(url).toContain('project=p');
    expect(url).toContain('include_digest=true');
  });
});
