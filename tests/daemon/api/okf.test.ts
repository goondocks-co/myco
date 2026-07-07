import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RouteRequest } from '@myco/daemon/router';
import { resolveLegacyRequestContext, type MycoRequestContext } from '@myco/grove/request-context';
import { assertGroveProjectId } from '@myco/grove/ids';
import { tenantRoute } from '@myco/daemon/api/route-helpers';
import type { RequestPrincipal } from '@myco/daemon/request-principal';
import { OkfError, OKF_ERROR_HTTP_STATUS } from '@myco/okf/errors';

// --- Stub OkfBundle so the handlers' funnel + error mapping is exercised
//     without a real DB. OkfError stays real (separate module). ---
interface StubImpl {
  acknowledgePendingFindings?: () => Promise<unknown>;
  status?: () => unknown;
  validate?: (root?: string) => unknown;
  saveConcept?: (input: unknown) => Promise<unknown>;
  supersedeConcept?: (input: unknown) => Promise<unknown>;
  listPages?: () => unknown;
  getPage?: (path: string) => unknown;
}
let stub: StubImpl = {};
const constructed: unknown[] = [];

mock.module('@myco/okf/bundle.js', () => ({
  OkfBundle: class {
    constructor(deps: unknown) {
      constructed.push(deps);
    }
    status() {
      return stub.status?.() ?? { outputRoot: '/tmp/x/okf', bundleExists: false, bundleGeneration: null, inputsHash: null, generatedAt: null, lastResult: null, byType: null, conceptCount: null, stale: false, publishAcknowledged: true, pendingFindings: [] };
    }
    acknowledgePendingFindings() {
      return stub.acknowledgePendingFindings?.() ?? Promise.resolve({ outputRoot: '/tmp/x/okf', bundleExists: false, bundleGeneration: null, inputsHash: null, generatedAt: null, lastResult: null, byType: null, conceptCount: null, stale: false, publishAcknowledged: true, pendingFindings: [] });
    }
    validate(root?: string) {
      return stub.validate?.(root) ?? { ok: true, level: 'myco_strict', filesChecked: 0, conceptsChecked: 0, issues: [] };
    }
    saveConcept(input: unknown) {
      return stub.saveConcept?.(input) ?? Promise.resolve({ id: 'concepts/x', bundleGeneration: 2, validation: { ok: true } });
    }
    supersedeConcept(input: unknown) {
      return stub.supersedeConcept?.(input) ?? Promise.resolve({ oldId: 'concepts/a', newId: 'concepts/b', bundleGeneration: 3 });
    }
    listPages() {
      return stub.listPages?.() ?? [];
    }
    getPage(path: string) {
      return stub.getPage?.(path) ?? null;
    }
  },
}));

const {
  handleOkfAcknowledge,
  handleOkfStatus,
  handleOkfValidate,
  handleOkfPagesList,
  handleOkfPageGet,
  handleOkfConceptSave,
  handleOkfConceptSupersede,
} = await import('@myco/daemon/api/okf.js');

const PROJECT_ID = 'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const GROVE_ID = 'grove_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
let projectRoot: string;
let vaultDir: string;

function principalFor(ctx: MycoRequestContext): RequestPrincipal {
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

function ctxFor(): MycoRequestContext {
  return resolveLegacyRequestContext(vaultDir, {
    projectId: assertGroveProjectId(PROJECT_ID),
    groveId: GROVE_ID,
    machineId: 'test-machine',
    tenancySource: 'caller',
  });
}

function req(overrides: Partial<RouteRequest> = {}): RouteRequest {
  return { params: {}, query: {}, body: undefined, pathname: '/api/okf', ...overrides } as RouteRequest;
}

beforeEach(() => {
  stub = {};
  constructed.length = 0;
  projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'okf-api-')));
  vaultDir = path.join(projectRoot, '.myco');
  fs.mkdirSync(vaultDir, { recursive: true });
  fs.writeFileSync(path.join(vaultDir, 'myco.yaml'), 'version: 3\nokf:\n  enabled: true\n');
});

