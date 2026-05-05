import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveProjectManifest } from '@myco/config/project-manifest.js';
import { createGrove, registerProjectInGrove } from '@myco/grove/registry.js';
import { resolveGroveDbPath, resolveProjectVaultDir } from '@myco/grove/paths.js';
import {
  REQUEST_CONTEXT_ENV,
  REQUEST_CONTEXT_HEADERS,
  requestContextFromEnvironment,
  requestContextFromHttpHeaders,
  requestContextHeaders,
  rowProjectIdFromRequestContext,
  resolveLegacyRequestContext,
} from '@myco/tools/request-context.js';

function withRegisteredProject<T>(fn: (args: {
  home: string;
  projectRoot: string;
  vaultDir: string;
  groveId: string;
  projectId: string;
}) => T): T {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-request-context-'));
  const previousHome = process.env.MYCO_HOME;
  try {
    const home = path.join(tmp, 'home');
    process.env.MYCO_HOME = home;
    const projectRoot = path.join(tmp, 'project');
    const vaultDir = resolveProjectVaultDir(projectRoot);
    fs.mkdirSync(vaultDir, { recursive: true });
    const grove = createGrove('Work', home);
    const projectId = 'project-a';
    saveProjectManifest(vaultDir, {
      project: { id: projectId, name: 'Project A' },
      grove: { binding_id: 'gbind-a', slug: grove.slug, mode: 'local' },
    });
    registerProjectInGrove(grove.id, {
      projectId,
      projectName: 'Project A',
      projectRoot,
      bindingId: 'gbind-a',
    }, home);
    return fn({ home, projectRoot, vaultDir, groveId: grove.id, projectId });
  } finally {
    if (previousHome === undefined) delete process.env.MYCO_HOME;
    else process.env.MYCO_HOME = previousHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

describe('tool request context', () => {
  it('resolves the legacy project-local context from a vault directory', () => {
    const vaultDir = path.join('/tmp', 'project', '.myco');
    const context = resolveLegacyRequestContext(vaultDir, { machineId: 'machine-1' });

    expect(context.projectRoot).toBe(path.join('/tmp', 'project'));
    expect(context.projectId).toBe(path.join('/tmp', 'project'));
    expect(context.projectVaultDir).toBe(vaultDir);
    expect(context.databasePath).toBe(path.join(vaultDir, 'myco.db'));
    expect(context.machineId).toBe('machine-1');
    expect(context.groveId).toBeNull();
    expect(context.source).toBe('legacy-vault');
  });

  it('round-trips request context through MCP HTTP headers', () => {
    withRegisteredProject(({ projectRoot, vaultDir, groveId, projectId }) => {
      const explicit = resolveLegacyRequestContext(vaultDir, {
        projectRoot,
        projectId,
        groveId,
        machineId: 'machine-1',
        sessionId: 'sess-1',
        source: 'explicit',
      });

      const resolved = requestContextFromHttpHeaders(requestContextHeaders(explicit), vaultDir);

      expect(resolved.projectRoot).toBe(explicit.projectRoot);
      expect(resolved.projectId).toBe(explicit.projectId);
      expect(resolved.groveId).toBe(groveId);
      expect(resolved.machineId).toBe('machine-1');
      expect(resolved.sessionId).toBe('sess-1');
      expect(resolved.projectVaultDir).toBe(vaultDir);
      expect(resolved.databasePath).toBe(resolveGroveDbPath(groveId));
      expect(resolved.source).toBe('headers');
    });
  });

  it('falls back to the daemon vault context when no context headers are present', () => {
    const vaultDir = path.join('/tmp', 'daemon-project', '.myco');
    const resolved = requestContextFromHttpHeaders({}, vaultDir);

    expect(resolved.projectRoot).toBe(path.join('/tmp', 'daemon-project'));
    expect(resolved.source).toBe('legacy-vault');
  });

  it('does not treat legacy headers without a Grove id as registered Grove context', () => {
    const fallbackVaultDir = path.join('/tmp', 'daemon-project', '.myco');
    const legacy = resolveLegacyRequestContext(path.join('/tmp', 'claimed-project', '.myco'), {
      projectId: 'claimed-project',
      machineId: 'machine-a',
      sessionId: 'sess-a',
    });

    const resolved = requestContextFromHttpHeaders(requestContextHeaders(legacy), fallbackVaultDir);

    expect(resolved.projectRoot).toBe(path.join('/tmp', 'daemon-project'));
    expect(resolved.projectId).toBe(path.join('/tmp', 'daemon-project'));
    expect(resolved.groveId).toBeNull();
    expect(resolved.databasePath).toBe(path.join(fallbackVaultDir, 'myco.db'));
    expect(resolved.machineId).toBe('machine-a');
    expect(resolved.sessionId).toBe('sess-a');
    expect(resolved.source).toBe('headers');
  });

  it('resolves explicit CLI environment request context', () => {
    withRegisteredProject(({ projectRoot, vaultDir, groveId, projectId }) => {
      const resolved = requestContextFromEnvironment({
        [REQUEST_CONTEXT_ENV.projectRoot]: projectRoot,
        [REQUEST_CONTEXT_ENV.projectId]: projectId,
        [REQUEST_CONTEXT_ENV.groveId]: groveId,
        [REQUEST_CONTEXT_ENV.machineId]: 'machine-a',
        [REQUEST_CONTEXT_ENV.sessionId]: 'sess-a',
      }, vaultDir);

      expect(resolved.projectRoot).toBe(projectRoot);
      expect(resolved.projectId).toBe(projectId);
      expect(resolved.groveId).toBe(groveId);
      expect(resolved.machineId).toBe('machine-a');
      expect(resolved.sessionId).toBe('sess-a');
      expect(resolved.projectVaultDir).toBe(vaultDir);
      expect(resolved.databasePath).toBe(resolveGroveDbPath(groveId));
      expect(resolved.source).toBe('explicit');
    });
  });

  it('resolves registered project context from project.toml when env is absent', () => {
    withRegisteredProject(({ vaultDir, groveId, projectId }) => {
      const resolved = requestContextFromEnvironment({}, vaultDir);

      expect(resolved.projectId).toBe(projectId);
      expect(resolved.groveId).toBe(groveId);
      expect(resolved.databasePath).toBe(resolveGroveDbPath(groveId));
      expect(resolved.source).toBe('explicit');
    });
  });

  it('rejects spoofed project roots for Grove contexts', () => {
    withRegisteredProject(({ vaultDir, groveId, projectId }) => {
      expect(() => requestContextFromEnvironment({
        [REQUEST_CONTEXT_ENV.projectRoot]: path.join(path.dirname(path.dirname(vaultDir)), 'other-project'),
        [REQUEST_CONTEXT_ENV.projectId]: projectId,
        [REQUEST_CONTEXT_ENV.groveId]: groveId,
      }, vaultDir)).toThrow(/not registered/);
    });
  });

  it('does not emit empty optional headers', () => {
    const context = resolveLegacyRequestContext(path.join('/tmp', 'project', '.myco'), {
      machineId: 'machine-1',
      groveId: null,
      sessionId: null,
    });

    const headers = requestContextHeaders(context);

    expect(headers[REQUEST_CONTEXT_HEADERS.projectRoot]).toBe(path.join('/tmp', 'project'));
    expect(headers[REQUEST_CONTEXT_HEADERS.groveId]).toBeUndefined();
    expect(headers[REQUEST_CONTEXT_HEADERS.sessionId]).toBeUndefined();
  });

  it('maps request contexts to row project scope with legacy compatibility', () => {
    const legacy = resolveLegacyRequestContext(path.join('/tmp', 'project', '.myco'), {
      projectId: 'project-a',
      groveId: null,
    });
    const grove = resolveLegacyRequestContext(path.join('/tmp', 'project', '.myco'), {
      projectId: 'project-a',
      groveId: 'grove-a',
    });

    expect(rowProjectIdFromRequestContext()).toBeUndefined();
    expect(rowProjectIdFromRequestContext(legacy)).toBeNull();
    expect(rowProjectIdFromRequestContext(grove)).toBe('project-a');
  });
});
