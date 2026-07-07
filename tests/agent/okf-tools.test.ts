/**
 * Unit tests for the OKF synthesis harness tools
 * (packages/myco/src/agent/tools/okf-tools.ts).
 *
 * Names, fail-closed-on-missing-deps behavior, and read/write annotations are
 * covered here without a DB/bundle fixture. The live explore → plan →
 * map-synthesize → publish flow (the plan→map handoff and one-lock-per-run
 * guarantee) is covered end to end in tests/agent/okf-synthesize-task.test.ts.
 */

import { describe, expect, it } from 'bun:test';
import { createOkfTools, OKF_TOOL_NAMES } from '@myco/agent/tools/okf-tools.js';
import type { VaultToolDeps } from '@myco/agent/tools/types.js';

async function invoke(t: { handler: (args: unknown) => Promise<unknown> }, args: Record<string, unknown>): Promise<any> {
  const result = (await t.handler(args)) as { content: Array<{ type: string; text: string }> };
  return JSON.parse(result.content[0].text);
}

const READ_ONLY_TOOLS = [
  'okf_read_sources',
  'okf_list_pages',
  'okf_read_page',
  'okf_list_planned_pages',
  'okf_report',
];

describe('OKF_TOOL_NAMES', () => {
  it('lists exactly the seven synthesis tool names', () => {
    expect([...OKF_TOOL_NAMES].sort()).toEqual(
      [
        'okf_read_sources',
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
