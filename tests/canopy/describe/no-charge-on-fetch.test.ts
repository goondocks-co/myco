/**
 * Regression: canopy_describe_next must NOT increment describe_attempts at
 * fetch time. Charging attempts on fetch burns the per-row retry budget during
 * provider outages — the increment moves to canopy_describe_charge (Task A7).
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDatabase } from '@myco/db/client.js';
import { createCanopyTools } from '@myco/agent/tools/canopy-tools.js';
import { ensureProjectManifest } from '@myco/config/project-manifest.js';
import { setupTestDb, cleanTestDb, teardownTestDb, seedCanopyEntry } from '../../helpers/db.js';

describe('canopy_describe_next — no charge on fetch', () => {
  let projectRoot: string;
  let vaultDir: string;
  let projectId: string;

  beforeAll(() => {
    setupTestDb();
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-no-charge-test-'));
    vaultDir = path.join(projectRoot, '.myco');
    fs.mkdirSync(vaultDir, { recursive: true });
    projectId = ensureProjectManifest(vaultDir, { projectName: 'canopy-no-charge-test' }).project.id;
  });

  afterAll(() => {
    teardownTestDb();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    cleanTestDb();
  });

  it('does not increment describe_attempts on fetch', async () => {
    const db = getDatabase();
    seedCanopyEntry(db, {
      project_id: projectId,
      path: 'a.ts',
      llm_description: null,
      // describe_attempts defaults to 0 (NOT in CanopyEntrySeed; set by DB default)
    });

    const tools = createCanopyTools({ projectRoot, vaultDir } as any);
    const next = tools.find((t: any) => t.name === 'canopy_describe_next')!;
    const result = await (next as any).handler({ limit: 10, max_attempts: 2 });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.entries).toHaveLength(1);

    const row = db
      .prepare('SELECT describe_attempts FROM canopy_entries WHERE project_id = ? AND path = ?')
      .get(projectId, 'a.ts') as { describe_attempts: number };
    expect(row.describe_attempts).toBe(0);
  });
});
