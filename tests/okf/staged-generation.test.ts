import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LifecycleLock } from '@myco/utils/lifecycle-lock.js';
import { registerAgent } from '@myco/db/queries/agents.js';
import { createProjectId, projectScope } from '@myco/grove/ids.js';
import { MycoConfigSchema, type MycoConfig } from '@myco/config/schema.js';
import { ProjectVault } from '@myco/vault/project-vault.js';
import { OkfBundle, type OkfBundleDeps, type OkfFsOps } from '@myco/okf/bundle.js';
import { validateBundleTree } from '@myco/okf/validate.js';
import { parseConceptDoc } from '@myco/okf/frontmatter.js';
import type { OkfDocument } from '@myco/okf/types.js';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db.js';

const AGENT_ID = 'claude-code';
const MACHINE_ID = 'test-machine-okf';
let projectRoot: string;
let projectId: string;

beforeAll(() => setupTestDb());
afterAll(() => teardownTestDb());

beforeEach(() => {
  cleanTestDb();
  registerAgent({ id: AGENT_ID, name: 'Myco Agent', created_at: 1_783_000_000 });
  projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'okf-staged-')));
  projectId = createProjectId();
});

afterEach(() => fs.rmSync(projectRoot, { recursive: true, force: true }));

function config(): MycoConfig {
  return MycoConfigSchema.parse({ version: 3, okf: { enabled: true } });
}

function makeBundle(fsOps?: OkfFsOps): OkfBundle {
  const deps: OkfBundleDeps = {
    projectRoot,
    vault: new ProjectVault(projectRoot),
    scope: projectScope(projectId as ReturnType<typeof createProjectId>),
    projectId,
    machineId: MACHINE_ID,
    config: config(),
    now: () => new Date('2026-07-05T12:00:00Z'),
    fsOps,
  };
  return new OkfBundle(deps);
}

/** Real fs, but counts renames whose destination is the given output root. */
function countingFsOps(counter: { renamesToOutput: number }, outputRoot: string): OkfFsOps {
  return {
    rename: (from, to) => {
      if (to === outputRoot) counter.renamesToOutput += 1;
      fs.renameSync(from, to);
    },
    rm: (t, o) => fs.rmSync(t, o),
    mkdir: (t, o) => {
      fs.mkdirSync(t, o);
    },
    stat: (t) => fs.statSync(t),
  };
}

function contentDoc(id: string, over: Partial<OkfDocument['frontmatter']> = {}): OkfDocument {
  return {
    path: `${id}.md`,
    frontmatter: {
      type: 'note',
      title: id,
      description: 'A portable knowledge page.',
      timestamp: '2026-07-05T00:00:00Z',
      ...over,
    },
    body: `Body of ${id}.`,
  };
}

const okfDir = () => path.join(projectRoot, 'okf');
const manifest = () => new ProjectVault(projectRoot).readOkfManifest();

