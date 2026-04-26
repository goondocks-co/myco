/**
 * Tests for the canopy_describe_next + canopy_describe_write harness tools.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getDatabase } from '@myco/db/client.js';
import { upsertCanopyEntry } from '@myco/canopy/scanner/upsert';
import { createVaultTools } from '@myco/agent/tools.js';
import type { CanopyEntry } from '@myco/db/schema';
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db';

const TEST_AGENT_ID = 'canopy-tools-agent';
const TEST_RUN_ID = 'canopy-tools-run';

let projectRoot: string;
let projectId: string;
const VAULT_DIR_NAME = '.myco';

function makeEntry(overrides: Partial<CanopyEntry> = {}): CanopyEntry {
  return {
    project_id: projectId,
    machine_id: 'local',
    path: 'src/foo.ts',
    content_hash: 'a'.repeat(64),
    size_bytes: 256,
    token_estimate: 80,
    line_count: 12,
    language: 'typescript',
    exports_json: JSON.stringify(['handleFoo']),
    imports_json: JSON.stringify(['./bar']),
    top_comment: 'Handles foo events.',
    mechanical_updated_at: 1_700_000_000,
    llm_description: null,
    llm_updated_at: null,
    ...overrides,
  };
}

function findTool(tools: ReturnType<typeof createVaultTools>, name: string) {
  const t = tools.find((tool) => tool.name === name);
  if (!t) throw new Error(`Tool not found: ${name}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return t as SdkMcpToolDefinition<any>;
}

function parseResult(result: { content: Array<{ type: string; text: string }> }): any {
  return JSON.parse(result.content[0].text);
}

function createTools() {
  return createVaultTools(TEST_AGENT_ID, TEST_RUN_ID, {
    projectRoot,
    vaultDir: path.join(projectRoot, VAULT_DIR_NAME),
  });
}

beforeAll(() => {
  setupTestDb();
  projectRoot = mkdtempSync(path.join(tmpdir(), 'canopy-tools-'));
  // resolveCanopyProjectId returns dirname(vaultDir); construct projectId so
  // upsert and tool-resolved project_id agree.
  projectId = projectRoot;
  mkdirSync(path.join(projectRoot, VAULT_DIR_NAME), { recursive: true });
  mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
  writeFileSync(
    path.join(projectRoot, 'src/foo.ts'),
    "// Handles foo events.\nexport function handleFoo() { return 1; }\n",
    'utf-8',
  );
});

afterAll(() => {
  teardownTestDb();
  rmSync(projectRoot, { recursive: true, force: true });
});

beforeEach(() => {
  cleanTestDb();
  getDatabase().prepare('DELETE FROM canopy_entries').run();
});

describe('canopy_describe_next', () => {
  it('returns pending entries up to limit', async () => {
    upsertCanopyEntry(getDatabase(), makeEntry({ path: 'src/foo.ts' }));
    upsertCanopyEntry(getDatabase(), makeEntry({ path: 'src/bar.ts' }));

    const tool = findTool(createTools(), 'canopy_describe_next');
    const out = parseResult(await tool.handler({ limit: 5 }, {} as any));
    expect(out.entries).toHaveLength(2);
    expect(out.entries[0]).toMatchObject({
      language: 'typescript',
      exports: ['handleFoo'],
    });
  });

  it('honors the limit argument', async () => {
    upsertCanopyEntry(getDatabase(), makeEntry({ path: 'a.ts' }));
    upsertCanopyEntry(getDatabase(), makeEntry({ path: 'b.ts' }));
    upsertCanopyEntry(getDatabase(), makeEntry({ path: 'c.ts' }));

    const tool = findTool(createTools(), 'canopy_describe_next');
    const out = parseResult(await tool.handler({ limit: 2 }, {} as any));
    expect(out.entries).toHaveLength(2);
  });

  it('excludes rows whose llm_updated_at >= mechanical_updated_at', async () => {
    upsertCanopyEntry(getDatabase(), makeEntry({
      path: 'fresh.ts',
      llm_description: 'already described',
      llm_updated_at: 1_700_000_500,
      mechanical_updated_at: 1_700_000_000,
    }));
    upsertCanopyEntry(getDatabase(), makeEntry({
      path: 'stale.ts',
      llm_description: 'old',
      llm_updated_at: 1_700_000_000,
      mechanical_updated_at: 1_700_000_500,
    }));
    upsertCanopyEntry(getDatabase(), makeEntry({ path: 'new.ts' }));

    const tool = findTool(createTools(), 'canopy_describe_next');
    const out = parseResult(await tool.handler({}, {} as any));
    const paths = out.entries.map((e: { path: string }) => e.path).sort();
    expect(paths).toEqual(['new.ts', 'stale.ts']);
  });

  it('returns an empty array when nothing is pending', async () => {
    upsertCanopyEntry(getDatabase(), makeEntry({
      path: 'fresh.ts',
      llm_description: 'done',
      llm_updated_at: 1_700_000_500,
      mechanical_updated_at: 1_700_000_000,
    }));
    const tool = findTool(createTools(), 'canopy_describe_next');
    const out = parseResult(await tool.handler({}, {} as any));
    expect(out.entries).toEqual([]);
  });
});

describe('canopy_describe_write', () => {
  it('writes a clean description and stamps llm_updated_at', async () => {
    upsertCanopyEntry(getDatabase(), makeEntry({ path: 'src/foo.ts' }));
    const tool = findTool(createTools(), 'canopy_describe_write');
    const out = parseResult(await tool.handler({
      path: 'src/foo.ts',
      description: 'Handles foo events for the upstream pipeline.',
    }, {} as any));
    expect(out.ok).toBe(true);

    const row = getDatabase()
      .prepare('SELECT llm_description, llm_updated_at FROM canopy_entries WHERE path = ?')
      .get('src/foo.ts') as { llm_description: string; llm_updated_at: number };
    expect(row.llm_description).toBe('Handles foo events for the upstream pipeline.');
    expect(row.llm_updated_at).toBeGreaterThan(0);
  });

  it('rejects boilerplate-only output', async () => {
    upsertCanopyEntry(getDatabase(), makeEntry({ path: 'src/foo.ts' }));
    const tool = findTool(createTools(), 'canopy_describe_write');
    const out = parseResult(await tool.handler({
      path: 'src/foo.ts',
      description: 'Summary: ',
    }, {} as any));
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('boilerplate');

    const row = getDatabase()
      .prepare('SELECT llm_description FROM canopy_entries WHERE path = ?')
      .get('src/foo.ts') as { llm_description: string | null };
    expect(row.llm_description).toBeNull();
  });

  it('rejects refusals', async () => {
    upsertCanopyEntry(getDatabase(), makeEntry({ path: 'src/foo.ts' }));
    const tool = findTool(createTools(), 'canopy_describe_write');
    const out = parseResult(await tool.handler({
      path: 'src/foo.ts',
      description: "I'm sorry, I cannot summarize this file.",
    }, {} as any));
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('refusal');
  });

  it('rejects verbatim export regurgitation', async () => {
    upsertCanopyEntry(getDatabase(), makeEntry({
      path: 'src/foo.ts',
      exports_json: JSON.stringify(['handleFoo']),
    }));
    const tool = findTool(createTools(), 'canopy_describe_write');
    const out = parseResult(await tool.handler({
      path: 'src/foo.ts',
      description: 'handleFoo',
    }, {} as any));
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('verbatim_export');
  });

  it('rejects empty descriptions', async () => {
    upsertCanopyEntry(getDatabase(), makeEntry({ path: 'src/foo.ts' }));
    const tool = findTool(createTools(), 'canopy_describe_write');
    const out = parseResult(await tool.handler({
      path: 'src/foo.ts',
      description: '   \n  ',
    }, {} as any));
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('empty');
  });

  it('rejects unknown paths', async () => {
    const tool = findTool(createTools(), 'canopy_describe_write');
    const out = parseResult(await tool.handler({
      path: 'src/missing.ts',
      description: 'some description',
    }, {} as any));
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('unknown_path');
  });

  it('rejects very long output as too_long', async () => {
    upsertCanopyEntry(getDatabase(), makeEntry({ path: 'src/foo.ts' }));
    const tool = findTool(createTools(), 'canopy_describe_write');
    // postProcess() always returns a truncated string, so to make it return
    // null we feed a refusal string padded out — postProcess returns null
    // for refusal, classifier sees length > 4× cap → too_long.
    const out = parseResult(await tool.handler({
      path: 'src/foo.ts',
      description: 'I cannot help. ' + 'x'.repeat(800),
    }, {} as any));
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('too_long');
  });

  it('caps overlong-but-otherwise-clean output at 180 chars on accept', async () => {
    upsertCanopyEntry(getDatabase(), makeEntry({ path: 'src/foo.ts' }));
    const tool = findTool(createTools(), 'canopy_describe_write');
    const long = 'Defines the canopy describe loop and several other things '
      + 'that span well beyond the description cap to verify truncation ' +
      'is applied during write rather than failing the row.';
    const out = parseResult(await tool.handler({
      path: 'src/foo.ts',
      description: long,
    }, {} as any));
    expect(out.ok).toBe(true);
    expect(out.description.length).toBeLessThanOrEqual(180);
  });
});
