import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import type { CanopyEntry } from '@myco/db/schema';
import { upsertCanopyEntry } from '@myco/canopy/scanner/upsert';
import { getDatabase } from '@myco/db/client.js';
import { runCanopyDescribe } from '@myco/canopy/describe/run';
import type { MycoConfig } from '@myco/config/schema';
import { MycoConfigSchema } from '@myco/config/schema';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db';

const PROJECT_ID = '/repo/myco';
const PROJECT_ROOT = '/tmp/canopy-describe-test';

function makeEntry(overrides: Partial<CanopyEntry> = {}): CanopyEntry {
  return {
    project_id: PROJECT_ID,
    machine_id: 'local',
    path: 'src/foo.ts',
    content_hash: 'a'.repeat(64),
    size_bytes: 1024,
    token_estimate: 200,
    line_count: 40,
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

function configWithLlm(overrides: { enabled?: boolean; max_attempts?: number; max_description_chars?: number } = {}): MycoConfig {
  // Construct a minimal config with the LLM enabled and an Ollama provider so
  // resolveProviderConfig succeeds. Tests inject a mock executor — the
  // provider config just has to be present and well-formed.
  const raw = {
    version: 3 as const,
    agent: {
      provider: { type: 'ollama' as const, model: 'qwen2.5-coder' },
    },
    cortex: {
      canopy: {
        llm: {
          enabled: overrides.enabled ?? true,
          reasoning_tier: 'low' as const,
          prompt_ref: 'canopy-describe',
          max_description_chars: overrides.max_description_chars ?? 180,
          max_attempts: overrides.max_attempts ?? 2,
        },
      },
    },
  };
  return MycoConfigSchema.parse(raw);
}

beforeAll(() => setupTestDb());
afterAll(() => teardownTestDb());
beforeEach(() => {
  cleanTestDb();
  getDatabase().prepare('DELETE FROM canopy_entries').run();
});

describe('runCanopyDescribe — gates', () => {
  it('skips when cortex.canopy.llm.enabled is false', async () => {
    upsertCanopyEntry(getDatabase(), makeEntry());
    const result = await runCanopyDescribe({
      db: getDatabase(),
      projectId: PROJECT_ID,
      projectRoot: PROJECT_ROOT,
      config: configWithLlm({ enabled: false }),
    });
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('disabled');
    expect(result.scanned).toBe(0);
  });

  it('skips with no-rows when no entries need a description', async () => {
    const entry = makeEntry({ llm_description: 'Existing summary.', llm_updated_at: 2_000_000_000 });
    upsertCanopyEntry(getDatabase(), entry);
    const result = await runCanopyDescribe({
      db: getDatabase(),
      projectId: PROJECT_ID,
      projectRoot: PROJECT_ROOT,
      config: configWithLlm(),
      executor: async () => ({ raw: 'should not be called', model: 'mock' }),
    });
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('no-rows');
  });
});

describe('runCanopyDescribe — happy path', () => {
  it('writes a description for a row missing one', async () => {
    upsertCanopyEntry(getDatabase(), makeEntry());
    let calls = 0;
    const result = await runCanopyDescribe({
      db: getDatabase(),
      projectId: PROJECT_ID,
      projectRoot: PROJECT_ROOT,
      config: configWithLlm(),
      executor: async () => {
        calls += 1;
        return { raw: 'Handles foo events for the upstream pipeline.', model: 'mock' };
      },
      now: () => 2_100_000_000,
    });
    expect(calls).toBe(1);
    expect(result).toMatchObject({ scanned: 1, written: 1, rejected: 0, errored: 0, skipped: false });

    const row = getDatabase()
      .prepare('SELECT llm_description, llm_updated_at FROM canopy_entries WHERE project_id = ? AND path = ?')
      .get(PROJECT_ID, 'src/foo.ts') as { llm_description: string; llm_updated_at: number };
    expect(row.llm_description).toBe('Handles foo events for the upstream pipeline.');
    expect(row.llm_updated_at).toBe(2_100_000_000);
  });

  it('only updates rows where llm_updated_at < mechanical_updated_at (idempotent)', async () => {
    // Three rows: fresh-stale, stale-needs-update, never-described.
    upsertCanopyEntry(
      getDatabase(),
      makeEntry({ path: 'a.ts', llm_description: 'fresh', llm_updated_at: 1_700_000_100, mechanical_updated_at: 1_700_000_000 }),
    );
    upsertCanopyEntry(
      getDatabase(),
      makeEntry({ path: 'b.ts', llm_description: 'stale', llm_updated_at: 1_700_000_000, mechanical_updated_at: 1_700_000_100 }),
    );
    upsertCanopyEntry(getDatabase(), makeEntry({ path: 'c.ts' }));

    const result = await runCanopyDescribe({
      db: getDatabase(),
      projectId: PROJECT_ID,
      projectRoot: PROJECT_ROOT,
      config: configWithLlm(),
      executor: async ({ entry }) => ({ raw: `summary for ${entry.path}`, model: 'mock' }),
      now: () => 2_000_000_000,
    });
    expect(result.scanned).toBe(2);
    expect(result.written).toBe(2);

    const aDesc = getDatabase()
      .prepare('SELECT llm_description FROM canopy_entries WHERE path = ?')
      .get('a.ts') as { llm_description: string };
    // 'a.ts' was fresh; not touched.
    expect(aDesc.llm_description).toBe('fresh');
  });
});

describe('runCanopyDescribe — retry/fallback', () => {
  it('retries once when post-process rejects, then writes on success', async () => {
    upsertCanopyEntry(getDatabase(), makeEntry());
    let attempt = 0;
    const result = await runCanopyDescribe({
      db: getDatabase(),
      projectId: PROJECT_ID,
      projectRoot: PROJECT_ROOT,
      config: configWithLlm({ max_attempts: 2 }),
      executor: async () => {
        attempt += 1;
        if (attempt === 1) return { raw: 'I am sorry, I cannot help.', model: 'mock' };
        return { raw: 'Defines the canopy describe loop.', model: 'mock' };
      },
    });
    expect(attempt).toBe(2);
    expect(result.written).toBe(1);
    expect(result.rejected).toBe(0);
  });

  it('leaves llm_description NULL after exhausting retries', async () => {
    upsertCanopyEntry(getDatabase(), makeEntry());
    const result = await runCanopyDescribe({
      db: getDatabase(),
      projectId: PROJECT_ID,
      projectRoot: PROJECT_ROOT,
      config: configWithLlm({ max_attempts: 3 }),
      executor: async () => ({ raw: 'I cannot help with that.', model: 'mock' }),
    });
    expect(result.written).toBe(0);
    expect(result.rejected).toBe(1);
    expect(result.errored).toBe(0);

    const row = getDatabase()
      .prepare('SELECT llm_description, llm_updated_at FROM canopy_entries WHERE path = ?')
      .get('src/foo.ts') as { llm_description: string | null; llm_updated_at: number | null };
    expect(row.llm_description).toBeNull();
    expect(row.llm_updated_at).toBeNull();
  });

  it('counts thrown executor errors separately from rejections', async () => {
    upsertCanopyEntry(getDatabase(), makeEntry());
    const result = await runCanopyDescribe({
      db: getDatabase(),
      projectId: PROJECT_ID,
      projectRoot: PROJECT_ROOT,
      config: configWithLlm({ max_attempts: 2 }),
      executor: async () => {
        throw new Error('connection refused');
      },
    });
    expect(result.errored).toBe(1);
    expect(result.rejected).toBe(0);
    expect(result.written).toBe(0);
  });

  it('aborts the whole batch when the provider is missing', async () => {
    upsertCanopyEntry(getDatabase(), makeEntry({ path: 'a.ts' }));
    upsertCanopyEntry(getDatabase(), makeEntry({ path: 'b.ts' }));
    const result = await runCanopyDescribe({
      db: getDatabase(),
      projectId: PROJECT_ID,
      projectRoot: PROJECT_ROOT,
      config: configWithLlm(),
      executor: async () => {
        throw new Error('canopy-describe: no provider configured');
      },
    });
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('no-provider');
  });
});

describe('runCanopyDescribe — exports-verbatim rejection feeds rejected count', () => {
  it('rejects when the model regurgitates an export name', async () => {
    upsertCanopyEntry(
      getDatabase(),
      makeEntry({ exports_json: JSON.stringify(['handleFoo']) }),
    );
    const result = await runCanopyDescribe({
      db: getDatabase(),
      projectId: PROJECT_ID,
      projectRoot: PROJECT_ROOT,
      config: configWithLlm({ max_attempts: 1 }),
      executor: async () => ({ raw: 'handleFoo', model: 'mock' }),
    });
    expect(result.rejected).toBe(1);
    expect(result.written).toBe(0);
  });
});
