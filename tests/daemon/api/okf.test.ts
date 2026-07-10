/**
 * OKF daemon API handlers over the DB-resident wiki — real store, real rows,
 * no capability stubs: seeds content through OkfStore (the same single writer
 * the handlers use) and asserts the HTTP envelopes.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RouteRequest } from '@myco/daemon/router';
import { resolveLegacyRequestContext, type MycoRequestContext } from '@myco/grove/request-context';
import { assertGroveProjectId, projectScope, type GroveProjectId } from '@myco/grove/ids';
import type { RequestPrincipal } from '@myco/daemon/request-principal';
import { openDatabase, withDatabase, closeDatabase, initDatabase } from '@myco/db/client.js';
import { createSchema } from '@myco/db/schema.js';
import { saveProjectManifest } from '@myco/config/project-manifest.js';
import { createGrove, registerProjectInGrove } from '@myco/grove/registry.js';
import { resolveGroveDbPath } from '@myco/grove/paths.js';
import { MycoConfigSchema } from '@myco/config/schema.js';
import { OkfStore } from '@myco/okf/store.js';
import { vi } from '../../helpers/vi-shim.js';
import {
  handleOkfAcknowledge,
  handleOkfStatus,
  handleOkfValidate,
  handleOkfPagesList,
  handleOkfPageGet,
  handleOkfConceptSave,
  handleOkfConceptSupersede,
} from '@myco/daemon/api/okf.js';

const PROJECT_ID = 'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const AGENT_BODY = 'Page body for the API test.';

let rootDir: string;
let projectRoot: string;
let vaultDir: string;
let groveId: string;
let groveDbPath: string;
let ctx: MycoRequestContext;

function principal(): RequestPrincipal {
  return {
    identity: { machineId: ctx.machineId, userId: null },
    tenancy: {
      projectVaultDir: ctx.projectVaultDir as RequestPrincipal['tenancy']['projectVaultDir'],
      projectId: ctx.projectId,
      groveId: ctx.groveId ?? '',
      requestContext: { projectVaultDir: ctx.projectVaultDir, projectId: ctx.projectId, groveId: ctx.groveId ?? '' },
    },
  } as RequestPrincipal;
}

function req(overrides: Partial<RouteRequest> = {}): RouteRequest {
  return { params: {}, query: {}, body: undefined, pathname: '/api/okf', ...overrides } as RouteRequest;
}

function store(): OkfStore {
  return new OkfStore({
    scope: projectScope(PROJECT_ID as GroveProjectId),
    projectId: PROJECT_ID,
    machineId: 'test-machine',
    config: MycoConfigSchema.parse({ version: 3, okf: { enabled: true } }),
  });
}

/** Publish one page through the store (the wiki's canonical write path). */
function publishPage(pagePath = 'concepts/alpha', body = AGENT_BODY): void {
  const s = store();
  const draft = s.createDraftGeneration({
    runId: 'r1',
    plan: {
      generatedAt: '2026-07-08T12:00:00Z',
      sinceRef: '',
      pages: [{ path: pagePath, type: 'concept', title: 'Alpha', rationale: 'x', sourceRefs: [] }],
    },
  });
  s.writePage({ path: pagePath, type: 'concept', title: 'Alpha', description: 'About alpha.', body });
  s.finalizeGeneration(draft.id);
}

beforeEach(() => {
  rootDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'okf-api-')));
  const home = path.join(rootDir, 'home');
  projectRoot = path.join(rootDir, 'project');
  vaultDir = path.join(projectRoot, '.myco');
  fs.mkdirSync(vaultDir, { recursive: true });
  vi.stubEnv('MYCO_HOME', home);
  fs.writeFileSync(path.join(vaultDir, 'myco.yaml'), 'version: 3\nokf:\n  enabled: true\n');

  const grove = createGrove('Work', home);
  groveId = grove.id;
  saveProjectManifest(vaultDir, {
    project: { id: PROJECT_ID, name: 'okf-api' },
    grove: { binding_id: 'g', slug: grove.slug, mode: 'local' },
  });
  registerProjectInGrove(grove.id, { projectId: PROJECT_ID, projectName: 'okf-api', projectRoot, bindingId: 'g' }, home);
  groveDbPath = resolveGroveDbPath(grove.id, home);
  fs.mkdirSync(path.dirname(groveDbPath), { recursive: true });
  const db = openDatabase(groveDbPath);
  createSchema(db);
  withDatabase(db, () => {});
  db.close();
  initDatabase(groveDbPath);

  ctx = resolveLegacyRequestContext(vaultDir, {
    projectId: assertGroveProjectId(PROJECT_ID),
    groveId: grove.id,
    machineId: 'test-machine',
    tenancySource: 'caller',
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  closeDatabase();
  fs.rmSync(rootDir, { recursive: true, force: true });
});

