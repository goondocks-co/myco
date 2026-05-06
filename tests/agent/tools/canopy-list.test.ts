/**
 * Tests for the `canopy_list` harness tool — returns the full canopy_entries
 * set (all rows, or just described rows) for the current project.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDatabase } from '@myco/db/client.js';
import { createCanopyTools } from '@myco/agent/tools/canopy-tools.js';
import { ensureProjectManifest } from '@myco/config/project-manifest.js';
import { setupTestDb, cleanTestDb, teardownTestDb, seedCanopyEntry } from '../../helpers/db.js';

describe('canopy_list harness tool', () => {
  let projectRoot: string;
  let vaultDir: string;
  let projectId: string;

  beforeAll(() => {
    setupTestDb();
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-list-test-'));
    vaultDir = path.join(projectRoot, '.myco');
    fs.mkdirSync(vaultDir, { recursive: true });
    projectId = ensureProjectManifest(vaultDir, { projectName: 'canopy-list-test' }).project.id;
  });
  afterAll(() => {
    teardownTestDb();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });
  beforeEach(() => {
    cleanTestDb();
    const db = getDatabase();
    seedCanopyEntry(db, {
      project_id: projectId,
      path: 'a.ts',
      language: 'typescript',
      exports_json: '["foo"]',
      imports_json: '["bar"]',
      token_estimate: 50,
      mechanical_updated_at: 1,
      llm_description: 'desc a',
    });
    seedCanopyEntry(db, {
      project_id: projectId,
      path: 'b.ts',
      language: 'typescript',
      exports_json: '[]',
      imports_json: '[]',
      token_estimate: 50,
      mechanical_updated_at: 2,
      llm_description: null,
    });
  });

  const findTool = (deps: any) => {
    const tools = createCanopyTools(deps);
    return tools.find((t: any) => t.name === 'canopy_list');
  };

  const parseResult = (result: { content: Array<{ type: string; text: string }> }): unknown => {
    return JSON.parse(result.content[0].text);
  };

  it('returns described rows by default', async () => {
    const tool = findTool({ projectRoot, vaultDir });
    expect(tool).toBeDefined();
    const result = await tool!.handler({});
    const parsed = parseResult(result) as any;
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]).toMatchObject({
      path: 'a.ts',
      language: 'typescript',
      llm_description: 'desc a',
      exports: ['foo'],
      imports: ['bar'],
      token_estimate: 50,
    });
  });

  it('include_undescribed=true returns all rows', async () => {
    const tool = findTool({ projectRoot, vaultDir });
    const result = await tool!.handler({ include_undescribed: true });
    const parsed = parseResult(result) as any;
    expect(parsed.rows).toHaveLength(2);
  });

  it('respects limit', async () => {
    const tool = findTool({ projectRoot, vaultDir });
    const result = await tool!.handler({ include_undescribed: true, limit: 1 });
    const parsed = parseResult(result) as any;
    expect(parsed.rows).toHaveLength(1);
  });

  it('errors when project_id is unavailable', async () => {
    const tool = findTool({});
    const result = await tool!.handler({});
    const parsed = parseResult(result) as any;
    expect(parsed.error).toBeDefined();
  });
});
