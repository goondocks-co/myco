import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveProjectManifest } from '@myco/config/project-manifest.js';
import { createGrove, registerProjectInGrove } from '@myco/grove/registry.js';
import { assertGroveProjectId, createProjectId, type GroveProjectId } from '@myco/grove/ids.js';
import { resolveGroveDbPath, resolveProjectVaultDir } from '@myco/grove/paths.js';
import {
  REQUEST_CONTEXT_AUTH_HEADER,
  REQUEST_CONTEXT_ENV,
  REQUEST_CONTEXT_HEADERS,
  UnauthorizedRequestContextError,
  requestContextFromEnvironment,
  requestContextFromHttpHeaders,
  requestContextHeaders,
  rowProjectIdFromRequestContext,
  projectScopeFromRequestContext,
  resolveLegacyRequestContext,
} from '@myco/tools/request-context.js';
import { GLOBAL_SCOPE } from '@myco/grove/ids.js';

function withRegisteredProject<T>(fn: (args: {
  home: string;
  projectRoot: string;
  vaultDir: string;
  groveId: string;
  groveSlug: string;
  projectId: GroveProjectId;
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
    const projectId = assertGroveProjectId(createProjectId());
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
    return fn({ home, projectRoot, vaultDir, groveId: grove.id, groveSlug: grove.slug, projectId });
  } finally {
    if (previousHome === undefined) delete process.env.MYCO_HOME;
    else process.env.MYCO_HOME = previousHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

describe('tool request context', () => {
  it('builds a request context from explicit projectId, validating the brand', () => {
    const vaultDir = path.join('/tmp', 'project', '.myco');
    const projectId = assertGroveProjectId(createProjectId());
    const context = resolveLegacyRequestContext(vaultDir, { projectId, machineId: 'machine-1' });

    expect(context.projectRoot).toBe(path.join('/tmp', 'project'));
    expect(context.projectId).toBe(projectId);
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

  it('resolves HTTP Grove context from registry when headers omit project root', () => {
    withRegisteredProject(({ projectRoot, vaultDir, groveId, projectId }) => {
      const resolved = requestContextFromHttpHeaders({
        [REQUEST_CONTEXT_HEADERS.projectId]: projectId,
        [REQUEST_CONTEXT_HEADERS.groveId]: groveId,
        [REQUEST_CONTEXT_HEADERS.machineId]: 'machine-1',
        [REQUEST_CONTEXT_HEADERS.sessionId]: 'sess-1',
      }, vaultDir);

      expect(resolved.projectRoot).toBe(projectRoot);
      expect(resolved.projectId).toBe(projectId);
      expect(resolved.groveId).toBe(groveId);
      expect(resolved.machineId).toBe('machine-1');
      expect(resolved.sessionId).toBe('sess-1');
      expect(resolved.projectVaultDir).toBe(vaultDir);
      expect(resolved.databasePath).toBe(resolveGroveDbPath(groveId));
      expect(resolved.source).toBe('headers');
    });
  });

  it('resolves HTTP Grove context from project.toml headers when headers omit Grove id', () => {
    withRegisteredProject(({ home, projectRoot, vaultDir, groveId, groveSlug, projectId }) => {
      const fallbackRoot = path.join(path.dirname(projectRoot), 'fallback-project');
      const fallbackVaultDir = resolveProjectVaultDir(fallbackRoot);
      const fallbackProjectId = assertGroveProjectId(createProjectId());
      fs.mkdirSync(fallbackVaultDir, { recursive: true });
      saveProjectManifest(fallbackVaultDir, {
        project: { id: fallbackProjectId, name: 'Fallback Project' },
        grove: { binding_id: 'gbind-b', slug: groveSlug, mode: 'local' },
      });
      registerProjectInGrove(groveId, {
        projectId: fallbackProjectId,
        projectName: 'Fallback Project',
        projectRoot: fallbackRoot,
        bindingId: 'gbind-b',
      }, home);

      const resolved = requestContextFromHttpHeaders({
        [REQUEST_CONTEXT_HEADERS.projectRoot]: projectRoot,
        [REQUEST_CONTEXT_HEADERS.projectId]: projectId,
        [REQUEST_CONTEXT_HEADERS.sessionId]: 'sess-http',
      }, fallbackVaultDir);

      expect(resolved.projectRoot).toBe(projectRoot);
      expect(resolved.projectId).toBe(projectId);
      expect(resolved.groveId).toBe(groveId);
      expect(resolved.sessionId).toBe('sess-http');
      expect(resolved.projectVaultDir).toBe(vaultDir);
      expect(resolved.databasePath).toBe(resolveGroveDbPath(groveId));
      expect(resolved.source).toBe('headers');
    });
  });

  it('falls back to the daemon vault manifest when no context headers are present', () => {
    withRegisteredProject(({ projectRoot, vaultDir, projectId }) => {
      const resolved = requestContextFromHttpHeaders({}, vaultDir);

      expect(resolved.projectRoot).toBe(projectRoot);
      expect(resolved.projectId).toBe(projectId);
    });
  });

  it('throws when neither headers nor a Grove manifest provide a project id', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-no-grove-'));
    try {
      const vaultDir = path.join(tmp, '.myco');
      fs.mkdirSync(vaultDir, { recursive: true });
      expect(() => requestContextFromHttpHeaders({}, vaultDir)).toThrow(/No Grove project id available/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('preserves a header-supplied non-Grove context with a branded project id', () => {
    withRegisteredProject(({ vaultDir, projectId }) => {
      const fallbackVaultDir = vaultDir;
      const claimedProjectId = assertGroveProjectId(createProjectId());
      const legacy = resolveLegacyRequestContext(path.join('/tmp', 'claimed-project', '.myco'), {
        projectId: claimedProjectId,
        machineId: 'machine-a',
        sessionId: 'sess-a',
      });

      const resolved = requestContextFromHttpHeaders(requestContextHeaders(legacy), fallbackVaultDir);

      // No Grove id in headers, so we keep the daemon-side fallback project context.
      expect(resolved.projectId).toBe(projectId);
      expect(resolved.groveId).toBeNull();
      expect(resolved.machineId).toBe('machine-a');
      expect(resolved.sessionId).toBe('sess-a');
      expect(resolved.source).toBe('headers');
    });
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
    const projectId = assertGroveProjectId(createProjectId());
    const context = resolveLegacyRequestContext(path.join('/tmp', 'project', '.myco'), {
      projectId,
      machineId: 'machine-1',
      groveId: null,
      sessionId: null,
    });

    const headers = requestContextHeaders(context);

    expect(headers[REQUEST_CONTEXT_HEADERS.projectRoot]).toBe(path.join('/tmp', 'project'));
    expect(headers[REQUEST_CONTEXT_HEADERS.groveId]).toBeUndefined();
    expect(headers[REQUEST_CONTEXT_HEADERS.sessionId]).toBeUndefined();
  });

  it('maps request contexts to row project scope: NULL for non-Grove, projectId for Grove', () => {
    const projectId = assertGroveProjectId(createProjectId());
    const nonGrove = resolveLegacyRequestContext(path.join('/tmp', 'project', '.myco'), {
      projectId,
      groveId: null,
    });
    const grove = resolveLegacyRequestContext(path.join('/tmp', 'project', '.myco'), {
      projectId,
      groveId: 'grove-a',
    });

    expect(rowProjectIdFromRequestContext()).toBeUndefined();
    expect(rowProjectIdFromRequestContext(nonGrove)).toBeNull();
    expect(rowProjectIdFromRequestContext(grove)).toBe(projectId);
  });

  it('rejects a path-string project id at the brand boundary', () => {
    expect(() => resolveLegacyRequestContext(path.join('/tmp', 'p', '.myco'), {
      // @ts-expect-error — exercising the runtime brand check on bad input
      projectId: '/tmp/p',
    })).toThrow(/Grove project id/);
  });

  // Direct branch coverage for projectScopeFromRequestContext. The
  // wider request-context tests focus on rowProjectIdFromRequestContext
  // (the ID extractor) but the SCOPE shape is what the read-side
  // queries actually consume. Three branches:
  //   - Grove-bound context  → { kind: 'project', id }
  //   - Legacy non-Grove ctx → GLOBAL_SCOPE (kind: 'global')
  //   - Missing context      → throws (D5 strictness gate)
  describe('projectScopeFromRequestContext', () => {
    it('throws when no context is supplied (D5 strictness gate)', () => {
      // Post-D5: missing context is a programming error, not a silent
      // widen to {kind:'all'}. Production middleware always supplies
      // a request context; this assertion locks the new contract.
      expect(() => projectScopeFromRequestContext()).toThrow();
      expect(() => projectScopeFromRequestContext(undefined)).toThrow();
    });

    it('returns GLOBAL_SCOPE for legacy non-Grove contexts', () => {
      const projectId = assertGroveProjectId(createProjectId());
      const legacy = resolveLegacyRequestContext(path.join('/tmp', 'p', '.myco'), {
        projectId,
        groveId: null,
      });
      const scope = projectScopeFromRequestContext(legacy);
      expect(scope).toBe(GLOBAL_SCOPE);
      expect(scope.kind).toBe('global');
    });

    it('scopes Grove-bound contexts to their project id', () => {
      const projectId = assertGroveProjectId(createProjectId());
      const grove = resolveLegacyRequestContext(path.join('/tmp', 'p', '.myco'), {
        projectId,
        groveId: 'grove-a',
      });
      const scope = projectScopeFromRequestContext(grove);
      expect(scope).toEqual({ kind: 'project', id: projectId });
    });
  });

  describe('context-switch auth gate (G4)', () => {
    const TOKEN = 'a'.repeat(64);

    it('rejects context-switching headers without the auth bearer', () => {
      withRegisteredProject(({ vaultDir, groveId, projectId }) => {
        expect(() => requestContextFromHttpHeaders({
          [REQUEST_CONTEXT_HEADERS.projectId]: projectId,
          [REQUEST_CONTEXT_HEADERS.groveId]: groveId,
        }, vaultDir, { expectedAuthToken: TOKEN })).toThrow(UnauthorizedRequestContextError);
      });
    });

    it('rejects context-switching headers with the wrong auth bearer', () => {
      withRegisteredProject(({ vaultDir, groveId, projectId }) => {
        expect(() => requestContextFromHttpHeaders({
          [REQUEST_CONTEXT_HEADERS.projectId]: projectId,
          [REQUEST_CONTEXT_HEADERS.groveId]: groveId,
          [REQUEST_CONTEXT_AUTH_HEADER]: 'wrong-token',
        }, vaultDir, { expectedAuthToken: TOKEN })).toThrow(UnauthorizedRequestContextError);
      });
    });

    it('accepts context-switching headers when the auth bearer matches', () => {
      withRegisteredProject(({ vaultDir, groveId, projectId }) => {
        const resolved = requestContextFromHttpHeaders({
          [REQUEST_CONTEXT_HEADERS.projectId]: projectId,
          [REQUEST_CONTEXT_HEADERS.groveId]: groveId,
          [REQUEST_CONTEXT_AUTH_HEADER]: TOKEN,
        }, vaultDir, { expectedAuthToken: TOKEN });
        expect(resolved.projectId).toBe(projectId);
        expect(resolved.groveId).toBe(groveId);
      });
    });

    it('lets requests through without context-switching headers regardless of token', () => {
      withRegisteredProject(({ vaultDir }) => {
        // No project/grove headers → no auth gate. Legacy callers
        // still work even when a token is configured.
        const resolved = requestContextFromHttpHeaders({}, vaultDir, { expectedAuthToken: TOKEN });
        expect(resolved.source).toBe('headers');
      });
    });

    it('allows context-switching headers when no token is configured (legacy / unit tests)', () => {
      withRegisteredProject(({ vaultDir, groveId, projectId }) => {
        // No expectedAuthToken → gate is a no-op (preserves
        // backwards compatibility for tests / pre-G4 daemons).
        const resolved = requestContextFromHttpHeaders({
          [REQUEST_CONTEXT_HEADERS.projectId]: projectId,
          [REQUEST_CONTEXT_HEADERS.groveId]: groveId,
        }, vaultDir);
        expect(resolved.projectId).toBe(projectId);
      });
    });
  });
});
