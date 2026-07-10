import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, withDatabase, closeDatabase } from '@myco/db/client.js';
import { createSchema } from '@myco/db/schema.js';
import { MycoConfigSchema, type MycoConfig } from '@myco/config/schema.js';
import { ALL_PROJECTS_SCOPE, projectScope, type GroveProjectId } from '@myco/grove/ids.js';
import { OkfStore } from '@myco/okf/store.js';
import { getOkfPageByPath } from '@myco/db/queries/okf.js';
import {
  insertContentClaim,
  getActiveContentClaim,
  getContentClaimById,
} from '@myco/db/queries/content-claims.js';
import type { WikiPlan } from '@myco/okf/synthesis/plan.js';

const PROJECT_ID = 'proj_11111111111111111111111111111111' as GroveProjectId;
const MACHINE_ID = 'machine-test';

let tmpDir: string;
let db: ReturnType<typeof openDatabase>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'okf-store-'));
  db = openDatabase(path.join(tmpDir, 'test.db'));
  createSchema(db, MACHINE_ID);
});

afterEach(() => {
  closeDatabase();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function config(enabled = true): MycoConfig {
  return MycoConfigSchema.parse({ version: 3, okf: { enabled } });
}

function makeStore(over: { enabled?: boolean } = {}): OkfStore {
  return new OkfStore({
    scope: projectScope(PROJECT_ID),
    projectId: PROJECT_ID,
    machineId: MACHINE_ID,
    config: config(over.enabled ?? true),
    now: () => new Date('2026-07-08T12:00:00Z'),
  });
}

function plan(paths: string[]): WikiPlan {
  return {
    generatedAt: '2026-07-08T12:00:00Z',
    sinceRef: '',
    pages: paths.map((p) => ({
      path: p,
      type: 'concept',
      title: `Title for ${p}`,
      rationale: 'test page',
      sourceRefs: [],
    })),
  };
}

function pageInput(p: string, body = `Body of ${p}.`) {
  return { path: p, type: 'concept', title: `Title for ${p}`, description: `About ${p}.`, body };
}

describe('OkfStore — gate and lifecycle', () => {
  it('fails closed on every write when the capability is disabled', () => {
    withDatabase(db, () => {
      const store = makeStore({ enabled: false });
      expect(() => store.createDraftGeneration({ runId: 'r1', plan: plan(['a/b']) })).toThrow(/okf/i);
      expect(() => store.writePage(pageInput('a/b'))).toThrow(/okf/i);
      expect(() => store.acknowledge()).toThrow(/okf/i);
    });
  });

  it('allocates per-project generation numbers monotonically and supersedes prior open generations', () => {
    withDatabase(db, () => {
      const store = makeStore();
      const g1 = store.createDraftGeneration({ runId: 'r1', plan: plan(['a/one']) });
      expect(g1.generation).toBe(1);
      expect(g1.status).toBe('draft');

      const g2 = store.createDraftGeneration({ runId: 'r2', plan: plan(['a/one']) });
      expect(g2.generation).toBe(2);
      expect(store.currentDraft()?.id).toBe(g2.id);
      // g1 became history, not a competing draft.
      expect(store.latest()?.id).toBe(g2.id);
    });
  });

  it('rejects a plan with a reserved basename at draft creation', () => {
    withDatabase(db, () => {
      const store = makeStore();
      expect(() => store.createDraftGeneration({ runId: 'r1', plan: plan(['guides/index']) })).toThrow(/reserved/);
    });
  });

  it('writePage requires an open draft', () => {
    withDatabase(db, () => {
      expect(() => makeStore().writePage(pageInput('a/b'))).toThrow(/draft/);
    });
  });
});

describe('OkfStore — page writes and finalize', () => {
  it('writes head + revision, finalizes clean content to published, and reads it back', () => {
    withDatabase(db, () => {
      const store = makeStore();
      const draft = store.createDraftGeneration({ runId: 'r1', plan: plan(['concepts/alpha', 'concepts/beta']) });
      const w1 = store.writePage(pageInput('concepts/alpha'));
      expect(w1.path).toBe('concepts/alpha.md');
      expect(w1.pageGeneration).toBe(1);
      store.writePage(pageInput('concepts/beta'));

      const result = store.finalizeGeneration(draft.id, { lastRunRef: { headSha: 'abc', maxVaultUpdatedAt: 5 } });
      expect(result.status).toBe('published');
      expect(result.pageCount).toBe(2);
      expect(store.latestPublished()?.id).toBe(draft.id);
      expect(JSON.parse(store.latestPublished()!.last_run_ref!)).toEqual({ headSha: 'abc', maxVaultUpdatedAt: 5 });

      const page = store.readPage('concepts/alpha');
      expect(page?.body).toContain('Body of concepts/alpha.');
      expect(page?.frontmatter.type).toBe('concept');
    });
  });

  it('re-writing an existing path bumps the page generation and records a refined revision', () => {
    withDatabase(db, () => {
      const store = makeStore();
      const d1 = store.createDraftGeneration({ runId: 'r1', plan: plan(['concepts/alpha']) });
      store.writePage(pageInput('concepts/alpha'));
      store.finalizeGeneration(d1.id);

      const d2 = store.createDraftGeneration({ runId: 'r2', plan: plan(['concepts/alpha']) });
      const w2 = store.writePage(pageInput('concepts/alpha', 'Refreshed body.'));
      expect(w2.pageGeneration).toBe(2);
      store.finalizeGeneration(d2.id);
      expect(store.readPage('concepts/alpha')?.body).toBe('Refreshed body.');
    });
  });

  it('sanitizes UUID-shaped identifiers at write time', () => {
    withDatabase(db, () => {
      const store = makeStore();
      const draft = store.createDraftGeneration({ runId: 'r1', plan: plan(['concepts/cited']) });
      store.writePage(pageInput('concepts/cited', 'From session 4da502f0-b1a9-44c6-949a-4696e80abd31.'));
      const result = store.finalizeGeneration(draft.id);
      expect(result.status).toBe('published');
      const body = store.readPage('concepts/cited')!.body;
      expect(body).not.toContain('4da502f0-b1a9-44c6-949a-4696e80abd31');
      expect(body).toMatch(/id-hash-[0-9a-f]{16}/);
    });
  });

  it('blocks a generation whose content carries a secret; acknowledge publishes it', () => {
    withDatabase(db, () => {
      const store = makeStore();
      const draft = store.createDraftGeneration({ runId: 'r1', plan: plan(['notes/token']) });
      store.writePage(pageInput('notes/token', 'old token ghp_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8 rotated.'));
      const result = store.finalizeGeneration(draft.id);
      expect(result.status).toBe('blocked');
      expect(result.findings.some((f) => f.code === 'likely_secret')).toBe(true);
      expect(store.latestPublished()).toBeNull();

      const published = store.acknowledge();
      expect(published?.id).toBe(draft.id);
      expect(store.latestPublished()?.id).toBe(draft.id);
    });
  });

  it('normalizes cross-links against the generation page set at finalize', () => {
    withDatabase(db, () => {
      const store = makeStore();
      const draft = store.createDraftGeneration({ runId: 'r1', plan: plan(['a/one', 'a/two']) });
      store.writePage(pageInput('a/one', 'See [Two](two.md) and [Gone](/missing/page.md).'));
      store.writePage(pageInput('a/two'));
      store.finalizeGeneration(draft.id);

      const body = store.readPage('a/one')!.body;
      expect(body).toContain('[Two](/a/two.md)');
      expect(body).not.toContain('/missing/page.md');
      expect(body).toContain('Gone');
    });
  });

  it('resume-by-query: a superseding draft sees which planned paths already have revisions', () => {
    withDatabase(db, () => {
      const store = makeStore();
      const d1 = store.createDraftGeneration({ runId: 'r1', plan: plan(['a/one', 'a/two']) });
      store.writePage(pageInput('a/one'));
      // Run dies here — no finalize. Rows persist; nothing was lost.
      const d2 = store.createDraftGeneration({ runId: 'r2', plan: plan(['a/one', 'a/two']) });
      expect(d2.generation).toBe(2);
      // The page head written by the failed run is still present and current.
      expect(store.readPage('a/one')?.body).toContain('Body of a/one.');
      expect(store.readPage('a/two')).toBeNull();
      // d1 is history.
      expect(store.currentDraft()?.id).toBe(d2.id);
    });
  });
});

describe('OkfStore — supersedePage cancels the retired page\'s active claim (Task B5)', () => {
  const epochNow = () => Math.floor(Date.now() / 1000);

  /** Publish two pages and return the old page's head id. */
  function seedTwoPublishedPages(store: OkfStore): string {
    const draft = store.createDraftGeneration({ runId: 'r1', plan: plan(['concepts/old', 'concepts/new']) });
    store.writePage(pageInput('concepts/old'));
    store.writePage(pageInput('concepts/new'));
    store.finalizeGeneration(draft.id);
    return getOkfPageByPath(projectScope(PROJECT_ID), 'concepts/old.md')!.id;
  }

  it('supersede with an active claim on the old page: page retired AND claim released', () => {
    withDatabase(db, () => {
      const store = makeStore();
      const oldPageId = seedTwoPublishedPages(store);

      const claimed = insertContentClaim({
        artifactKind: 'okf_page',
        artifactId: oldPageId,
        generation: 1,
        projectId: PROJECT_ID,
        claimedBy: 'member-machine',
        claimedAt: epochNow(),
        expiresAt: epochNow() + 86400,
        machineId: 'member-machine',
      });
      expect(claimed.ok).toBe(true);
      if (!claimed.ok) throw new Error('unreachable');

      store.supersedePage('concepts/old', 'concepts/new', 'replaced by the new page');

      // The retired page's claim is no longer active — cancelled inside the
      // supersede transaction, not left to TTL expiry.
      expect(getActiveContentClaim('okf_page', oldPageId)).toBeNull();
      const row = getContentClaimById(claimed.row.id, ALL_PROJECTS_SCOPE);
      expect(row?.state).toBe('released');
      expect(row?.released_at).not.toBeNull();
      // And the page itself really was retired.
      expect(getOkfPageByPath(projectScope(PROJECT_ID), 'concepts/old.md')?.status).toBe('retired');
    });
  });

  it('supersede with no claim on the old page: no-op cancel, no error', () => {
    withDatabase(db, () => {
      const store = makeStore();
      seedTwoPublishedPages(store);

      expect(() =>
        store.supersedePage('concepts/old', 'concepts/new', 'replaced with nothing claimed'),
      ).not.toThrow();
      expect(getOkfPageByPath(projectScope(PROJECT_ID), 'concepts/old.md')?.status).toBe('retired');
    });
  });

  it('supersede never touches a claim on a different page (the replacement)', () => {
    withDatabase(db, () => {
      const store = makeStore();
      seedTwoPublishedPages(store);
      const newPageId = getOkfPageByPath(projectScope(PROJECT_ID), 'concepts/new.md')!.id;

      const claimed = insertContentClaim({
        artifactKind: 'okf_page',
        artifactId: newPageId,
        generation: 1,
        projectId: PROJECT_ID,
        claimedBy: 'member-machine',
        claimedAt: epochNow(),
        expiresAt: epochNow() + 86400,
        machineId: 'member-machine',
      });
      expect(claimed.ok).toBe(true);

      store.supersedePage('concepts/old', 'concepts/new', 'replacement stays claimed');

      expect(getActiveContentClaim('okf_page', newPageId)).not.toBeNull();
    });
  });
});
