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
 * This test exercises `registerConfigRoutes` — the helper the daemon
 * uses to register the four routes — through a fake server, so a future
 * regression that re-hard-wires `bootstrapVaultDir` fails here.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  registerConfigRoutes,
  type ConfigRouteServer,
} from '@myco/daemon/api/register-config-routes';
import type { RouteRequest } from '@myco/daemon/router';

interface FakeReq {
  requestContext?: { projectVaultDir?: string; groveId?: string | null };
  body?: unknown;
}

interface RegisteredRoute {
  method: string;
  path: string;
  handler: (req: RouteRequest) => Promise<unknown>;
}

function makeFakeServer() {
  const routes: RegisteredRoute[] = [];
  const server: ConfigRouteServer = {
    registerRoute(method, routePath, handler) {
      routes.push({ method, path: routePath, handler });
    },
  };
  function call(method: string, routePath: string, req: FakeReq) {
    const route = routes.find((r) => r.method === method && r.path === routePath);
    if (!route) throw new Error(`No route registered for ${method} ${routePath}`);
    return route.handler(req as unknown as RouteRequest);
  }
  return { server, call };
}

function makeRoutes(bootstrapVaultDir: string, onScopedWrite?: (params: {
  request: RouteRequest;
  body: { scope: 'project' | 'local'; patch?: unknown; clear?: string[] };
  vaultDir: string;
  groveId: string | null;
}) => void | Promise<void>) {
  const fake = makeFakeServer();
  registerConfigRoutes(fake.server, {
    bootstrapVaultDir,
    bootGroveId: null,
    onScopedWrite,
  });
  return {
    mergedGet: (req: FakeReq) => fake.call('GET', '/api/config/merged', req),
    localGet: (req: FakeReq) => fake.call('GET', '/api/config/local', req),
    scopedPut: (req: FakeReq) => fake.call('PUT', '/api/config/scoped', req),
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

describe('registerConfigRoutes — per-request projectVaultDir wiring', () => {
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

  it('PUT /api/config/scoped fires onScopedWrite with the request-scoped vault + grove', async () => {
    const writes: Array<{ vaultDir: string; groveId: string | null }> = [];
    const fake = makeFakeServer();
    registerConfigRoutes(fake.server, {
      bootstrapVaultDir: bootstrap,
      bootGroveId: 'grove_boot',
      onScopedWrite: ({ vaultDir, groveId }) => { writes.push({ vaultDir, groveId }); },
    });
    await fake.call('PUT', '/api/config/scoped', {
      requestContext: { projectVaultDir: projectB, groveId: 'grove_b' },
      body: {
        scope: 'project',
        patch: { release_provenance: { production_refs: ['refs/tags/v9'] } },
      },
    });
    // Also confirm fallback to bootstrap+bootGrove when no request context.
    await fake.call('PUT', '/api/config/scoped', {
      body: {
        scope: 'project',
        patch: { release_provenance: { production_refs: ['refs/tags/v10'] } },
      },
    });
    expect(writes).toEqual([
      { vaultDir: projectB, groveId: 'grove_b' },
      { vaultDir: bootstrap, groveId: 'grove_boot' },
    ]);
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
