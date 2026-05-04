import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeCanopyMap } from '@myco/canopy/map/store.js';
import type { DaemonClient } from '@myco/hooks/client.js';
import { createMycoTools } from '@myco/tools/index.js';
import { resolveLegacyRequestContext } from '@myco/tools/request-context.js';
import { cleanTestDb, setupTestDb, teardownTestDb } from '../helpers/db.js';
import { vi } from '../helpers/vi-shim.js';

function mockClient(): DaemonClient {
  return {
    get: vi.fn().mockResolvedValue({ ok: true, data: {} }),
    post: vi.fn().mockResolvedValue({ ok: true, data: {} }),
    put: vi.fn().mockResolvedValue({ ok: true, data: {} }),
    delete: vi.fn().mockResolvedValue({ ok: true, data: {} }),
  } as unknown as DaemonClient;
}

describe('Myco tools request-context dispatch', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => { cleanTestDb(); });

  it('uses the resolved request context for project-scoped Canopy reads', async () => {
    const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-context-dispatch-'));
    try {
      writeCanopyMap({
        project_id: 'project-a',
        machine_id: 'machine-a',
        content: '## Project A',
        inputs_hash: 'hash-a',
        token_estimate: 10,
        generated_by_run_id: null,
      });
      writeCanopyMap({
        project_id: 'project-b',
        machine_id: 'machine-a',
        content: '## Project B',
        inputs_hash: 'hash-b',
        token_estimate: 10,
        generated_by_run_id: null,
      });

      const requestContext = resolveLegacyRequestContext(vaultDir, {
        projectRoot: '/workspace/project-a',
        projectId: 'project-a',
        machineId: 'machine-a',
        source: 'explicit',
      });
      const tools = createMycoTools(vaultDir, mockClient(), { requestContext });

      const result = await tools.callTool('myco_cortex', { op: 'canopy_map' }) as { content: string };

      expect(result.content).toBe('## Project A');
    } finally {
      fs.rmSync(vaultDir, { recursive: true, force: true });
    }
  });
});
