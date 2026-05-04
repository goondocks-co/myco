import { describe, expect, it } from 'bun:test';
import path from 'node:path';
import {
  REQUEST_CONTEXT_ENV,
  REQUEST_CONTEXT_HEADERS,
  requestContextFromEnvironment,
  requestContextFromHttpHeaders,
  requestContextHeaders,
  rowProjectIdFromRequestContext,
  resolveLegacyRequestContext,
} from '@myco/tools/request-context.js';

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
    const fallbackVaultDir = path.join('/tmp', 'fallback', '.myco');
    const explicit = resolveLegacyRequestContext(path.join('/tmp', 'project', '.myco'), {
      groveId: 'grove_1',
      machineId: 'machine-1',
      sessionId: 'sess-1',
      source: 'explicit',
    });

    const resolved = requestContextFromHttpHeaders(requestContextHeaders(explicit), fallbackVaultDir);

    expect(resolved.projectRoot).toBe(explicit.projectRoot);
    expect(resolved.projectId).toBe(explicit.projectId);
    expect(resolved.groveId).toBe('grove_1');
    expect(resolved.machineId).toBe('machine-1');
    expect(resolved.sessionId).toBe('sess-1');
    expect(resolved.projectVaultDir).toBe(path.join('/tmp', 'project', '.myco'));
    expect(resolved.databasePath).toBe(path.join('/tmp', 'project', '.myco', 'myco.db'));
    expect(resolved.source).toBe('headers');
  });

  it('falls back to the daemon vault context when no context headers are present', () => {
    const vaultDir = path.join('/tmp', 'daemon-project', '.myco');
    const resolved = requestContextFromHttpHeaders({}, vaultDir);

    expect(resolved.projectRoot).toBe(path.join('/tmp', 'daemon-project'));
    expect(resolved.source).toBe('legacy-vault');
  });

  it('resolves explicit CLI environment request context', () => {
    const fallbackVaultDir = path.join('/tmp', 'fallback', '.myco');
    const projectRoot = path.join('/tmp', 'env-project');
    const resolved = requestContextFromEnvironment({
      [REQUEST_CONTEXT_ENV.projectRoot]: projectRoot,
      [REQUEST_CONTEXT_ENV.projectId]: 'project-a',
      [REQUEST_CONTEXT_ENV.groveId]: 'grove-a',
      [REQUEST_CONTEXT_ENV.machineId]: 'machine-a',
      [REQUEST_CONTEXT_ENV.sessionId]: 'sess-a',
    }, fallbackVaultDir);

    expect(resolved.projectRoot).toBe(projectRoot);
    expect(resolved.projectId).toBe('project-a');
    expect(resolved.groveId).toBe('grove-a');
    expect(resolved.machineId).toBe('machine-a');
    expect(resolved.sessionId).toBe('sess-a');
    expect(resolved.projectVaultDir).toBe(path.join(projectRoot, '.myco'));
    expect(resolved.databasePath).toBe(path.join(projectRoot, '.myco', 'myco.db'));
    expect(resolved.source).toBe('explicit');
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
