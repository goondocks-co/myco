import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerAgent } from '@myco/db/queries/agents.js';
import { createProjectId, projectScope } from '@myco/grove/ids.js';
import { MycoConfigSchema, type MycoConfig } from '@myco/config/schema.js';
import { ProjectVault } from '@myco/vault/project-vault.js';
import { OkfBundle, type OkfBundleDeps } from '@myco/okf/bundle.js';
import { isHandEdited, readOwnership } from '@myco/okf/ownership.js';
import { sha256Hex } from '@myco/canopy/hash.js';
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
  projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'okf-ownership-')));
  projectId = createProjectId();
});

afterEach(() => fs.rmSync(projectRoot, { recursive: true, force: true }));

function config(): MycoConfig {
  return MycoConfigSchema.parse({ version: 3, okf: { enabled: true } });
}

function makeBundle(): OkfBundle {
  const deps: OkfBundleDeps = {
    projectRoot,
    vault: new ProjectVault(projectRoot),
    scope: projectScope(projectId as ReturnType<typeof createProjectId>),
    projectId,
    machineId: MACHINE_ID,
    config: config(),
    now: () => new Date('2026-07-05T12:00:00Z'),
  };
  return new OkfBundle(deps);
}

function contentDoc(id: string): OkfDocument {
  return {
    path: `${id}.md`,
    frontmatter: {
      type: 'note',
      title: id,
      description: 'A portable knowledge page.',
      timestamp: '2026-07-05T00:00:00Z',
    },
    body: `Body of ${id}.`,
  };
}

/** A page with the FULL myco_strict frontmatter (tags + source identity) the concept-mutation path requires. */
function mycoStrictDoc(id: string): OkfDocument {
  return {
    path: `${id}.md`,
    frontmatter: {
      type: 'concept',
      title: id,
      description: 'A myco_strict-complete concept.',
      timestamp: '2026-07-05T00:00:00Z',
      tags: ['x'],
      myco_id: id,
    },
    body: `Body of ${id}.`,
  };
}

const okfDir = () => path.join(projectRoot, 'okf');
const vault = () => new ProjectVault(projectRoot);

