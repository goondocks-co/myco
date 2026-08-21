/**
 * Anti-drift tests for `tool-definitions.ts`.
 *
 * These guard against the class of bugs where:
 *   - a tool is registered in `TOOL_DEFINITIONS` but never dispatched in `tools/index.ts`
 *   - a tool is dispatched in `tools/index.ts` but never declared in `TOOL_DEFINITIONS`
 *   - a schema property exists but the handler doesn't forward it
 *
 * Real-world bug this catches (2026-04-15 regression sweep):
 *   `myco_plans` declared an `id` schema property. The handler silently dropped it,
 *   so single-plan lookup appeared to work but always returned the full list.
 *   Anti-drift tests like `forwardsAllDocumentedQueryParams` would have caught it.
 */

import { describe, it, expect } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TOOL_DEFINITIONS,
} from '@myco/tools/definitions.js';
import { RETRIEVAL_GUIDANCE } from '@myco/context/cortex-brief.js';
import { handleMycoSearch } from '@myco/tools/search.js';
import { DaemonClient } from '@myco/daemon/client.js';

function mockClient(data: unknown = {}, ok = true): DaemonClient {
  return {
    get: vi.fn().mockResolvedValue({ ok, data }),
    post: vi.fn().mockResolvedValue({ ok, data }),
    put: vi.fn().mockResolvedValue({ ok, data }),
  } as unknown as DaemonClient;
}

// Read tools/index.ts once so we can assert every tool name appears in dispatch.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOOLS_INDEX_TS = fs.readFileSync(
  path.resolve(__dirname, '../../packages/myco/src/tools/index.ts'),
  'utf-8',
);
const TOOL_DEFINITIONS_TS = fs.readFileSync(
  path.resolve(__dirname, '../../packages/myco/src/tools/definitions.ts'),
  'utf-8',
);

function constantNameForTool(toolName: string): string {
  const escaped = toolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = TOOL_DEFINITIONS_TS.match(new RegExp(`export const (TOOL_[A-Z_]+) = ['"]${escaped}['"]`));
  if (!match) throw new Error(`Missing exported TOOL_ constant for ${toolName}`);
  return match[1];
}

// Each tool is registered either as a HANDLERS Map entry (lazy-loaded
// `[TOOL_X, async () =>`) or, for direct-DB tools like myco_cortex Canopy ops,
// as an explicit `if (name === TOOL_X)` branch in callTool.
function isRegistered(constant: string): boolean {
  return (
    new RegExp(`\\[${constant},\\s`).test(TOOLS_INDEX_TS)
    || TOOLS_INDEX_TS.includes(`name === ${constant}`)
  );
}

