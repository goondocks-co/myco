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
  filesystemRootFromRequestContext,
  isCallerTenancy,
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

  // Timeout bumped from the bun default (5s) to 15s — the test does
  // 4+ filesystem writes via `withRegisteredProject` (createGrove,
  // saveProjectManifest, registerProjectInGrove, project.toml,
  // mkdtempSync) AND a fallback resolve that walks `listGroves`.
  // In isolation it completes in well under a second; under load in
  // the shared `tests-tools` bundle on macOS APFS the parallel
  // mkdtemp/rmSync traffic intermittently pushes it past 5s. The
  // workload is real IO, not a logic hang, so widening the budget
  // is the correct fix.
  it('falls back to the daemon vault manifest when no context headers are present', () => {
    withRegisteredProject(({ projectRoot, vaultDir, projectId }) => {
      const resolved = requestContextFromHttpHeaders({}, vaultDir);

      expect(resolved.projectRoot).toBe(projectRoot);
      expect(resolved.projectId).toBe(projectId);
    });
  }, 15000);

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

  describe('callerRoot — caller cwd for worktree-local filesystem ops', () => {
    it('preserves callerRoot from MYCO_CALLER_ROOT env var through Grove resolution', () => {
      withRegisteredProject(({ projectRoot, vaultDir, groveId, projectId }) => {
        const worktreeRoot = path.join(projectRoot, '..', 'worktrees', 'feature-x');
        const resolved = requestContextFromEnvironment({
          [REQUEST_CONTEXT_ENV.projectId]: projectId,
          [REQUEST_CONTEXT_ENV.groveId]: groveId,
          [REQUEST_CONTEXT_ENV.callerRoot]: worktreeRoot,
        }, vaultDir);

        expect(resolved.projectRoot).toBe(projectRoot);
        expect(resolved.callerRoot).toBe(path.resolve(worktreeRoot));
      });
    });

    it('preserves callerRoot from x-myco-caller-root HTTP header through Grove resolution', () => {
      withRegisteredProject(({ projectRoot, vaultDir, groveId, projectId }) => {
        const worktreeRoot = path.join(projectRoot, '..', 'worktrees', 'feature-x');
        const resolved = requestContextFromHttpHeaders({
          [REQUEST_CONTEXT_HEADERS.projectId]: projectId,
          [REQUEST_CONTEXT_HEADERS.groveId]: groveId,
          [REQUEST_CONTEXT_HEADERS.callerRoot]: worktreeRoot,
        }, vaultDir);

        expect(resolved.projectRoot).toBe(projectRoot);
        expect(resolved.callerRoot).toBe(path.resolve(worktreeRoot));
      });
    });

    it('leaves callerRoot null when no caller-root header or env is present', () => {
      withRegisteredProject(({ vaultDir, groveId, projectId }) => {
        const fromEnv = requestContextFromEnvironment({
          [REQUEST_CONTEXT_ENV.projectId]: projectId,
          [REQUEST_CONTEXT_ENV.groveId]: groveId,
        }, vaultDir);
        const fromHeaders = requestContextFromHttpHeaders({
          [REQUEST_CONTEXT_HEADERS.projectId]: projectId,
          [REQUEST_CONTEXT_HEADERS.groveId]: groveId,
        }, vaultDir);

        expect(fromEnv.callerRoot).toBeNull();
        expect(fromHeaders.callerRoot).toBeNull();
      });
    });

    it('round-trips callerRoot through requestContextHeaders', () => {
      const projectId = assertGroveProjectId(createProjectId());
      const context = resolveLegacyRequestContext(path.join('/tmp', 'project', '.myco'), {
        projectId,
        callerRoot: path.join('/tmp', 'worktrees', 'feature-y'),
      });

      const headers = requestContextHeaders(context);

      expect(headers[REQUEST_CONTEXT_HEADERS.callerRoot]).toBe(path.join('/tmp', 'worktrees', 'feature-y'));
    });

    it('does not emit x-myco-caller-root when callerRoot is null', () => {
      const projectId = assertGroveProjectId(createProjectId());
      const context = resolveLegacyRequestContext(path.join('/tmp', 'project', '.myco'), { projectId });

      const headers = requestContextHeaders(context);

      expect(headers[REQUEST_CONTEXT_HEADERS.callerRoot]).toBeUndefined();
    });

    it('uses projectRoot as the live filesystem root when callerRoot is absent', () => {
      const projectId = assertGroveProjectId(createProjectId());
      const projectRoot = path.join('/tmp', 'project');
      const context = resolveLegacyRequestContext(path.join(projectRoot, '.myco'), {
        projectId,
        projectRoot,
      });

      expect(filesystemRootFromRequestContext(context)).toBe(path.resolve(projectRoot));
    });

    it('uses callerRoot as the live filesystem root without changing registered projectRoot', () => {
      const projectId = assertGroveProjectId(createProjectId());
      const projectRoot = path.join('/tmp', 'project');
      const worktreeRoot = path.join('/tmp', 'worktrees', 'feature-y');
      const context = resolveLegacyRequestContext(path.join(projectRoot, '.myco'), {
        projectId,
        projectRoot,
        callerRoot: worktreeRoot,
      });

      expect(context.projectRoot).toBe(path.resolve(projectRoot));
      expect(filesystemRootFromRequestContext(context)).toBe(worktreeRoot);
    });
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
  // queries actually consume. The seam enforces tenancy provenance:
  //   - Caller + Grove-bound   → { kind: 'project', id }
  //   - Caller + non-Grove ctx → GLOBAL_SCOPE (kind: 'global')
  //   - Synthesized (any)      → GLOBAL_SCOPE even with a groveId
  //   - Missing context        → throws (D5 strictness gate)
  describe('projectScopeFromRequestContext', () => {
    it('throws when no context is supplied (D5 strictness gate)', () => {
      // Post-D5: missing context is a programming error, not a silent
      // widen to {kind:'all'}. Production middleware always supplies
      // a request context; this assertion locks the new contract.
      expect(() => projectScopeFromRequestContext()).toThrow();
      expect(() => projectScopeFromRequestContext(undefined)).toThrow();
    });

    it('returns GLOBAL_SCOPE for legacy non-Grove caller contexts', () => {
      const projectId = assertGroveProjectId(createProjectId());
      const legacy = resolveLegacyRequestContext(path.join('/tmp', 'p', '.myco'), {
        projectId,
        groveId: null,
        tenancySource: 'caller',
      });
      const scope = projectScopeFromRequestContext(legacy);
      expect(scope).toBe(GLOBAL_SCOPE);
      expect(scope.kind).toBe('global');
    });

    it('scopes caller-supplied Grove-bound contexts to their project id', () => {
      const projectId = assertGroveProjectId(createProjectId());
      const grove = resolveLegacyRequestContext(path.join('/tmp', 'p', '.myco'), {
        projectId,
        groveId: 'grove-a',
        tenancySource: 'caller',
      });
      const scope = projectScopeFromRequestContext(grove);
      expect(scope).toEqual({ kind: 'project', id: projectId });
    });

    it('returns GLOBAL_SCOPE for a synthesized context EVEN WITH a groveId (no anchor leak)', () => {
      // #2: the seam enforces provenance. A synthesized context carries the
      // daemon's bootstrap-anchor project/grove id; binding it to
      // projectScope(anchorId) would leak the anchor's rows to an
      // unauthorized request. It must resolve to GLOBAL_SCOPE
      // (project_id IS NULL → zero cross-project rows) regardless of groveId.
      const projectId = assertGroveProjectId(createProjectId());
      const synthesized = resolveLegacyRequestContext(path.join('/tmp', 'p', '.myco'), {
        projectId,
        groveId: 'grove-anchor',
        tenancySource: 'synthesized',
      });
      const scope = projectScopeFromRequestContext(synthesized);
      expect(scope).toBe(GLOBAL_SCOPE);
      expect(scope.kind).toBe('global');
    });
  });

  describe('tenancySource — caller vs synthesized provenance', () => {
    it('tags HTTP context as caller when explicit project/grove headers are supplied', () => {
      withRegisteredProject(({ vaultDir, groveId, projectId }) => {
        const resolved = requestContextFromHttpHeaders({
          [REQUEST_CONTEXT_HEADERS.projectId]: projectId,
          [REQUEST_CONTEXT_HEADERS.groveId]: groveId,
        }, vaultDir);

        expect(resolved.tenancySource).toBe('caller');
      });
    });

    it('tags HTTP context as caller when explicit headers pass the auth gate', () => {
      const TOKEN = 'a'.repeat(64);
      withRegisteredProject(({ vaultDir, groveId, projectId }) => {
        const resolved = requestContextFromHttpHeaders({
          [REQUEST_CONTEXT_HEADERS.projectId]: projectId,
          [REQUEST_CONTEXT_HEADERS.groveId]: groveId,
          [REQUEST_CONTEXT_AUTH_HEADER]: TOKEN,
        }, vaultDir, { expectedAuthToken: TOKEN });

        expect(resolved.tenancySource).toBe('caller');
      });
    });

    it('tags HTTP context as synthesized when no project/grove headers are present', () => {
      withRegisteredProject(({ vaultDir }) => {
        const resolved = requestContextFromHttpHeaders({}, vaultDir);

        expect(resolved.tenancySource).toBe('synthesized');
      });
    });

    it('tags env context as caller when MYCO_PROJECT_ID / MYCO_GROVE_ID are set', () => {
      withRegisteredProject(({ projectRoot, vaultDir, groveId, projectId }) => {
        const resolved = requestContextFromEnvironment({
          [REQUEST_CONTEXT_ENV.projectRoot]: projectRoot,
          [REQUEST_CONTEXT_ENV.projectId]: projectId,
          [REQUEST_CONTEXT_ENV.groveId]: groveId,
        }, vaultDir);

        expect(resolved.tenancySource).toBe('caller');
      });
    });

    it('tags env context as synthesized when no project/grove env is set', () => {
      withRegisteredProject(({ vaultDir }) => {
        const resolved = requestContextFromEnvironment({}, vaultDir);

        expect(resolved.tenancySource).toBe('synthesized');
      });
    });

    it('survives transport: a caller context re-parsed from its headers stays caller', () => {
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

        expect(resolved.tenancySource).toBe('caller');
      });
    });

    // #4a regression: a caller that pivots by PROJECT ROOT only
    // (x-myco-project-root, no project-id/grove-id) resolves a real
    // registered project from its project.toml — that IS a caller assertion
    // of "act against THIS project". It must be tagged 'caller' (not
    // 'synthesized'), or the tenancy gates reject a legitimate pivot.
    it('tags an HTTP projectRoot-only context as caller (regression #4a)', () => {
      withRegisteredProject(({ projectRoot, vaultDir, groveId, projectId }) => {
        // Resolve against a DIFFERENT fallback vault so the projectRoot header
        // is the only thing pointing at this project — proving the root, not
        // the fallback, drives the caller stamp.
        const otherRoot = path.join(path.dirname(projectRoot), 'other-fallback');
        const otherVaultDir = resolveProjectVaultDir(otherRoot);
        fs.mkdirSync(otherVaultDir, { recursive: true });
        saveProjectManifest(otherVaultDir, {
          project: { id: assertGroveProjectId(createProjectId()), name: 'Other Fallback' },
        });

        const resolved = requestContextFromHttpHeaders({
          [REQUEST_CONTEXT_HEADERS.projectRoot]: projectRoot,
        }, otherVaultDir);

        // The projectRoot header resolved the real registered project AND was
        // stamped caller — both halves of the regression fix.
        expect(resolved.projectId).toBe(projectId);
        expect(resolved.groveId).toBe(groveId);
        expect(resolved.tenancySource).toBe('caller');
      });
    });

    // #4b: a context whose project/grove id came from the SERVER's
    // fallback-root manifest (no caller-supplied root, project-id, or grove-id)
    // must STAY synthesized — even though it back-fills a real groveId.
    it('keeps a server-fallback-derived (grove-only-via-server-root) context synthesized (#4b)', () => {
      withRegisteredProject(({ vaultDir, groveId }) => {
        // No context headers at all → the resolver back-fills project/grove
        // from the SERVER's anchor manifest. That id is the daemon's, not the
        // caller's assertion, so it must remain synthesized.
        const resolved = requestContextFromHttpHeaders({}, vaultDir);

        expect(resolved.groveId).toBe(groveId);
        expect(resolved.tenancySource).toBe('synthesized');
      });
    });
  });

  // #7: the single shared caller-tenancy predicate. The three tenancy gates
  // (request-principal resolver, tools-runtime guard, MCP-HTTP pre-flight) all
  // decide caller-vs-synthesized through this one function.
  describe('isCallerTenancy (shared predicate, #7)', () => {
    it('returns true only for tenancySource === "caller"', () => {
      expect(isCallerTenancy({ tenancySource: 'caller' })).toBe(true);
    });

    it('returns false for a synthesized context', () => {
      expect(isCallerTenancy({ tenancySource: 'synthesized' })).toBe(false);
    });

    it('returns false for undefined / an unmarked context', () => {
      expect(isCallerTenancy(undefined)).toBe(false);
      expect(isCallerTenancy({})).toBe(false);
    });

    it('agrees with the seam: caller→project scope, synthesized→GLOBAL_SCOPE', () => {
      const projectId = assertGroveProjectId(createProjectId());
      const caller = resolveLegacyRequestContext(path.join('/tmp', 'p', '.myco'), {
        projectId,
        groveId: 'grove-a',
        tenancySource: 'caller',
      });
      const synthesized = resolveLegacyRequestContext(path.join('/tmp', 'p', '.myco'), {
        projectId,
        groveId: 'grove-a',
        tenancySource: 'synthesized',
      });

      expect(isCallerTenancy(caller)).toBe(true);
      expect(projectScopeFromRequestContext(caller)).toEqual({ kind: 'project', id: projectId });
      expect(isCallerTenancy(synthesized)).toBe(false);
      expect(projectScopeFromRequestContext(synthesized)).toBe(GLOBAL_SCOPE);
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
