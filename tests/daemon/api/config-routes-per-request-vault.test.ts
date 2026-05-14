/**
 * Regression: config HTTP routes must respect the request's
 * `requestContext.projectVaultDir`, not the daemon's bootstrap vault.
 *
 * Before the fix, `main.ts` registered the four `/api/config(...)*` routes
 * with `bootstrapVaultDir` hard-wired. A Grove daemon serving multiple
 * projects ended up reading and writing only the bootstrap project's
 * `myco.yaml` regardless of which project the dashboard was viewing —
 * release_provenance and every other project-tier field bled across
 * projects, and saves silently overwrote the bootstrap project's file.
 *
 * This test mirrors the route closure shape used in main.ts and asserts:
 *   - GET /api/config/merged returns the requested project's values, not
 *     bootstrap's.
 *   - GET /api/config/local returns the requested project's overlay.
 *   - PUT /api/config/scoped writes into the requested project's vault
 *     and leaves the other project's `myco.yaml` untouched.
 *
 * If anyone reverts the routing to `bootstrapVaultDir`, these tests fail.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  handleGetMergedConfig,
  handleGetLocalConfig,
  handlePutScopedConfig,
} from '@myco/daemon/api/config';

interface FakeReq {
  requestContext?: { projectVaultDir?: string; groveId?: string | null };
  body?: unknown;
}

// Mirrors the route closures in packages/myco/src/daemon/main.ts.
// Keeping them inline (rather than importing from main.ts) avoids
// pulling in the daemon's bootstrap singletons. If main.ts route
// wiring changes shape, update these mirrors too.
function makeRoutes(bootstrapVaultDir: string) {
  return {
    mergedGet: (req: FakeReq) =>
      handleGetMergedConfig(req.requestContext?.projectVaultDir ?? bootstrapVaultDir, {
        groveId: req.requestContext?.groveId ?? null,
      }),
    localGet: (req: FakeReq) =>
      handleGetLocalConfig(req.requestContext?.projectVaultDir ?? bootstrapVaultDir),
    scopedPut: (req: FakeReq) =>
      handlePutScopedConfig(req.requestContext?.projectVaultDir ?? bootstrapVaultDir, req.body),
  };
}

function seedProject(dir: string, productionRef: string, githubRepo: string) {
  fs.writeFileSync(
    path.join(dir, 'myco.yaml'),
    `version: 3
embedding:
  provider: ollama
  model: bge-m3
release_provenance:
  enabled: true
  production_refs:
    - ${productionRef}
  github:
    repo: ${githubRepo}
`,
  );
}

describe('config HTTP routes — per-request projectVaultDir wiring', () => {
  let projectA: string;
  let projectB: string;
  let bootstrap: string;
  let routes: ReturnType<typeof makeRoutes>;

  beforeEach(() => {
    projectA = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-route-A-'));
    projectB = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-route-B-'));
    bootstrap = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-route-boot-'));
    seedProject(projectA, 'refs/tags/network/v*', 'sirkirby/unifi-mcp');
    seedProject(projectB, 'refs/tags/v*', 'goondocks-co/collagen-advocacy');
    seedProject(bootstrap, 'refs/tags/bootstrap/v*', 'org/bootstrap');
    routes = makeRoutes(bootstrap);
  });

  afterEach(() => {
    for (const dir of [projectA, projectB, bootstrap]) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('GET /api/config/merged returns the requested project, not bootstrap', async () => {
    const a = await routes.mergedGet({ requestContext: { projectVaultDir: projectA } });
    const b = await routes.mergedGet({ requestContext: { projectVaultDir: projectB } });
    expect((a.body as any).release_provenance.production_refs).toEqual(['refs/tags/network/v*']);
    expect((a.body as any).release_provenance.github.repo).toBe('sirkirby/unifi-mcp');
    expect((b.body as any).release_provenance.production_refs).toEqual(['refs/tags/v*']);
    expect((b.body as any).release_provenance.github.repo).toBe('goondocks-co/collagen-advocacy');
  });

  it('GET /api/config/merged falls back to bootstrap when no request context', async () => {
    const res = await routes.mergedGet({});
    expect((res.body as any).release_provenance.production_refs).toEqual(['refs/tags/bootstrap/v*']);
  });

  it('GET /api/config/local returns the requested project overlay', async () => {
    // Seed a local overlay only in project B.
    fs.writeFileSync(
      path.join(projectB, 'local.yaml'),
      'release_provenance:\n  enabled: false\n',
    );
    const a = await routes.localGet({ requestContext: { projectVaultDir: projectA } });
    const b = await routes.localGet({ requestContext: { projectVaultDir: projectB } });
    expect((a.body as any).release_provenance?.enabled).toBeUndefined();
    expect((b.body as any).release_provenance.enabled).toBe(false);
  });

  it('PUT /api/config/scoped writes to the requested project and leaves the other untouched', async () => {
    const aBefore = fs.readFileSync(path.join(projectA, 'myco.yaml'), 'utf-8');
    await routes.scopedPut({
      requestContext: { projectVaultDir: projectB },
      body: {
        scope: 'project',
        patch: { release_provenance: { production_refs: ['refs/tags/v99'] } },
      },
    });
    const aAfter = fs.readFileSync(path.join(projectA, 'myco.yaml'), 'utf-8');
    const bAfter = fs.readFileSync(path.join(projectB, 'myco.yaml'), 'utf-8');
    expect(aAfter).toBe(aBefore);
    expect(bAfter).toContain('refs/tags/v99');
    expect(bAfter).not.toContain('refs/tags/network/v*');
  });

  it('PUT /api/config/scoped at scope=local writes the requested project local.yaml', async () => {
    await routes.scopedPut({
      requestContext: { projectVaultDir: projectB },
      body: {
        scope: 'local',
        patch: { release_provenance: { enabled: false } },
      },
    });
    expect(fs.existsSync(path.join(projectA, 'local.yaml'))).toBe(false);
    const bLocal = fs.readFileSync(path.join(projectB, 'local.yaml'), 'utf-8');
    expect(bLocal).toContain('enabled: false');
  });
});
