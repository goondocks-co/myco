/**
 * Regression tests for the review-pass path-traversal fix (CRITICAL, #1).
 *
 * `assertSafeConceptId` (paths.ts) is the single choke point that rejects a
 * concept id that could escape the bundle root — `.`/`..`/empty/NUL/backslash
 * segments or a leading `/`. `conceptPathForId` calls it directly; `bundle.ts`
 * consumes it via `getConcept` (returns null for an unsafe id, never leaks a
 * read outside the bundle) and `assertEditableConceptId` (throws
 * `deterministic_path_not_editable` for an unsafe id, never writes outside the
 * bundle).
 *
 * Mirrors the makeBundle/config/seedSpore harness from bundle-capability.test.ts.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerAgent } from '@myco/db/queries/agents.js';
import { createProjectId, projectScope } from '@myco/grove/ids.js';
import { MycoConfigSchema, type MycoConfig } from '@myco/config/schema.js';
import { ProjectVault } from '@myco/vault/project-vault.js';
import { OkfBundle, OkfError, type OkfBundleDeps } from '@myco/okf/bundle.js';
import type { OkfBundleWriteInput } from '@myco/okf/types.js';
import { assertSafeConceptId, conceptPathForId, OkfPathError } from '@myco/okf/paths.js';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db.js';

const AGENT_ID = 'claude-code';
const MACHINE_ID = 'test-machine-okf';
let projectRoot: string;
let projectId: string;

beforeAll(() => {
  setupTestDb();
});

afterAll(() => {
  teardownTestDb();
});

beforeEach(() => {
  cleanTestDb();
  registerAgent({ id: AGENT_ID, name: 'Myco Agent', created_at: 1_783_000_000 });
  projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'okf-traversal-')));
  projectId = createProjectId();
});

afterEach(() => {
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

function config(overrides: Record<string, unknown> = {}): MycoConfig {
  return MycoConfigSchema.parse({ version: 3, okf: { enabled: true }, ...overrides });
}

function makeBundle(cfg: MycoConfig = config(), now = () => new Date('2026-07-05T12:00:00Z')): OkfBundle {
  const deps: OkfBundleDeps = {
    projectRoot,
    vault: new ProjectVault(projectRoot),
    scope: projectScope(projectId as ReturnType<typeof createProjectId>),
    projectId,
    machineId: MACHINE_ID,
    config: cfg,
    now,
  };
  return new OkfBundle(deps);
}

function baseInput(over: Partial<OkfBundleWriteInput> = {}): OkfBundleWriteInput {
  return {
    scope: projectScope(projectId as ReturnType<typeof createProjectId>),
    projectRoot,
    machineId: MACHINE_ID,
    mode: 'published',
    include: { spores: true, canopy: true, concepts: true, guides: true },
    sporeStatus: 'active',
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Unit: assertSafeConceptId / conceptPathForId
// ---------------------------------------------------------------------------

describe('assertSafeConceptId', () => {
  it('throws OkfPathError (path_traversal) for an id with a traversal segment', () => {
    expect(() => assertSafeConceptId('concepts/../../etc/x')).toThrow(OkfPathError);
    expect(() => assertSafeConceptId('concepts/../../etc/x')).toThrow(/path_traversal/);
  });

  it('throws for a leading slash (absolute id)', () => {
    expect(() => assertSafeConceptId('/etc/passwd')).toThrow(/path_traversal/);
  });

  it('throws for an empty id', () => {
    expect(() => assertSafeConceptId('')).toThrow(OkfPathError);
  });

  it('throws for a NUL byte', () => {
    expect(() => assertSafeConceptId('concepts/a\0b')).toThrow(/nul_byte/);
  });

  it('throws for a backslash segment', () => {
    expect(() => assertSafeConceptId('concepts\\..\\..\\x')).toThrow(/path_traversal|backslash/);
  });

  it('does NOT throw for safe ids', () => {
    expect(() => assertSafeConceptId('spores/decisions/d-1')).not.toThrow();
    expect(() => assertSafeConceptId('concepts/note')).not.toThrow();
    expect(() => assertSafeConceptId('canopy/files/src/foo.ts')).not.toThrow();
  });
});

describe('conceptPathForId — traversal rejection', () => {
  it('throws for an id containing ../..', () => {
    expect(() => conceptPathForId('concepts/../../x')).toThrow(OkfPathError);
    expect(() => conceptPathForId('concepts/../../x')).toThrow(/path_traversal/);
  });

  it('does not throw for safe ids and appends .md', () => {
    expect(conceptPathForId('spores/decisions/d-1')).toBe('spores/decisions/d-1.md');
    expect(conceptPathForId('concepts/note')).toBe('concepts/note.md');
    expect(conceptPathForId('canopy/files/src/foo.ts')).toBe('canopy/files/src/foo.ts.md');
  });
});

// ---------------------------------------------------------------------------
// Integration: getConcept / saveConcept against a real published bundle
// ---------------------------------------------------------------------------

describe('OkfBundle — path traversal is rejected end-to-end', () => {
  // Phase 2: renderDocuments is stubbed (Task 0.1); each test below bootstraps
  // a real published bundle via maintain(), which now throws not_implemented.
  // The underlying protection (assertSafeConceptId/conceptPathForId) stays
  // covered by the unit tests above; only this end-to-end integration layer
  // is blocked until Task 1.5 restores real content generation.
  it.skip('getConcept returns null for a traversal id (never reads outside the bundle)', async () => {
    const bundle = makeBundle();
    await bundle.maintain(baseInput());

    expect(bundle.getConcept('../../../../etc/passwd')).toBeNull();
  });

  it.skip('saveConcept rejects a traversal id with deterministic_path_not_editable and creates no file at the escape target', async () => {
    const bundle = makeBundle();
    await bundle.maintain(baseInput());

    // The escape target lives under a temp dir we control so we can assert
    // no file was created there by a would-be path-traversal write.
    const escapeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'okf-escape-'));
    const escapedPath = path.join(escapeRoot, 'pwned.md');
    // projectRoot/okf/concepts/../../../<escapeRoot without leading slash>/pwned
    // — expressed relative to the concepts/ dir the way an attacker-controlled
    // id would be, so the traversal count matches concepts/<id>.md's nesting.
    const relFromConcepts = path.relative(path.join(projectRoot, 'okf', 'concepts'), escapedPath.replace(/\.md$/, ''));
    const escapeId = `concepts/${relFromConcepts.split(path.sep).join('/')}`;

    try {
      await expect(
        bundle.saveConcept({
          id: escapeId,
          markdown: '---\ntype: decision\ntitle: T\ndescription: D\ntimestamp: 2026-07-05\nmyco_id: escape\n---\n\nEscape attempt.\n',
          provenance: { actor: 'symbiont' },
        }),
      ).rejects.toMatchObject(
        expect.objectContaining({
          code: 'deterministic_path_not_editable',
        }),
      );
      expect(fs.existsSync(escapedPath)).toBe(false);
    } finally {
      fs.rmSync(escapeRoot, { recursive: true, force: true });
    }
  });

  it.skip('saveConcept rejects a simple ../../ escape under concepts/ the same way', async () => {
    const bundle = makeBundle();
    await bundle.maintain(baseInput());

    await expect(
      bundle.saveConcept({
        id: 'concepts/../../../../tmp/okf-escape-simple',
        markdown: '---\ntype: decision\ntitle: T\ndescription: D\ntimestamp: 2026-07-05\nmyco_id: escape2\n---\n\nEscape attempt.\n',
        provenance: { actor: 'symbiont' },
      }),
    ).rejects.toBeInstanceOf(OkfError);
    await expect(
      bundle.saveConcept({
        id: 'concepts/../../../../tmp/okf-escape-simple',
        markdown: '---\ntype: decision\ntitle: T\ndescription: D\ntimestamp: 2026-07-05\nmyco_id: escape2\n---\n\nEscape attempt.\n',
        provenance: { actor: 'symbiont' },
      }),
    ).rejects.toMatchObject({ code: 'deterministic_path_not_editable' });
    expect(fs.existsSync('/tmp/okf-escape-simple.md')).toBe(false);
  });
});
