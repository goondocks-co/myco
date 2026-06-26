/**
 * Tests for charging describe attempts on genuine content failures (Task A7).
 *
 *  - chargeDescribeAttempts(db, projectId, paths): the data-access function
 *    that increments describe_attempts for an explicit path list.
 *  - canopy_describe_charge: the harness tool that delegates to it.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDatabase } from '@myco/db/client.js';
import { chargeDescribeAttempts } from '@myco/db/queries/canopy.js';
import { createCanopyTools } from '@myco/agent/tools/canopy-tools.js';
import { ensureProjectManifest } from '@myco/config/project-manifest.js';
import { setupTestDb, cleanTestDb, teardownTestDb, seedCanopyEntry } from '../../helpers/db.js';

const PROJECT_B = 'proj_b';

let projectRoot: string;
let vaultDir: string;
let projectId: string;

function attempts(db: ReturnType<typeof getDatabase>, pid: string, p: string): number {
  const row = db
    .prepare('SELECT describe_attempts FROM canopy_entries WHERE project_id = ? AND path = ?')
    .get(pid, p) as { describe_attempts: number };
  return row.describe_attempts;
}

beforeAll(() => {
  setupTestDb();
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-charge-test-'));
  vaultDir = path.join(projectRoot, '.myco');
  fs.mkdirSync(vaultDir, { recursive: true });
  projectId = ensureProjectManifest(vaultDir, { projectName: 'canopy-charge-test' }).project.id;
});

afterAll(() => {
  teardownTestDb();
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

beforeEach(() => {
  cleanTestDb();
});

// ---------------------------------------------------------------------------
// chargeDescribeAttempts (query)
// ---------------------------------------------------------------------------

describe('chargeDescribeAttempts', () => {
  it('increments describe_attempts by 1 for a single path', () => {
    const db = getDatabase();
    seedCanopyEntry(db, { project_id: projectId, path: 'a.ts', llm_description: null });
    const charged = chargeDescribeAttempts(db, projectId, ['a.ts']);
    expect(charged).toBe(1);
    expect(attempts(db, projectId, 'a.ts')).toBe(1);
  });

  it('charges each path via json_each over multiple paths', () => {
    const db = getDatabase();
    for (const p of ['a.ts', 'b.ts', 'c.ts']) {
      seedCanopyEntry(db, { project_id: projectId, path: p, llm_description: null });
    }
    const charged = chargeDescribeAttempts(db, projectId, ['a.ts', 'b.ts', 'c.ts']);
    expect(charged).toBe(3);
    for (const p of ['a.ts', 'b.ts', 'c.ts']) {
      expect(attempts(db, projectId, p)).toBe(1);
    }
  });

  it('accumulates across repeated charges (one attempt per call)', () => {
    const db = getDatabase();
    seedCanopyEntry(db, { project_id: projectId, path: 'a.ts', llm_description: null });
    chargeDescribeAttempts(db, projectId, ['a.ts']);
    chargeDescribeAttempts(db, projectId, ['a.ts']);
    expect(attempts(db, projectId, 'a.ts')).toBe(2);
  });

  it('is scoped to the given projectId (no cross-project charge)', () => {
    const db = getDatabase();
    seedCanopyEntry(db, { project_id: projectId, path: 'shared.ts', llm_description: null });
    seedCanopyEntry(db, { project_id: PROJECT_B, path: 'shared.ts', llm_description: null });
    chargeDescribeAttempts(db, projectId, ['shared.ts']);
    expect(attempts(db, projectId, 'shared.ts')).toBe(1);
    expect(attempts(db, PROJECT_B, 'shared.ts')).toBe(0);
  });

  it('returns 0 and charges nothing for an empty path list', () => {
    const db = getDatabase();
    seedCanopyEntry(db, { project_id: projectId, path: 'a.ts', llm_description: null });
    expect(chargeDescribeAttempts(db, projectId, [])).toBe(0);
    expect(attempts(db, projectId, 'a.ts')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// canopy_describe_charge (tool delegates to the query)
// ---------------------------------------------------------------------------

describe('canopy_describe_charge', () => {
  it('charges one attempt for an evaluated row that produced no description', async () => {
    const db = getDatabase();
    seedCanopyEntry(db, { project_id: projectId, path: 'a.ts', llm_description: null });

    const tools = createCanopyTools({ projectRoot, vaultDir } as any);
    const charge = tools.find((t: any) => t.name === 'canopy_describe_charge')!;
    const result = await (charge as any).handler({ items: [{ path: 'a.ts' }] });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.charged).toBe(1);
    expect(attempts(db, projectId, 'a.ts')).toBe(1);
  });

  it('returns charged:0 when project_id cannot be resolved', async () => {
    const tools = createCanopyTools({} as any);
    const charge = tools.find((t: any) => t.name === 'canopy_describe_charge')!;
    const result = await (charge as any).handler({ items: [{ path: 'a.ts' }] });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.charged).toBe(0);
  });
});