describe('OkfBundle.beginStagedGeneration', () => {
  it('stages two documents and finalize publishes a strict-valid bundle, one lock, one atomic-replace', async () => {
    const outputRoot = okfDir();
    const counter = { renamesToOutput: 0 };
    const acquire = spyOn(LifecycleLock, 'acquire');
    try {
      const bundle = makeBundle(countingFsOps(counter, outputRoot));
      const staged = await bundle.beginStagedGeneration({ mode: 'published' });
      staged.stageDocument(contentDoc('pages/alpha'));
      staged.stageDocument(contentDoc('pages/beta'));
      const result = await staged.finalize({ inputsHash: 'staged-test-hash' });

      // Published bundle passes the OKF document-model strict validator from disk.
      expect(validateBundleTree(outputRoot, 'strict').ok).toBe(true);
      expect(result.unchanged).toBe(false);
      expect(result.conceptCount).toBe(2);

      // Root index carries NO frontmatter (OKF indexes are plain markdown).
      const rootIndex = fs.readFileSync(path.join(outputRoot, 'index.md'), 'utf8');
      expect(rootIndex.startsWith('---\n')).toBe(false);
      // A nested index too.
      const pagesIndex = fs.readFileSync(path.join(outputRoot, 'pages/index.md'), 'utf8');
      expect(pagesIndex.startsWith('---\n')).toBe(false);

      // Content docs carry only the OKF six-key frontmatter — no myco_* provenance.
      const alpha = fs.readFileSync(path.join(outputRoot, 'pages/alpha.md'), 'utf8');
      expect(alpha.startsWith('---\n')).toBe(true);
      expect(alpha).not.toContain('myco_');
      const { frontmatter } = parseConceptDoc(alpha);
      const allowed = new Set(['type', 'resource', 'title', 'description', 'tags', 'timestamp']);
      for (const key of Object.keys(frontmatter)) expect(allowed.has(key)).toBe(true);

      // The lock was acquired exactly once, and the tree was swapped into place once.
      expect(acquire).toHaveBeenCalledTimes(1);
      expect(counter.renamesToOutput).toBe(1);
      expect(manifest()?.bundle_generation).toBe(1);
    } finally {
      acquire.mockRestore();
    }
  });

  it('rejects a content document whose basename is reserved instead of silently clobbering it', async () => {
    const staged = await makeBundle().beginStagedGeneration({ mode: 'published' });
    try {
      // A content doc (non-empty four-key frontmatter) named index.md/log.md must
      // route through renderOkfDocument and hit reserved_filename — NOT be written
      // frontmatter-less and then silently overwritten by the generated index.
      expect(() => staged.stageDocument(contentDoc('notes/index'))).toThrow(/reserved_filename/);
      expect(() => staged.stageDocument(contentDoc('log'))).toThrow(/reserved_filename/);
    } finally {
      staged.abort();
    }
  });

  it('rejects an empty-frontmatter document that is not a reserved index/log file', async () => {
    const staged = await makeBundle().beginStagedGeneration({ mode: 'published' });
    try {
      // Empty frontmatter is the index/log discriminator; an empty-frontmatter doc
      // at a non-reserved path is a malformed content doc, not a plain index.
      const orphan: OkfDocument = { path: 'pages/orphan.md', frontmatter: {} as OkfDocument['frontmatter'], body: 'x' };
      expect(() => staged.stageDocument(orphan)).toThrow();
      expect(fs.existsSync(path.join(okfDir(), 'pages/orphan.md'))).toBe(false);
    } finally {
      staged.abort();
    }
  });

  it('abort after staging leaves the previously-published bundle intact', async () => {
    // Publish a first bundle.
    const first = await makeBundle().beginStagedGeneration({ mode: 'published' });
    first.stageDocument(contentDoc('pages/alpha'));
    await first.finalize({ inputsHash: 'gen-1' });
    const alphaPath = path.join(okfDir(), 'pages/alpha.md');
    const alphaBytes = fs.readFileSync(alphaPath, 'utf8');
    expect(manifest()?.bundle_generation).toBe(1);

    // Stage a different document, then abort.
    const second = await makeBundle().beginStagedGeneration({ mode: 'published' });
    second.stageDocument(contentDoc('pages/gamma'));
    second.abort();

    // The previous bundle is untouched; the aborted document never landed.
    expect(fs.readFileSync(alphaPath, 'utf8')).toBe(alphaBytes);
    expect(fs.existsSync(path.join(okfDir(), 'pages/gamma.md'))).toBe(false);
    expect(manifest()?.bundle_generation).toBe(1);
  });
});