afterEach(() => {
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

describe('OKF API handlers', () => {
  it('maps a generation conflict to 409', async () => {
    stub.saveConcept = () => Promise.reject(new OkfError('okf_generation_conflict', 'stale', { currentGeneration: 1 }));
    const res = await handleOkfConceptSave(req({ body: { id: 'concepts/x', markdown: '---\ntype: X\n---\n' } }), principalFor(ctxFor()));
    expect(res.status).toBe(409);
    expect((res.body as { error: { code: string } }).error.code).toBe('okf_generation_conflict');
    expect((res.body as { details: { currentGeneration: number } }).details.currentGeneration).toBe(1);
  });

  it('status aggregates capability + config fields and never writes', async () => {
    stub.status = () => ({ outputRoot: path.join(projectRoot, 'okf'), bundleExists: false, bundleGeneration: null, inputsHash: null, generatedAt: null, lastResult: null, byType: null, conceptCount: null, stale: false, publishAcknowledged: true });
    const snapshot = JSON.stringify(fs.readdirSync(vaultDir));
    const res = await handleOkfStatus(req(), principalFor(ctxFor()));
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body.enabled).toBe(true);
    expect(body.outputPath).toBe('okf');
    expect(body.lastRun).toBeNull();
    expect((body.agentsPointer as { present: boolean }).present).toBe(false);
    // No writes happened.
    expect(JSON.stringify(fs.readdirSync(vaultDir))).toBe(snapshot);
    expect(fs.existsSync(path.join(projectRoot, 'okf'))).toBe(false);
  });

  it('validate delegates and returns the report', async () => {
    stub.validate = () => ({ ok: false, level: 'myco_strict', filesChecked: 3, conceptsChecked: 2, issues: [{ level: 'error', code: 'x', path: 'a.md', message: 'm' }] });
    const res = await handleOkfValidate(req({ body: { path: 'okf' } }), principalFor(ctxFor()));
    expect(res.status).toBe(200);
    expect((res.body as { validation: { ok: boolean } }).validation.ok).toBe(false);
  });

  it('page get resolves a slash-safe path from the prefix route and returns the document-model shape', async () => {
    let receivedPath: string | undefined;
    stub.getPage = (p) => {
      receivedPath = p;
      return { path: 'notes/my-note.md', type: 'Note', title: 'My Note', description: 'D.', timestamp: '2026-07-05', body: 'Body.' };
    };
    const res = await handleOkfPageGet(
      req({ pathname: '/api/okf/pages/notes/my-note' }),
      principalFor(ctxFor()),
    );
    expect(res.status).toBe(200);
    expect(receivedPath).toBe('notes/my-note');
    const page = (res.body as { page: Record<string, unknown> }).page;
    expect(page.path).toBe('notes/my-note.md');
    expect(page.body).toBe('Body.');
    expect(page).not.toHaveProperty('myco_source_kind');
    expect(page).not.toHaveProperty('raw');
  });

  it('page get returns page: null for a missing page (never a 404)', async () => {
    stub.getPage = () => null;
    const res = await handleOkfPageGet(req({ pathname: '/api/okf/pages/notes/missing' }), principalFor(ctxFor()));
    expect(res.status).toBe(200);
    expect((res.body as { page: unknown }).page).toBeNull();
  });

  it('page list returns OKF-shaped pages with no Myco fields', async () => {
    stub.listPages = () => [
      { path: 'notes/a.md', type: 'Note', title: 'A', description: 'D', timestamp: '2026-07-05' },
    ];
    const list = await handleOkfPagesList(req(), principalFor(ctxFor()));
    const pages = (list.body as { pages: Array<Record<string, unknown>> }).pages;
    expect(pages).toHaveLength(1);
    expect(pages[0]).toEqual({ path: 'notes/a.md', type: 'Note', title: 'A', description: 'D', timestamp: '2026-07-05' });
    expect(pages[0]).not.toHaveProperty('myco_source_kind');
  });

  it('supersede delegates to the capability', async () => {
    stub.supersedeConcept = () => Promise.resolve({ oldId: 'concepts/a', newId: 'concepts/b', bundleGeneration: 4 });
    const sup = await handleOkfConceptSupersede(
      req({ body: { oldId: 'concepts/a', newId: 'concepts/b', reason: 'r' } }),
      principalFor(ctxFor()),
    );
    expect((sup.body as { bundleGeneration: number }).bundleGeneration).toBe(4);
  });

  it('rejects a save with a missing body field (400)', async () => {
    const res = await handleOkfConceptSave(req({ body: { id: 'concepts/x' } }), principalFor(ctxFor()));
    expect(res.status).toBe(400);
  });

  it('status emits the frozen Plan-7 aggregation shape exactly', async () => {
    stub.status = () => ({ outputRoot: path.join(projectRoot, 'okf'), bundleExists: true, bundleGeneration: 3, inputsHash: 'h', generatedAt: '2026-07-05T00:00:00Z', lastResult: 'published', byType: { decision: 2, guide: 1 }, conceptCount: 3, stale: false, publishAcknowledged: true, pendingFindings: [] });
    stub.validate = () => ({ ok: true, level: 'myco_strict', filesChecked: 4, conceptsChecked: 3, issues: [] });
    // A published bundle on disk for the scanner to read (clean → no findings).
    fs.mkdirSync(path.join(projectRoot, 'okf'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'okf/note.md'), '---\ntype: Note\n---\n\nBody.\n');
    const res = await handleOkfStatus(req(), principalFor(ctxFor()));
    const body = res.body as Record<string, unknown>;
    for (const key of ['outputRoot', 'bundleExists', 'bundleGeneration', 'inputsHash', 'generatedAt', 'lastResult', 'byType', 'conceptCount', 'stale', 'publishAcknowledged', 'pendingFindings', 'enabled', 'outputPath', 'validation', 'agentsPointer', 'publishEligibility', 'lastRun']) {
      expect(body).toHaveProperty(key);
    }
    expect(body.lastRun).toBeNull();
    const validation = body.validation as Record<string, unknown>;
    expect(Object.keys(validation).sort()).toEqual(['conceptsChecked', 'filesChecked', 'level', 'ok']);
    const pubElig = body.publishEligibility as { ok: boolean; findings: unknown[] };
    expect(typeof pubElig.ok).toBe('boolean');
    expect(Array.isArray(pubElig.findings)).toBe(true);
    const agentsPointer = body.agentsPointer as Record<string, unknown>;
    expect(Object.keys(agentsPointer).sort()).toEqual(['present', 'stale']);
  });

  it('status folds pending_findings into publishEligibility: ok=false and the findings are surfaced', async () => {
    // A published tree with no findings, but a synthesis run left pending
    // blocking findings on the manifest — the block must still surface.
    stub.status = () => ({ outputRoot: path.join(projectRoot, 'okf'), bundleExists: true, bundleGeneration: 1, inputsHash: 'h', generatedAt: '2026-07-05T00:00:00Z', lastResult: 'publish_blocked', byType: {}, conceptCount: 0, stale: false, publishAcknowledged: true, pendingFindings: [{ code: 'absolute_local_path', path: 'pages/leaky.md', hash: 'abcd1234' }] });
    stub.validate = () => ({ ok: true, level: 'myco_strict', filesChecked: 0, conceptsChecked: 0, issues: [] });
    fs.mkdirSync(path.join(projectRoot, 'okf'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'okf/note.md'), '---\ntype: Note\n---\n\nClean body.\n');
    const res = await handleOkfStatus(req(), principalFor(ctxFor()));
    const body = res.body as Record<string, unknown>;
    const pubElig = body.publishEligibility as { ok: boolean; findings: Array<{ code: string; path: string }> };
    // publishAcknowledged was true, but a non-empty pending set blocks publish.
    expect(pubElig.ok).toBe(false);
    expect(pubElig.findings.some((f) => f.code === 'absolute_local_path' && f.path === 'pages/leaky.md')).toBe(true);
    expect((body.pendingFindings as unknown[]).length).toBe(1);
  });

  it('acknowledge delegates to acknowledgePendingFindings and returns the updated status', async () => {
    let called = false;
    stub.acknowledgePendingFindings = () => {
      called = true;
      return Promise.resolve({ outputRoot: path.join(projectRoot, 'okf'), bundleExists: true, bundleGeneration: 1, inputsHash: 'h', generatedAt: null, lastResult: 'publish_blocked', byType: {}, conceptCount: 0, stale: false, publishAcknowledged: true, pendingFindings: [] });
    };
    const res = await handleOkfAcknowledge(req({ body: {} }), principalFor(ctxFor()));
    expect(res.status).toBe(200);
    expect(called).toBe(true);
    const body = res.body as { ok: boolean; status: { pendingFindings: unknown[] } };
    expect(body.ok).toBe(true);
    expect(body.status.pendingFindings).toEqual([]);
  });

  it('acknowledge maps a thrown OkfError to its frozen envelope', async () => {
    stub.acknowledgePendingFindings = () => Promise.reject(new OkfError('okf_disabled', 'off'));
    const res = await handleOkfAcknowledge(req({ body: {} }), principalFor(ctxFor()));
    expect(res.status).toBe(OKF_ERROR_HTTP_STATUS.okf_disabled);
  });
});

describe('OKF API tenancy', () => {
  it('rejects a request with no tenancy context with 400 tenancy-violation', async () => {
    const wrapped = tenantRoute(
      { machineId: 'm', logger: { debug() {}, info() {}, warn() {}, error() {} } as never },
      handleOkfStatus,
    );
    const res = await wrapped(req({ requestContext: undefined }));
    expect(res.status).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe('tenancy-violation');
  });
});

describe('OKF API is a thin funnel', () => {
  it('performs no direct filesystem writes', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../../packages/myco/src/daemon/api/okf.ts'), 'utf8');
    expect(src).not.toMatch(/fs\.writeFileSync/);
    expect(src).not.toMatch(/fs\.mkdirSync/);
    expect(src).not.toMatch(/fs\.rmSync/);
  });
});