describe('OKF API — status', () => {
  it('reports an empty wiki with no generation and eligibility ok', async () => {
    const res = await handleOkfStatus(req(), principal());
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body.bundleExists).toBe(false);
    expect(body.claimedBundleExists).toBe(false);
    expect(body.bundleGeneration).toBeNull();
    expect((body.publishEligibility as { ok: boolean }).ok).toBe(true);
  });

  it('reports a published wiki with generation, counts, and row validation', async () => {
    publishPage();
    const res = await handleOkfStatus(req(), principal());
    const body = res.body as Record<string, unknown>;
    expect(body.bundleExists).toBe(true);
    expect(body.bundleGeneration).toBe(1);
    expect(body.pageCount).toBe(1);
    expect((body.byType as Record<string, number>).concept).toBe(1);
    expect((body.validation as { ok: boolean }).ok).toBe(true);
    expect(body.lastResult).toBe('published');
  });

  it('claimedBundleExists reflects an on-disk materialized bundle', async () => {
    publishPage();
    fs.mkdirSync(path.join(projectRoot, 'okf'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'okf', 'index.md'), '# Index\n');
    const res = await handleOkfStatus(req(), principal());
    expect((res.body as Record<string, unknown>).claimedBundleExists).toBe(true);
  });

  it('surfaces a blocked latest generation as the publish-block with findings', async () => {
    publishPage('concepts/leaky', 'token ghp_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8 here');
    const res = await handleOkfStatus(req(), principal());
    const body = res.body as Record<string, unknown>;
    expect(body.lastResult).toBe('blocked');
    expect(body.publishAcknowledged).toBe(false);
    const eligibility = body.publishEligibility as { ok: boolean; findings: Array<{ code: string }> };
    expect(eligibility.ok).toBe(false);
    expect(eligibility.findings.some((f) => f.code === 'likely_secret')).toBe(true);
  });
});

describe('OKF API — acknowledge', () => {
  it('publishes the blocked generation and reports it', async () => {
    publishPage('concepts/leaky', 'token ghp_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8 here');
    const res = await handleOkfAcknowledge(req(), principal());
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body.published).toBe(true);
    expect(body.generation).toBe(1);

    const after = await handleOkfStatus(req(), principal());
    expect((after.body as Record<string, unknown>).lastResult).toBe('published');
  });

  it('is a no-op when nothing is blocked', async () => {
    const res = await handleOkfAcknowledge(req(), principal());
    expect((res.body as Record<string, unknown>).published).toBe(false);
  });
});

describe('OKF API — pages', () => {
  it('lists page heads with OKF fields', async () => {
    publishPage();
    const res = await handleOkfPagesList(req(), principal());
    const pages = (res.body as { pages: Array<Record<string, unknown>> }).pages;
    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatchObject({ path: 'concepts/alpha.md', type: 'concept', title: 'Alpha' });
  });

  it('gets one page flattened with its body; null for a missing page', async () => {
    publishPage();
    const got = await handleOkfPageGet(req({ pathname: `/api/okf/pages/${encodeURIComponent('concepts/alpha')}` }), principal());
    const page = (got.body as { page: Record<string, unknown> }).page;
    expect(page).toMatchObject({ path: 'concepts/alpha.md', type: 'concept', body: AGENT_BODY });

    const missing = await handleOkfPageGet(req({ pathname: `/api/okf/pages/${encodeURIComponent('concepts/nope')}` }), principal());
    expect((missing.body as { page: unknown }).page).toBeNull();
  });
});

describe('OKF API — editorial surface', () => {
  it('saves an authored concept as its own published generation', async () => {
    const res = await handleOkfConceptSave(
      req({ body: { id: 'concepts/manual', markdown: '---\ntype: Concept\ntitle: Manual\ndescription: D.\n---\n\nHand-written.\n' } }),
      principal(),
    );
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body.status).toBe('published');
    expect(store().readPage('concepts/manual')?.body).toBe('Hand-written.');
  });

  it('maps a generation conflict to 409', async () => {
    publishPage(); // wiki at generation 1
    const res = await handleOkfConceptSave(
      req({ body: { id: 'concepts/manual', markdown: '---\ntype: Concept\n---\n\nBody.\n', expectedGeneration: 99 } }),
      principal(),
    );
    expect(res.status).toBe(409);
  });

  it('supersede retires the old page and requires the replacement to exist', async () => {
    publishPage('concepts/old');
    const missing = await handleOkfConceptSupersede(
      req({ body: { oldId: 'concepts/old', newId: 'concepts/new', reason: 'r' } }),
      principal(),
    );
    expect(missing.status).toBe(500);

    await handleOkfConceptSave(
      req({ body: { id: 'concepts/new', markdown: '---\ntype: Concept\ntitle: New\ndescription: D.\n---\n\nNew body.\n' } }),
      principal(),
    );
    const ok = await handleOkfConceptSupersede(
      req({ body: { oldId: 'concepts/old', newId: 'concepts/new', reason: 'replaced' } }),
      principal(),
    );
    expect(ok.status).toBe(200);
    expect(store().readPage('concepts/old')).toBeNull();
    expect(store().readPage('concepts/new')?.body).toBe('New body.');
  });
});

describe('OKF API — served project with no local working tree (F1)', () => {
  it('handleOkfStatus returns 200 with machine+grove config when the project root is absent on this machine', async () => {
    publishPage();
    // Team Host shape: this daemon holds the Grove DB (content lives there,
    // unaffected) but the checkout is on the member's machine, not here.
    fs.rmSync(projectRoot, { recursive: true, force: true });
    const res = await handleOkfStatus(req(), principal());
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body.bundleExists).toBe(true);
    expect(body.bundleGeneration).toBe(1);
  });

  it('handleOkfPageGet still serves the DB-resident page body with no working tree present', async () => {
    publishPage();
    fs.rmSync(projectRoot, { recursive: true, force: true });
    const got = await handleOkfPageGet(req({ pathname: `/api/okf/pages/${encodeURIComponent('concepts/alpha')}` }), principal());
    expect(got.status).toBe(200);
    const page = (got.body as { page: Record<string, unknown> }).page;
    expect(page).toMatchObject({ path: 'concepts/alpha.md', type: 'concept', body: AGENT_BODY });
  });
});

describe('OKF API — validate', () => {
  it('validates the current row set', async () => {
    publishPage();
    const res = await handleOkfValidate(req(), principal());
    const validation = (res.body as { validation: { ok: boolean; conceptsChecked: number } }).validation;
    expect(validation.ok).toBe(true);
    expect(validation.conceptsChecked).toBe(1);
  });
});
