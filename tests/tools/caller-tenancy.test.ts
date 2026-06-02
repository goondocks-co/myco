import { describe, it, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vi } from '../helpers/vi-shim.js';
import { createMycoTools } from '@myco/tools/index.js';
import { isToolError } from '@myco/tools/error.js';
import {
  resolveLegacyRequestContext,
  type MycoRequestContext,
} from '@myco/tools/request-context.js';
import { ensureProjectManifest } from '@myco/config/project-manifest.js';
import { assertGroveProjectId, createProjectId } from '@myco/grove/ids.js';
import type { DaemonClient } from '@myco/hooks/client.js';

const FIXTURE_PROJECT_ID = assertGroveProjectId(createProjectId());

function mockClient(): DaemonClient {
  return {
    get: vi.fn(async (endpoint: string) => {
      if (endpoint.startsWith('/api/team/status')) {
        return { ok: true, data: { collective_connected: false } };
      }
      if (endpoint === '/api/digest') {
        return { ok: true, data: { tiers: [{ tier: 5000, content: 'digest', generated_at: 1 }] } };
      }
      return { ok: true, data: {} };
    }),
    post: vi.fn().mockResolvedValue({ ok: true, data: {} }),
    put: vi.fn().mockResolvedValue({ ok: true, data: {} }),
    delete: vi.fn().mockResolvedValue({ ok: true, data: {} }),
  } as unknown as DaemonClient;
}

/** A fresh project-local vault with a Grove project id committed to project.toml. */
function freshGroveVault(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-caller-tenancy-'));
  ensureProjectManifest(dir, { projectName: 'caller-tenancy-test' });
  return dir;
}

describe('createMycoTools requires caller-supplied tenancy', () => {
  it('rejects loudly when NO requestContext is supplied (no silent anchor fallback)', async () => {
    const vaultDir = freshGroveVault();
    try {
      const tools = createMycoTools(vaultDir, mockClient());
      // listTools / getRegisteredTools are context-free surface enumeration
      // and stay usable.
      expect(tools.getRegisteredTools()).toContain('myco_cortex');

      // Using a tool without caller tenancy must fail loud, not default to
      // the anchor vault.
      let caught: unknown;
      try {
        await tools.callTool('myco_cortex', { op: 'digest', tier: 5000 });
      } catch (err) {
        caught = err;
      }
      expect(isToolError(caught)).toBe(true);
      expect((caught as { code: string }).code).toBe('legacy_vault');
    } finally {
      fs.rmSync(vaultDir, { recursive: true, force: true });
    }
  });

  it('rejects a synthesized context (tenancySource: "synthesized")', async () => {
    const vaultDir = freshGroveVault();
    try {
      const synthesized: MycoRequestContext = resolveLegacyRequestContext(vaultDir, {
        projectId: FIXTURE_PROJECT_ID,
        machineId: 'test-machine',
        tenancySource: 'synthesized',
      });
      const tools = createMycoTools(vaultDir, mockClient(), { requestContext: synthesized });

      let caught: unknown;
      try {
        await tools.callTool('myco_cortex', { op: 'digest', tier: 5000 });
      } catch (err) {
        caught = err;
      }
      expect(isToolError(caught)).toBe(true);
      expect((caught as { code: string }).code).toBe('legacy_vault');
    } finally {
      fs.rmSync(vaultDir, { recursive: true, force: true });
    }
  });

  it('accepts a CLI-env-style caller context and resolves THAT tenant', async () => {
    // CLI (requestContextFromEnvironment) and MCP (requestContextFromHttpHeaders)
    // mark project/grove-supplied tenancy as 'caller'; resolveLegacyRequestContext
    // with tenancySource:'caller' is the minimal in-test representation of what
    // those transports hand to createMycoTools.
    const vaultDir = freshGroveVault();
    try {
      const requestContext: MycoRequestContext = resolveLegacyRequestContext(vaultDir, {
        projectId: FIXTURE_PROJECT_ID,
        machineId: 'cli-machine',
        source: 'explicit',
        tenancySource: 'caller',
      });
      expect(requestContext.tenancySource).toBe('caller');

      const tools = createMycoTools(vaultDir, mockClient(), { requestContext });
      const result = await tools.callTool('myco_cortex', { op: 'digest', tier: 5000 }) as {
        content: string;
      };
      expect(result.content).toBe('digest');
    } finally {
      fs.rmSync(vaultDir, { recursive: true, force: true });
    }
  });

  it('accepts an MCP-header-style caller context and resolves THAT tenant', async () => {
    const vaultDir = freshGroveVault();
    try {
      const requestContext: MycoRequestContext = resolveLegacyRequestContext(vaultDir, {
        projectId: FIXTURE_PROJECT_ID,
        machineId: 'mcp-machine',
        source: 'headers',
        tenancySource: 'caller',
      });
      expect(requestContext.tenancySource).toBe('caller');

      const tools = createMycoTools(vaultDir, mockClient(), { requestContext });
      const result = await tools.callTool('myco_cortex', { op: 'digest', tier: 5000 }) as {
        content: string;
      };
      expect(result.content).toBe('digest');
    } finally {
      fs.rmSync(vaultDir, { recursive: true, force: true });
    }
  });
});