describe('TOOL_DEFINITIONS registration coverage', () => {
  it('every core tool is wired into the tools/index.ts dispatcher', () => {
    for (const tool of TOOL_DEFINITIONS) {
      const constant = constantNameForTool(tool.name);
      expect(isRegistered(constant), `Tool ${tool.name} missing from tool dispatch`).toBe(true);
    }
  });

  it('every tool has an object-shaped inputSchema with a properties map', () => {
    for (const tool of TOOL_DEFINITIONS) {
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.inputSchema.properties).toBeDefined();
    }
  });

  it('every Cortex-guided tool appears in generated retrieval guidance', () => {
    const cortexToolNames = TOOL_DEFINITIONS
      .filter((tool) => Boolean(tool.cortex))
      .map((tool) => tool.name)
      .sort();
    const retrievalGuidanceNames = RETRIEVAL_GUIDANCE.map((entry) => entry.tool).sort();

    expect(retrievalGuidanceNames).toEqual(cortexToolNames);
  });

  it('keeps non-guided tools out of Cortex retrieval guidance', () => {
    const skillsTool = TOOL_DEFINITIONS.find((tool) => tool.name === 'myco_skills');

    expect(skillsTool?.cortex).toBeUndefined();
    expect(RETRIEVAL_GUIDANCE.some((entry) => entry.tool === 'myco_skills')).toBe(false);
  });

  // OpenAI's strict tool schema validator rejects schemas that carry
  // oneOf/anyOf/allOf/enum/not at the top level. Anthropic's API rejects
  // the same shapes. The xor between source_path and plan_key is enforced
  // by the myco_plans handler's input validation, so no top-level
  // combinator is needed — and adding one crashes provider clients such
  // as opencode + GPT-5.
  it('no tool schema has oneOf/anyOf/allOf/not at the top level', () => {
    const forbidden = ['oneOf', 'anyOf', 'allOf', 'not'] as const;
    for (const tool of TOOL_DEFINITIONS) {
      for (const key of forbidden) {
        expect(
          (tool.inputSchema as Record<string, unknown>)[key],
          `Tool ${tool.name} has forbidden top-level schema key '${key}'`,
        ).toBeUndefined();
      }
    }
  });

  it('every tool name starts with myco_', () => {
    for (const tool of TOOL_DEFINITIONS) {
      expect(tool.name).toMatch(/^myco_/);
    }
  });

  // Any tool that carries annotations must set all four MCP annotation fields
  // so clients can render the correct confirmation UI. Missing any one of
  // these is a regression.
  it('annotated tools declare the full MCP annotation shape', () => {
    const required = ['myco_cortex', 'myco_plans', 'myco_sessions', 'myco_spores', 'myco_agent'];
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

  it('myco_agent annotations are pinned (fully read-only, idempotent, local)', () => {
    const agent = TOOL_DEFINITIONS.find((t) => t.name === 'myco_agent');
    expect(agent?.annotations?.readOnlyHint).toBe(true);
    expect(agent?.annotations?.destructiveHint).toBe(false);
    expect(agent?.annotations?.idempotentHint).toBe(true);
    expect(agent?.annotations?.openWorldHint).toBe(false);
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
});

/**
 * For each tool whose schema advertises query or body parameters, assert the
 * handler actually forwards them to the daemon. These tests exist specifically
 * to catch silent schema-vs-handler drift.
 *
 * Note: write-op drift coverage for myco_spores (save/supersede/consolidate)
 * and myco_plans (save) and read-op coverage for myco_plans and myco_sessions
 * lives in the per-tool integration tests under `tests/mcp/tools/` — those
 * call the in-process services and assert against the persisted DB state,
 * which catches the same class of drift end-to-end. This file only covers
 * tools that still go over HTTP (myco_search).
 */
describe('handler forwards every documented schema property', () => {
  it('myco_search forwards every documented filter', async () => {
    const client = mockClient({ results: [] });
    await handleMycoSearch({
      query: 'auth',
      type: 'canopy',
      limit: 4,
      observation_type: 'decision',
      status: 'active',
      since: 10,
      until: 20,
      language: 'typescript',
    }, client);
    const url = (client.get as unknown as { mock: { calls: string[][] } }).mock.calls[0][0];
    expect(url).toContain('q=auth');
    expect(url).toContain('type=canopy');
    expect(url).toContain('limit=4');
    expect(url).toContain('observation_type=decision');
    expect(url).toContain('status=active');
    expect(url).toContain('since=10');
    expect(url).toContain('until=20');
    expect(url).toContain('language=typescript');
  });
});

/**
 * Cross-surface anti-drift. These read the Pi symbiont and Team worker
 * source files and compare their registered tool names against the
 * canonical definitions — catching the class of drift where a tool is
 * added or renamed in one surface but not another.
 */
describe('cross-surface tool-name drift', () => {
  const TOOL_NAME_PATTERNS = {
    'server.tool': /server\.tool\(\s*["']([^"']+)["']/g,
    registerTool: /registerTool\(\{\s*name:\s*["']([^"']+)["']/g,
  } as const;

  function extractToolNames(relPath: string, pattern: keyof typeof TOOL_NAME_PATTERNS): string[] {
    const source = fs.readFileSync(path.resolve(__dirname, '../..', relPath), 'utf-8');
    return [...source.matchAll(TOOL_NAME_PATTERNS[pattern])].map((m) => m[1]);
  }

  it('Pi symbiont registers exactly the canonical tool set', () => {
    // The MCP surface is intentionally limited to read/editorial tools
    // for symbionts. There are no operator tools (no restart/update/
    // maintenance) — those are CLI + UI surfaces for users, not MCP.
    // See `docs/architecture/actors-and-boundaries.md`.
    const names = extractToolNames('packages/myco/src/symbionts/templates/pi/plugin.ts', 'registerTool');
    expect(names.length).toBeGreaterThan(0);
    const expected = new Set(TOOL_DEFINITIONS.map((t) => t.name));
    expect(new Set(names)).toEqual(expected);
  });

  it('Pi myco_search declares the canonical language filter in its tool schema', () => {
    // After the /api/mcp/* retirement, Pi wrappers no longer build URL
    // query strings — they shell out to `myco-run tool call`. The schema
    // declaration on the registerTool() call still has to mirror the
    // canonical TOOL_DEFINITIONS shape so the LLM sees the right surface.
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../packages/myco/src/symbionts/templates/pi/plugin.ts'),
      'utf-8',
    );
    expect(source).toContain('language?: string');
    expect(source).toContain('language: Type.Optional(Type.String');
  });

  it('Team worker exposes a subset of canonical local tools', () => {
    const names = extractToolNames('packages/myco-team/worker/src/mcp/server.ts', 'server.tool');
    expect(names.length).toBeGreaterThan(0);
    const canonical = new Set(TOOL_DEFINITIONS.map((t) => t.name));
    for (const n of names) {
      expect(canonical.has(n), `Team worker tool ${n} not in canonical TOOL_DEFINITIONS`).toBe(true);
    }
    expect(new Set(names)).toEqual(new Set([
      'myco_search',
      'myco_cortex',
      'myco_plans',
      'myco_sessions',
      'myco_skills',
      'myco_spores',
    ]));
    expect(names).not.toContain('myco_get');
    expect(names).not.toContain('myco_recall');
    expect(names).not.toContain('myco_graph');
    expect(names).not.toContain('myco_team');
  });
});
