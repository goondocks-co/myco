/**
 * Third Cortex surface: `myco_cortex op:instructions` through the tools
 * dispatcher. A `cli`-channel caller receives the transport directive with a
 * locally resolved invocation; an mcp caller receives the body untouched; a
 * host-served request renders the bare name so no host path crosses the
 * overlay.
 */

import { afterEach, describe, it, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vi } from '../helpers/vi-shim.js';
import { createMycoTools } from '@myco/tools/index.js';
import { resolveLegacyRequestContext } from '@myco/grove/request-context.js';
import { assertGroveProjectId, createProjectId } from '@myco/grove/ids.js';
import { managedBinaryPath } from '@myco/install/managed-binary.js';
import type { DaemonClient } from '@myco/hooks/client.js';
import type { MycoRequestContext } from '@myco/grove/request-context.js';

const FIXTURE_VAULT = '/tmp/myco-vault';
const FIXTURE_PROJECT_ID = assertGroveProjectId(createProjectId());

function fixtureContext(overrides: Partial<MycoRequestContext> = {}): MycoRequestContext {
  return {
    ...resolveLegacyRequestContext(FIXTURE_VAULT, {
      projectId: FIXTURE_PROJECT_ID,
      machineId: 'test-machine',
      tenancySource: 'caller',
    }),
    ...overrides,
  };
}

function mockClient(): DaemonClient {
  return {
    get: vi.fn(async (endpoint: string) => {
      if (endpoint === '/api/cortex/instructions') {
        return { ok: true, data: { content: 'BODY', generatedAt: 1, stored: true } };
      }
      return { ok: true, data: {} };
    }),
    post: vi.fn().mockResolvedValue({ ok: true, data: {} }),
    put: vi.fn().mockResolvedValue({ ok: true, data: {} }),
    delete: vi.fn().mockResolvedValue({ ok: true, data: {} }),
  } as unknown as DaemonClient;
}

const tmpDirs: string[] = [];
const savedMycoHome = process.env.MYCO_HOME;
afterEach(() => {
  if (savedMycoHome === undefined) delete process.env.MYCO_HOME;
  else process.env.MYCO_HOME = savedMycoHome;
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A home whose managed binary exists, so `instruction` resolves a real path. */
function homeWithManagedBinary(): { home: string; managed: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-directive-'));
  tmpDirs.push(home);
  const managed = managedBinaryPath(home, process.platform, process.env.LOCALAPPDATA);
  fs.mkdirSync(path.dirname(managed), { recursive: true });
  fs.writeFileSync(managed, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  process.env.MYCO_HOME = home;
  return { home, managed };
}

describe('myco_cortex op:instructions transport directive', () => {
  it('cli caller: directive prefixed, invocation resolved on this machine', async () => {
    const { managed } = homeWithManagedBinary();
    const tools = createMycoTools(FIXTURE_VAULT, mockClient(), {
      requestContext: fixtureContext(),
      toolCallerTransport: 'cli',
    });

    const result = await tools.callTool('myco_cortex', { op: 'instructions' }) as { content: string };

    expect(result.content).toContain(`${managed} tool call <tool>`);
    expect(result.content).toContain('BODY');
    expect(result.content).not.toContain(process.execPath);
  });

  it('mcp caller (default): body untouched, no directive', async () => {
    homeWithManagedBinary();
    const tools = createMycoTools(FIXTURE_VAULT, mockClient(), {
      requestContext: fixtureContext(),
    });

    const result = await tools.callTool('myco_cortex', { op: 'instructions' }) as { content: string };

    expect(result.content).toBe('BODY');
  });

  it('host-served request: directive renders the bare name, never this host’s path', async () => {
    const { managed } = homeWithManagedBinary();
    const tools = createMycoTools(FIXTURE_VAULT, mockClient(), {
      requestContext: fixtureContext({ hostServed: true }),
      toolCallerTransport: 'cli',
    });

    const result = await tools.callTool('myco_cortex', { op: 'instructions' }) as { content: string };

    expect(result.content).toContain('`myco tool call <tool>');
    expect(result.content).not.toContain(managed);
    expect(result.content).toContain('BODY');
  });
});
