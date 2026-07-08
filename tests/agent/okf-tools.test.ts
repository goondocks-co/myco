/**
 * Unit tests for the OKF synthesis harness tools
 * (packages/myco/src/agent/tools/okf-tools.ts).
 *
 * Names, fail-closed-on-missing-deps behavior, and read/write annotations are
 * covered here without a DB/bundle fixture. The live explore → plan →
 * map-synthesize → publish flow (the plan→map handoff and one-lock-per-run
 * guarantee) is covered end to end in tests/agent/okf-synthesize-task.test.ts.
 */

import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { createOkfTools, OKF_TOOL_NAMES, __clearOkfSpecCacheForTests } from '@myco/agent/tools/okf-tools.js';
import type { VaultToolDeps } from '@myco/agent/tools/types.js';

async function invoke(t: { handler: (args: unknown) => Promise<unknown> }, args: Record<string, unknown>): Promise<any> {
  const result = (await t.handler(args)) as { content: Array<{ type: string; text: string }> };
  return JSON.parse(result.content[0].text);
}

const READ_ONLY_TOOLS = [
  'okf_read_sources',
  'okf_read_spec',
  'okf_list_pages',
  'okf_read_page',
  'okf_list_planned_pages',
  'okf_report',
];

describe('OKF_TOOL_NAMES', () => {
  it('lists exactly the eight synthesis tool names', () => {
    expect([...OKF_TOOL_NAMES].sort()).toEqual(
      [
        'okf_read_sources',
        'okf_read_spec',
        'okf_list_pages',
        'okf_read_page',
        'okf_write_plan',
        'okf_list_planned_pages',
        'okf_write_page',
        'okf_report',
      ].sort(),
    );
  });
});

describe('createOkfTools — fail-closed on missing deps', () => {
  const baseDeps = { agentId: 'a', runId: 'r', recordTurn: () => null } as unknown as VaultToolDeps;

  it('okf_read_sources errors when projectRoot/vaultDir/requestContext are absent', async () => {
    const tools = createOkfTools(baseDeps);
    const readSources = tools.find((t) => t.name === 'okf_read_sources')!;
    const result = await invoke(readSources, {});
    expect(result.error).toBeTruthy();
  });

  it('okf_list_pages errors when deps are absent', async () => {
    const tools = createOkfTools(baseDeps);
    const listPages = tools.find((t) => t.name === 'okf_list_pages')!;
    const result = await invoke(listPages, {});
    expect(result.error).toBeTruthy();
  });

  it('okf_write_plan fails closed (ok:false) when projectRoot is absent', async () => {
    const tools = createOkfTools(baseDeps);
    const writePlan = tools.find((t) => t.name === 'okf_write_plan')!;
    const result = await invoke(writePlan, { pages: [] });
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('okf_list_planned_pages returns an empty page list when projectRoot is absent', async () => {
    const tools = createOkfTools(baseDeps);
    const listPlanned = tools.find((t) => t.name === 'okf_list_planned_pages')!;
    const result = await invoke(listPlanned, {});
    expect(result.pages).toEqual([]);
    expect(result.error).toBeTruthy();
  });

  it('okf_write_page fails closed (ok:false) when deps are absent', async () => {
    const tools = createOkfTools(baseDeps);
    const writePage = tools.find((t) => t.name === 'okf_write_page')!;
    const result = await invoke(writePage, {
      path: 'concepts/x', type: 'concept', title: 'X', description: 'd', body: 'b',
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBeTruthy();
  });
});

describe('okf_read_spec — provider-agnostic server-side spec fetch', () => {
  const baseDeps = { agentId: 'a', runId: 'r', recordTurn: () => null } as unknown as VaultToolDeps;

  afterEach(() => {
    __clearOkfSpecCacheForTests();
  });

  it('needs no vault deps — fetches the spec text server-side and returns {ok:true, spec}', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('# Open Knowledge Format (OKF)\n\nVersion 0.1', { status: 200 }),
    );
    try {
      const readSpec = createOkfTools(baseDeps).find((t) => t.name === 'okf_read_spec')!;
      const result = await invoke(readSpec, {});
      expect(result.ok).toBe(true);
      expect(result.spec).toContain('Open Knowledge Format');
      expect(result.cached).toBe(false);
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      // Second call within TTL is served from the in-memory cache — no refetch.
      const again = await invoke(readSpec, {});
      expect(again.ok).toBe(true);
      expect(again.cached).toBe(true);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('degrades gracefully to {ok:false, error} when the fetch fails (agent falls back to prompt rules)', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    try {
      const readSpec = createOkfTools(baseDeps).find((t) => t.name === 'okf_read_spec')!;
      const result = await invoke(readSpec, {});
      expect(result.ok).toBe(false);
      expect(result.error).toContain('could not fetch OKF spec');
      expect(result.guidance).toBeTruthy();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('treats a non-2xx response as a failure (not a spec body)', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(new Response('not found', { status: 404 }));
    try {
      const readSpec = createOkfTools(baseDeps).find((t) => t.name === 'okf_read_spec')!;
      const result = await invoke(readSpec, {});
      expect(result.ok).toBe(false);
      expect(result.error).toContain('404');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('carries readOnlyHint: true', () => {
    const readSpec = createOkfTools(baseDeps).find((t) => t.name === 'okf_read_spec')!;
    expect(readSpec.annotations?.readOnlyHint).toBe(true);
  });

  it('takes NO parameters — the spec URL is fixed in the tool, not agent-supplied (no SSRF surface)', () => {
    const readSpec = createOkfTools(baseDeps).find((t) => t.name === 'okf_read_spec')!;
    // An empty input schema means the model cannot pass a `url` (or any) arg —
    // the fetched endpoint is hardcoded, so a prompt-injected value can't
    // redirect the server-side GET at an arbitrary host.
    expect(Object.keys((readSpec.inputSchema ?? {}) as Record<string, unknown>)).toEqual([]);
  });
});

describe('OKF tool annotations', () => {
  const baseDeps = { agentId: 'a', runId: 'r', recordTurn: () => null } as unknown as VaultToolDeps;

  it('read/report tools carry readOnlyHint: true', () => {
    const tools = createOkfTools(baseDeps);
    for (const name of READ_ONLY_TOOLS) {
      const t = tools.find((tool) => tool.name === name)!;
      expect(t.annotations?.readOnlyHint).toBe(true);
    }
  });

  it('okf_write_page does NOT carry readOnlyHint (it is the map sink)', () => {
    const tools = createOkfTools(baseDeps);
    const writePage = tools.find((t) => t.name === 'okf_write_page')!;
    expect(writePage.annotations?.readOnlyHint).not.toBe(true);
  });

  it('okf_write_plan is idempotent, not read-only', () => {
    const tools = createOkfTools(baseDeps);
    const writePlan = tools.find((t) => t.name === 'okf_write_plan')!;
    expect(writePlan.annotations?.readOnlyHint).not.toBe(true);
    expect(writePlan.annotations?.idempotentHint).toBe(true);
  });
});
