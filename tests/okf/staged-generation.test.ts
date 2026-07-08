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
import { readOwnership, isHandEdited } from '@myco/okf/ownership.js';
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
      expect(result.pageCount).toBe(2);

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

  it('sanitizes UUID-shaped identifiers out of staged content so the publish-eligibility scan stays clean', async () => {
    const outputRoot = okfDir();
    const staged = await makeBundle().beginStagedGeneration({ mode: 'published' });
    const doc = contentDoc('pages/cited');
    doc.body = 'Grounded in session 4da502f0-b1a9-44c6-949a-4696e80abd31.\n\n# Citations\n- spore wisdom-f583220c\n';
    staged.stageDocument(doc);
    const result = await staged.finalize({ inputsHash: 'sanitize-test-hash' });

    expect(result.publishEligibility.ok).toBe(true);
    const published = fs.readFileSync(path.join(outputRoot, 'pages/cited.md'), 'utf8');
    expect(published).not.toContain('4da502f0-b1a9-44c6-949a-4696e80abd31');
    expect(published).toMatch(/id-hash-[0-9a-f]{16}/);
    expect(published).toContain('wisdom-f583220c');
  });

  it('a rejected stageDocument does not poison the staged set — finalize still publishes the good pages', async () => {
    const outputRoot = okfDir();
    const staged = await makeBundle().beginStagedGeneration({ mode: 'published' });
    staged.stageDocument(contentDoc('pages/alpha'));
    expect(() => staged.stageDocument(contentDoc('pages/index'))).toThrow(/reserved_filename/);
    const result = await staged.finalize({ inputsHash: 'poison-test-hash' });

    expect(result.pageCount).toBe(1);
    expect(validateBundleTree(outputRoot, 'strict').ok).toBe(true);
    expect(fs.existsSync(path.join(outputRoot, 'pages/alpha.md'))).toBe(true);
    // The generated directory index at pages/index.md is plain markdown — the
    // rejected content doc never landed there.
    const pagesIndex = fs.readFileSync(path.join(outputRoot, 'pages/index.md'), 'utf8');
    expect(pagesIndex.startsWith('---\n')).toBe(false);
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
    expect(result.pageCount).toBe(4);
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

describe('OkfBundle.beginStagedGeneration — carried-page quarantine (Task 7.1)', () => {
  it('quarantines an invalid carried page instead of wedging the publish; fresh pages still ship', async () => {
    const outputRoot = okfDir();
    const bundle = makeBundle();

    // Publish alpha + gamma (both valid).
    const first = await bundle.beginStagedGeneration({ mode: 'published' });
    first.stageDocument(contentDoc('pages/alpha'));
    first.stageDocument(contentDoc('pages/gamma'));
    await first.finalize({ inputsHash: 'gen-1' });

    // A human hand-edits gamma into an INVALID OKF page — drops the required
    // 'description' floor key. A whole-tree strict validate would throw
    // okf_validation_failed and wedge every future publish on this one page.
    fs.writeFileSync(
      path.join(outputRoot, 'pages/gamma.md'),
      '---\ntype: note\ntitle: Gamma\ntimestamp: 2026-07-05T00:00:00Z\n---\n\nA carried page missing the description floor key.\n',
    );

    // Second run stages a DIFFERENT fresh page. gamma is carried forward, fails
    // per-file validation, is quarantined — and the run publishes anyway.
    const second = await bundle.beginStagedGeneration({ mode: 'published' });
    second.stageDocument(contentDoc('pages/beta'));
    const result = await second.finalize({ inputsHash: 'gen-2' });

    // finalize did NOT throw; the published tree is strict-valid.
    expect(result.unchanged).toBe(false);
    expect(validateBundleTree(outputRoot, 'strict').ok).toBe(true);

    // Fresh page + the valid carried page published; the invalid one was excluded.
    expect(fs.existsSync(path.join(outputRoot, 'pages/beta.md'))).toBe(true);
    expect(fs.existsSync(path.join(outputRoot, 'pages/alpha.md'))).toBe(true);
    expect(fs.existsSync(path.join(outputRoot, 'pages/gamma.md'))).toBe(false);

    // A recoverable warning names the quarantined page.
    const warning = result.warnings.find((w) => w.code === 'carried_page_quarantined');
    expect(warning?.path).toBe('pages/gamma.md');

    // The generated index omits the quarantined page.
    const pagesIndex = fs.readFileSync(path.join(outputRoot, 'pages/index.md'), 'utf8');
    expect(pagesIndex).toContain('alpha.md');
    expect(pagesIndex).toContain('beta.md');
    expect(pagesIndex).not.toContain('gamma.md');
    expect(manifest()?.bundle_generation).toBe(2);
  });

  it('a carried page re-staged fresh this run is NOT quarantined even if its prior on-disk copy was invalid', async () => {
    const outputRoot = okfDir();
    const bundle = makeBundle();

    const first = await bundle.beginStagedGeneration({ mode: 'published' });
    first.stageDocument(contentDoc('pages/gamma'));
    await first.finalize({ inputsHash: 'gen-1' });

    // Break gamma on disk ...
    fs.writeFileSync(
      path.join(outputRoot, 'pages/gamma.md'),
      '---\ntype: note\ntitle: Gamma\ntimestamp: 2026-07-05T00:00:00Z\n---\n\nBroken (no description).\n',
    );

    // ... but this run re-synthesizes gamma with a VALID fresh document — the
    // fresh content wins and is validated wholesale, so gamma is not quarantined.
    const second = await bundle.beginStagedGeneration({ mode: 'published' });
    second.stageDocument(contentDoc('pages/gamma'));
    const result = await second.finalize({ inputsHash: 'gen-2' });

    expect(result.warnings.some((w) => w.code === 'carried_page_quarantined')).toBe(false);
    expect(fs.existsSync(path.join(outputRoot, 'pages/gamma.md'))).toBe(true);
    expect(validateBundleTree(outputRoot, 'strict').ok).toBe(true);
  });
});

describe('OkfBundle publish-block acknowledge model (Task 7.1)', () => {
  // A body that trips the publish-eligibility scanner (absolute local path).
  function findingDoc(): OkfDocument {
    return {
      path: 'pages/leaky.md',
      frontmatter: { type: 'note', title: 'Leaky', description: 'Carries an absolute path.', timestamp: '2026-07-05T00:00:00Z' },
      body: 'See the config at /Users/someone/secret/config.toml for details.',
    };
  }

  it('a blocking finding persists to pending_findings and blocks; acknowledging clears it so the next run publishes', async () => {
    const bundle = makeBundle();

    // Run 1: finalize BLOCKS on the unacknowledged finding — nothing publishes.
    const first = await bundle.beginStagedGeneration({ mode: 'published' });
    first.stageDocument(findingDoc());
    await expect(first.finalize({ inputsHash: 'gen-1' })).rejects.toThrow(/publish blocked/);

    // The block is durable on the manifest, though nothing was published.
    expect(bundle.status().bundleExists).toBe(false);
    const blocked = manifest();
    expect(blocked?.last_result).toBe('publish_blocked');
    expect(blocked?.pending_findings?.map((f) => f.code)).toEqual(['absolute_local_path']);
    // status surfaces it for the OKF page's load-time block panel.
    expect(bundle.status().pendingFindings.map((f) => f.code)).toEqual(['absolute_local_path']);

    // Acknowledge — drains pending into acknowledged_findings.
    const afterAck = await bundle.acknowledgePendingFindings();
    expect(afterAck.pendingFindings).toEqual([]);
    const acked = manifest();
    expect(acked?.pending_findings).toEqual([]);
    expect(acked?.acknowledged_findings.map((f) => f.code)).toEqual(['absolute_local_path']);

    // Run 2: the SAME finding is now acknowledged → publishes.
    const second = await bundle.beginStagedGeneration({ mode: 'published' });
    second.stageDocument(findingDoc());
    const result = await second.finalize({ inputsHash: 'gen-2' });
    expect(result.unchanged).toBe(false);
    expect(bundle.status().bundleExists).toBe(true);
    // The successful publish cleared pending.
    expect(manifest()?.pending_findings).toEqual([]);
    expect(manifest()?.bundle_generation).toBe(1);
  });

  it('acknowledgePendingFindings is a no-op when nothing is pending', async () => {
    const bundle = makeBundle();
    const status = await bundle.acknowledgePendingFindings();
    expect(status.pendingFindings).toEqual([]);
    expect(manifest()).toBeNull();
  });
});

describe('OkfBundle.beginStagedGeneration — body cross-link normalization (Task 7.5)', () => {
  /** A root-level page whose body links two siblings (wrong depth) plus one non-existent page. */
  function glossaryDoc(body: string): OkfDocument {
    return {
      path: 'glossary.md',
      frontmatter: { type: 'glossary', title: 'Glossary', description: 'Terms.', timestamp: '2026-07-05T00:00:00Z' },
      body,
    };
  }

  it('rewrites resolving links to absolute bundle-relative and downgrades a dead link to plain text', async () => {
    const outputRoot = okfDir();
    const bundle = makeBundle();
    const staged = await bundle.beginStagedGeneration({ mode: 'published' });
    staged.stageDocument(contentDoc('concepts/alpha'));
    // Wrong-depth relative (../ escapes the bundle from a root page), a
    // root-relative link, and a dangling link to a page nobody synthesized.
    staged.stageDocument(
      glossaryDoc('See [Alpha](../concepts/alpha.md), [Alpha again](concepts/alpha.md), and [Ghost](../concepts/ghost.md).'),
    );
    const result = await staged.finalize({ inputsHash: 'gen-1' });

    const glossary = fs.readFileSync(path.join(outputRoot, 'glossary.md'), 'utf8');
    // Both real links resolve to the canonical absolute form ...
    expect(glossary).toContain('[Alpha](/concepts/alpha.md)');
    expect(glossary).toContain('[Alpha again](/concepts/alpha.md)');
    // ... the dead link is downgraded to its label (no 404, no dropped content) ...
    expect(glossary).toContain('and Ghost.');
    expect(glossary).not.toContain('ghost.md');
    // ... a recoverable warning names the page whose link was downgraded ...
    expect(result.warnings.some((w) => w.code === 'body_link_downgraded' && w.path === 'glossary.md')).toBe(true);
    // ... and the published tree still passes strict validation.
    expect(validateBundleTree(outputRoot, 'strict').ok).toBe(true);
  });

  it('a carried-forward already-normalized page is byte-identical and keeps its ownership fingerprint (idempotency)', async () => {
    const outputRoot = okfDir();
    const bundle = makeBundle();

    // Run 1: publish alpha + a glossary whose link is ALREADY the absolute form.
    const first = await bundle.beginStagedGeneration({ mode: 'published' });
    first.stageDocument(contentDoc('concepts/alpha'));
    first.stageDocument(glossaryDoc('See [Alpha](/concepts/alpha.md).'));
    await first.finalize({ inputsHash: 'gen-1' });

    const glossaryPath = path.join(outputRoot, 'glossary.md');
    const glossaryBefore = fs.readFileSync(glossaryPath, 'utf8');
    const fingerprintBefore = readOwnership(new ProjectVault(projectRoot))?.pages['glossary.md']?.fingerprint;
    expect(fingerprintBefore).toBeTruthy();

    // Run 2: re-stage a DIFFERENT page. glossary is carried forward untouched and
    // re-run through the normalizer — which, being idempotent on already-absolute
    // links, must not change a single byte.
    const second = await bundle.beginStagedGeneration({ mode: 'published' });
    second.stageDocument({
      path: 'concepts/alpha.md',
      frontmatter: { type: 'concept', title: 'concepts/alpha', description: 'Refreshed.', timestamp: '2026-07-05T00:00:00Z' },
      body: 'Refreshed alpha body.',
    });
    await second.finalize({ inputsHash: 'gen-2' });

    // Byte-identical carried page → its carried-forward ownership fingerprint
    // still matches disk, so it does NOT read as hand-edited (the interaction the
    // brief calls out: normalization runs before ownership fingerprinting).
    const glossaryAfter = fs.readFileSync(glossaryPath, 'utf8');
    expect(glossaryAfter).toBe(glossaryBefore);
    const ownership = readOwnership(new ProjectVault(projectRoot));
    expect(ownership?.pages['glossary.md']?.fingerprint).toBe(fingerprintBefore);
    expect(isHandEdited('glossary.md', glossaryAfter, ownership)).toBe(false);
  });
});