describe('OKF ownership manifest', () => {
  it('after finalize, readOwnership lists Myco-authored pages with fingerprints', async () => {
    const staged = await makeBundle().beginStagedGeneration({ mode: 'published' });
    staged.stageDocument(contentDoc('pages/alpha'));
    staged.stageDocument(contentDoc('pages/beta'));
    await staged.finalize({ inputsHash: 'gen-1' });

    const ownership = readOwnership(vault());
    expect(ownership?.bundleGeneration).toBe(1);
    expect(Object.keys(ownership?.pages ?? {}).sort()).toEqual(['pages/alpha.md', 'pages/beta.md']);

    const alphaContent = fs.readFileSync(path.join(okfDir(), 'pages/alpha.md'), 'utf8');
    expect(ownership?.pages['pages/alpha.md'].fingerprint).toBe(sha256Hex(alphaContent));
    expect(ownership?.pages['pages/alpha.md'].generatedAt).toBe('2026-07-05T12:00:00.000Z');
  });

  it('editing a published page marks it hand-edited', async () => {
    const staged = await makeBundle().beginStagedGeneration({ mode: 'published' });
    staged.stageDocument(contentDoc('pages/alpha'));
    await staged.finalize({ inputsHash: 'gen-1' });

    const ownership = readOwnership(vault());
    const alphaPath = path.join(okfDir(), 'pages/alpha.md');
    const original = fs.readFileSync(alphaPath, 'utf8');
    expect(isHandEdited('pages/alpha.md', original, ownership)).toBe(false);

    const edited = `${original}\nHand-edited addendum.\n`;
    fs.writeFileSync(alphaPath, edited);
    expect(isHandEdited('pages/alpha.md', edited, ownership)).toBe(true);

    // A page ownership never heard of isn't "hand-edited" in the tracked sense.
    expect(isHandEdited('pages/unknown.md', 'anything', ownership)).toBe(false);
  });

  it('a crash between atomic-replace and ownership-write reconciles to the on-disk generation on the next session open', async () => {
    const bundle = makeBundle();

    // Generation 1: alpha only. Capture the REAL gen-1 ownership file — this is
    // exactly what a crash at gen 2 leaves behind: the gen-2 ownership write
    // never landed, so the gen-1 file is still on disk.
    const first = await bundle.beginStagedGeneration({ mode: 'published' });
    first.stageDocument(contentDoc('pages/alpha'));
    await first.finalize({ inputsHash: 'gen-1' });
    const gen1Ownership = readOwnership(vault());
    expect(gen1Ownership?.bundleGeneration).toBe(1);

    // Generation 2: alpha (unchanged) + beta. This finalize completes normally
    // (atomic swap, manifest write, and ownership write all land) — capture what
    // a real generation-2 ownership file looks like as the "ground truth" the
    // recovery path must reproduce.
    const second = await bundle.beginStagedGeneration({ mode: 'published' });
    second.stageDocument(contentDoc('pages/alpha'));
    second.stageDocument(contentDoc('pages/beta'));
    await second.finalize({ inputsHash: 'gen-2' });
    const groundTruth = readOwnership(vault());
    expect(groundTruth?.bundleGeneration).toBe(2);

    // Simulate the crash: generation 2 is fully live on disk (marker + manifest
    // both say gen 2) but the ownership write for that publish never landed —
    // the gen-1 ownership file is what's on disk.
    fs.writeFileSync(vault().okfOwnershipPath(), `${JSON.stringify(gen1Ownership, null, 2)}\n`);
    expect(readOwnership(vault())?.bundleGeneration).toBe(1);

    // Opening the next session — before any new finalize — reconciles ownership
    // to the ON-DISK generation (2): alpha's prior fingerprint is carried
    // verbatim (unchanged), beta — net-new since the gen-1 snapshot — is
    // fingerprinted fresh. The result matches the ground-truth gen-2 ownership.
    const recovery = await bundle.beginStagedGeneration({ mode: 'published' });
    recovery.abort();

    const reconciled = readOwnership(vault());
    expect(reconciled?.bundleGeneration).toBe(2);
    expect(Object.keys(reconciled?.pages ?? {}).sort()).toEqual(['pages/alpha.md', 'pages/beta.md']);
    const betaContent = fs.readFileSync(path.join(okfDir(), 'pages/beta.md'), 'utf8');
    expect(reconciled?.pages['pages/beta.md'].fingerprint).toBe(sha256Hex(betaContent));
    expect(reconciled).toEqual(groundTruth);
  });
});

