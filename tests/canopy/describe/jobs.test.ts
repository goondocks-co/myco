import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db';
import { getDatabase } from '@myco/db/client.js';
import { upsertCanopyEntry } from '@myco/canopy/scanner/upsert';
import { registerCanopyDescribeJob } from '@myco/canopy/describe/jobs';
import { MycoConfigSchema, type MycoConfig } from '@myco/config/schema';
import { PowerManager } from '@myco/daemon/power';

const PROJECT_ID = '/repo/myco';
const PROJECT_ROOT = '/tmp/canopy-describe-jobs-test';

beforeAll(() => setupTestDb());
afterAll(() => teardownTestDb());
beforeEach(() => {
  cleanTestDb();
  getDatabase().prepare('DELETE FROM canopy_entries').run();
});

const mockLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as any; // eslint-disable-line @typescript-eslint/no-explicit-any

function newPowerManager(): PowerManager {
  return new PowerManager({
    idleThresholdMs: 1_000,
    sleepThresholdMs: 5_000,
    deepSleepThresholdMs: 10_000,
    activeIntervalMs: 250,
    sleepIntervalMs: 1_000,
    logger: mockLogger,
  });
}

function configWithLlmDisabled(): MycoConfig {
  return MycoConfigSchema.parse({
    version: 3 as const,
    cortex: {
      canopy: {
        llm: { enabled: false },
      },
    },
  });
}

describe('registerCanopyDescribeJob', () => {
  it('registers a power job named canopy-describe', () => {
    const pm = newPowerManager();
    const registered: string[] = [];
    const orig = pm.register.bind(pm);
    pm.register = (job) => {
      registered.push(job.name);
      orig(job);
    };

    registerCanopyDescribeJob(pm, {
      db: getDatabase(),
      logger: mockLogger,
      projectId: PROJECT_ID,
      projectRoot: PROJECT_ROOT,
      liveConfig: { current: configWithLlmDisabled() },
    });

    expect(registered).toContain('canopy-describe');
  });

  it('exposes runOnce that performs a no-op when LLM is disabled', async () => {
    const pm = newPowerManager();
    upsertCanopyEntry(getDatabase(), {
      project_id: PROJECT_ID,
      machine_id: 'local',
      path: 'src/foo.ts',
      content_hash: 'a'.repeat(64),
      size_bytes: 100,
      token_estimate: 25,
      line_count: 10,
      language: 'typescript',
      exports_json: null,
      imports_json: null,
      top_comment: null,
      mechanical_updated_at: 1_700_000_000,
      llm_description: null,
      llm_updated_at: null,
    });

    const reg = registerCanopyDescribeJob(pm, {
      db: getDatabase(),
      logger: mockLogger,
      projectId: PROJECT_ID,
      projectRoot: PROJECT_ROOT,
      liveConfig: { current: configWithLlmDisabled() },
    });
    await reg.runOnce();

    const row = getDatabase()
      .prepare('SELECT llm_description FROM canopy_entries WHERE path = ?')
      .get('src/foo.ts') as { llm_description: string | null };
    expect(row.llm_description).toBeNull();
  });
});