describe('OkfBundle.beginStagedGeneration — incremental carry-forward (Task 3.3)', () => {
  it('a run that re-stages only a subset carries forward the untouched pages, including a human-authored one', async () => {
    const outputRoot = okfDir();
    const bundle = makeBundle();

    // Publish A, B, C.
    const first = await bundle.beginStagedGeneration({ mode: 'published' });
    first.stageDocument(contentDoc('pages/alpha'));
    first.stageDocument(contentDoc('pages/beta'));
    first.stageDocument(contentDoc('pages/gamma'));
    await first.finalize({ inputsHash: 'gen-1' });

    const alphaBefore = fs.readFileSync(path.join(outputRoot, 'pages/alpha.md'), 'utf8');
    const gammaBefore = fs.readFileSync(path.join(outputRoot, 'pages/gamma.md'), 'utf8');

    // A human drops a page directly into the published tree — Myco never wrote it.
    const humanRaw =
      '---\ntype: note\ntitle: Human\ndescription: Written by a person.\ntimestamp: 2026-07-05T00:00:00Z\n---\n\nHand-authored content.\n';
    fs.writeFileSync(path.join(outputRoot, 'pages/human.md'), humanRaw);

    // Second (incremental) run re-stages ONLY beta, refreshed — mirrors an
    // okf-synthesize run that drains its plan across multiple runs and
    // deliberately leaves untouched pages "as-is".
    const second = await bundle.beginStagedGeneration({ mode: 'published' });
    second.stageDocument({
      path: 'pages/beta.md',
      frontmatter: { type: 'note', title: 'pages/beta', description: 'Refreshed beta.', timestamp: '2026-07-05T00:00:00Z' },
      body: 'Refreshed body of pages/beta.',
    });
    const result = await second.finalize({ inputsHash: 'gen-2' });

    // Untouched pages survive with their ORIGINAL content — nothing this run
    // didn't write was dropped by finalize's atomic-replace.
    expect(fs.readFileSync(path.join(outputRoot, 'pages/alpha.md'), 'utf8')).toBe(alphaBefore);
    expect(fs.readFileSync(path.join(outputRoot, 'pages/gamma.md'), 'utf8')).toBe(gammaBefore);
    expect(fs.readFileSync(path.join(outputRoot, 'pages/human.md'), 'utf8')).toBe(humanRaw);

    // Beta got the refresh.
    const betaAfter = fs.readFileSync(path.join(outputRoot, 'pages/beta.md'), 'utf8');
    expect(betaAfter).toContain('Refreshed body of pages/beta.');

    // Every page — carried-forward AND freshly staged — is counted, indexed,
    // and the tree still passes strict validation.
    expect(result.conceptCount).toBe(4);
    const pagesIndex = fs.readFileSync(path.join(outputRoot, 'pages/index.md'), 'utf8');
    expect(pagesIndex).toContain('alpha.md');
    expect(pagesIndex).toContain('beta.md');
    expect(pagesIndex).toContain('gamma.md');
    expect(pagesIndex).toContain('human.md');
    expect(validateBundleTree(outputRoot, 'strict').ok).toBe(true);
    expect(manifest()?.bundle_generation).toBe(2);
  });

  it('seeds lazily: a session opened but never staged never touches the staging dir, and abort leaves the bundle untouched', async () => {
    const first = await makeBundle().beginStagedGeneration({ mode: 'published' });
    first.stageDocument(contentDoc('pages/alpha'));
    await first.finalize({ inputsHash: 'gen-1' });
    const alphaPath = path.join(okfDir(), 'pages/alpha.md');
    const alphaBytes = fs.readFileSync(alphaPath, 'utf8');

    const stagingRoot = new ProjectVault(projectRoot).okfStagingDir();
    const before = fs.readdirSync(stagingRoot);

    // Open a session but never call stageDocument or finalize — the no-op-run
    // contract (Task 1.5) depends on the seed-copy staying inside the lazy
    // ensureStaging() path, never running at session-open time.
    const idle = await makeBundle().beginStagedGeneration({ mode: 'published' });
    expect(fs.readdirSync(stagingRoot)).toEqual(before);
    idle.abort();

    expect(fs.readFileSync(alphaPath, 'utf8')).toBe(alphaBytes);
    expect(manifest()?.bundle_generation).toBe(1);
  });
});