describe('OKF ownership carry-forward (Task 7.1)', () => {
  // The core data-preservation fix: ownership must mean "what Myco last WROTE",
  // never "what's currently on disk". A run that carries a page forward
  // untouched must NOT re-fingerprint that page — otherwise a human hand-edit
  // made between runs gets recorded as Myco's own output and a later synthesis
  // silently clobbers it.
  it('a hand-edited untouched page keeps its ORIGINAL Myco fingerprint across a carry-forward run', async () => {
    const bundle = makeBundle();
    const outputRoot = okfDir();

    // Run 1: publish P (pinned) plus a sibling so run 2 has something to stage.
    const first = await bundle.beginStagedGeneration({ mode: 'published' });
    first.stageDocument(contentDoc('pages/pinned'));
    first.stageDocument(contentDoc('pages/other'));
    await first.finalize({ inputsHash: 'gen-1' });

    const pinnedPath = path.join(outputRoot, 'pages/pinned.md');
    const originalPinned = fs.readFileSync(pinnedPath, 'utf8');
    const originalFingerprint = readOwnership(vault())?.pages['pages/pinned.md'].fingerprint;
    expect(originalFingerprint).toBe(sha256Hex(originalPinned));

    // A human hand-edits P directly on disk between runs.
    const handEdited = `${originalPinned}\nHuman correction.\n`;
    fs.writeFileSync(pinnedPath, handEdited);

    // Run 2: synthesis re-stages ONLY 'other'; P is carried forward untouched.
    const second = await bundle.beginStagedGeneration({ mode: 'published' });
    second.stageDocument({
      path: 'pages/other.md',
      frontmatter: { type: 'note', title: 'pages/other', description: 'Refreshed.', timestamp: '2026-07-05T00:00:00Z' },
      body: 'Refreshed other.',
    });
    await second.finalize({ inputsHash: 'gen-2' });

    // The hand-edit survived on disk (Task 3.3) ...
    expect(fs.readFileSync(pinnedPath, 'utf8')).toBe(handEdited);
    // ... and ownership STILL records Myco's ORIGINAL fingerprint, not the
    // hand-edit's hash — so isHandEdited(P) stays true.
    const ownership2 = readOwnership(vault());
    expect(ownership2?.bundleGeneration).toBe(2);
    expect(ownership2?.pages['pages/pinned.md'].fingerprint).toBe(originalFingerprint);
    expect(ownership2?.pages['pages/pinned.md'].fingerprint).not.toBe(sha256Hex(handEdited));
    expect(isHandEdited('pages/pinned.md', handEdited, ownership2)).toBe(true);

    // Run 3: synthesis DOES re-stage P → Myco wrote it this run, so ownership
    // re-fingerprints to the new content (isHandEdited false again).
    const third = await bundle.beginStagedGeneration({ mode: 'published' });
    third.stageDocument({
      path: 'pages/pinned.md',
      frontmatter: { type: 'note', title: 'pages/pinned', description: 'Refreshed pinned.', timestamp: '2026-07-05T00:00:00Z' },
      body: 'Refreshed pinned body.',
    });
    await third.finalize({ inputsHash: 'gen-3' });

    const ownership3 = readOwnership(vault());
    const newPinned = fs.readFileSync(pinnedPath, 'utf8');
    expect(ownership3?.pages['pages/pinned.md'].fingerprint).toBe(sha256Hex(newPinned));
    expect(isHandEdited('pages/pinned.md', newPinned, ownership3)).toBe(false);
  });

  it('a human-authored page never in ownership stays OUT of ownership after a carry-forward run', async () => {
    const bundle = makeBundle();
    const outputRoot = okfDir();

    const first = await bundle.beginStagedGeneration({ mode: 'published' });
    first.stageDocument(contentDoc('pages/alpha'));
    await first.finalize({ inputsHash: 'gen-1' });

    // A human drops a page directly into the published tree — Myco never wrote it.
    fs.writeFileSync(
      path.join(outputRoot, 'pages/human.md'),
      '---\ntype: note\ntitle: Human\ndescription: By a person.\ntimestamp: 2026-07-05T00:00:00Z\n---\n\nHand-authored.\n',
    );

    // A carry-forward run stages an unrelated fresh page.
    const second = await bundle.beginStagedGeneration({ mode: 'published' });
    second.stageDocument(contentDoc('pages/beta'));
    await second.finalize({ inputsHash: 'gen-2' });

    // The human page survives on disk but is NEVER adopted into Myco ownership,
    // so okf_write_page's refine-not-clobber still rejects it as not_myco_owned.
    expect(fs.existsSync(path.join(outputRoot, 'pages/human.md'))).toBe(true);
    const ownership = readOwnership(vault());
    expect(ownership?.pages['pages/human.md']).toBeUndefined();
    expect(Object.keys(ownership?.pages ?? {}).sort()).toEqual(['pages/alpha.md', 'pages/beta.md']);
  });

  it('crash recovery carries a hand-edited page ORIGINAL fingerprint — it does not adopt the edit', async () => {
    const bundle = makeBundle();
    const outputRoot = okfDir();

    // Publish alpha (Myco); capture its original fingerprint.
    const first = await bundle.beginStagedGeneration({ mode: 'published' });
    first.stageDocument(contentDoc('pages/alpha'));
    await first.finalize({ inputsHash: 'gen-1' });
    const alphaPath = path.join(outputRoot, 'pages/alpha.md');
    const original = fs.readFileSync(alphaPath, 'utf8');
    const originalFingerprint = readOwnership(vault())?.pages['pages/alpha.md'].fingerprint;
    expect(originalFingerprint).toBe(sha256Hex(original));

    // A human hand-edits alpha on disk; ownership.json still holds F0 at gen 1.
    const handEdited = `${original}\nHuman correction.\n`;
    fs.writeFileSync(alphaPath, handEdited);

    // Simulate a crash DURING a carry-forward run: the marker advanced to gen 2
    // (the swapped-in tree carried the hand-edited alpha forward) but the gen-2
    // ownership write never landed — ownership.json is still the gen-1 file.
    const markerPath = path.join(outputRoot, '.myco-okf-maintain.json');
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    marker.bundle_generation = 2;
    fs.writeFileSync(markerPath, JSON.stringify(marker, null, 2));

    // Recovery on the next session open must CARRY alpha's original fingerprint,
    // NOT cold-recompute it from the hand-edited disk content — so isHandEdited
    // stays TRUE and a later synthesis won't clobber the human's edit.
    const recovery = await bundle.beginStagedGeneration({ mode: 'published' });
    recovery.abort();

    const reconciled = readOwnership(vault());
    expect(reconciled?.bundleGeneration).toBe(2);
    expect(reconciled?.pages['pages/alpha.md'].fingerprint).toBe(originalFingerprint);
    expect(reconciled?.pages['pages/alpha.md'].fingerprint).not.toBe(sha256Hex(handEdited));
    expect(isHandEdited('pages/alpha.md', handEdited, reconciled)).toBe(true);
  });

  it('mutateConcepts (saveConcept) never adopts a human-authored page into ownership', async () => {
    const bundle = makeBundle();
    const outputRoot = okfDir();

    // Publish one Myco-owned concept with FULL myco_strict frontmatter so the
    // editorial concept-mutation path can reconstruct + revalidate the tree.
    const first = await bundle.beginStagedGeneration({ mode: 'published' });
    first.stageDocument(mycoStrictDoc('concepts/one'));
    await first.finalize({ inputsHash: 'gen-1' });
    expect(readOwnership(vault())?.pages['concepts/one.md']).toBeDefined();

    // A human authors a page directly in the tree — Myco never owned it (also
    // myco_strict-valid, so it survives the whole-tree revalidation).
    fs.writeFileSync(
      path.join(outputRoot, 'concepts/human.md'),
      '---\ntype: note\ntitle: Human\ndescription: By a person.\ntimestamp: 2026-07-05T00:00:00Z\ntags:\n  - h\nmyco_id: concepts/human\n---\n\nHand-authored.\n',
    );

    // Edit a DIFFERENT concept through the editorial surface. mutateConcepts
    // republishes the WHOLE reconstructed tree (one + human + two) ...
    await bundle.saveConcept({
      id: 'concepts/two',
      markdown:
        '---\ntype: concept\ntitle: Two\ndescription: Second concept.\ntimestamp: 2026-07-05T00:00:00Z\ntags:\n  - x\nmyco_id: concepts/two\n---\n\nBody of two.\n',
      provenance: { actor: 'cli' },
    });

    // ... but the human page is NOT adopted into ownership — changedConceptPaths
    // only re-fingerprints the concept the edit actually changed.
    const ownership = readOwnership(vault());
    expect(ownership?.pages['concepts/human.md']).toBeUndefined();
    expect(ownership?.pages['concepts/one.md']).toBeDefined();
    expect(ownership?.pages['concepts/two.md']).toBeDefined();
  });
});
