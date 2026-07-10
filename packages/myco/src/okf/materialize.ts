/**
 * OKF page materialization — the ONE disk-writing path for the DB-resident
 * wiki (design: docs/superpowers/specs/2026-07-09-content-claim-system-design.md
 * §4 step 5). Reads one page revision (body + frontmatter), serializes it via
 * `okf/serialize.ts`, re-runs `publish-eligibility`'s `scanContentSet` over the
 * RENDERED file — the exact bytes about to land in the repo, frontmatter
 * included, a superset of the body-only scan `OkfStore.finalizeGeneration`
 * runs at DB-write time — and writes the one resulting file under the
 * caller-resolved published wiki root.
 *
 * Member-only BY CONSTRUCTION: the only caller is the content-claim
 * materialize handler (`daemon/api/content-claims-materialize.ts`), which the
 * Team Host routing table stamps `localhost-only` and which independently
 * asserts `isHostServedRequest` is false before reaching this module. There
 * is no host-side disk path to gate — post-#663 OKF generation is fully
 * DB-resident, and nothing else in this package writes a page to disk.
 *
 * `okf/output-root.ts` is deliberately not reused here: it resolves a BUNDLE
 * root for a full multi-page write (indexes, log, every concept, an
 * overwrite/collision policy for that batch shape) and has no runtime
 * importer post-#663. This writer targets exactly one page's file inside an
 * already-resolved published root — no bundle bookkeeping.
 */

import fs from 'node:fs';
import path from 'node:path';
import { renderOkfDocument } from './serialize.js';
import { scanContentSet, type PublishFinding } from './publish-eligibility.js';
import type { OkfFrontmatter } from './types.js';

/** One page revision's identity + content — exactly what a claim pins. */
export interface OkfPageContent {
  /** Bundle-relative path, e.g. 'architecture/foo.md'. Stable across a page's
   *  generations — only body/frontmatter change between revisions. */
  path: string;
  /** JSON-encoded {@link OkfFrontmatter}, exactly as stored on the revision row. */
  frontmatter: string;
  body: string;
}

export type OkfMaterializeRefusal =
  | { ok: false; reason: 'render_failed' | 'path_escape' }
  | { ok: false; reason: 'scan_blocked'; findings: PublishFinding[] };

export interface OkfMaterializeSuccess {
  ok: true;
  absolutePath: string;
  /** Bundle-relative path actually written (identical to input `path`). */
  relativePath: string;
  /** The exact bytes written — a test seam for byte-faithfulness checks. */
  content: string;
}

export type OkfMaterializeResult = OkfMaterializeSuccess | OkfMaterializeRefusal;

function parseFrontmatter(raw: string): OkfFrontmatter {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as OkfFrontmatter;
  } catch {
    /* fall through to the note-type default below */
  }
  return { type: 'note' };
}

/** True when `absolutePath` resolves at or under `root` — the same
 *  `path.relative` escape check `skills/publication.ts`'s
 *  `resolvePublishedSkillPaths` uses. */
function resolveWithinRoot(root: string, relativePath: string): string | null {
  const absolute = path.resolve(root, relativePath);
  const rel = path.relative(root, absolute);
  if (rel.startsWith('..') || path.isAbsolute(rel) || rel === '') return null;
  return absolute;
}

/**
 * Serialize + write one OKF page revision under `publishedRoot` (the
 * caller-resolved absolute published-wiki directory —
 * `<projectRoot>/<config.okf.maintain.output_path>`; this function does not
 * decide where the wiki lives).
 *
 * A publish-eligibility finding on the rendered content BLOCKS the write
 * entirely — nothing lands on disk, and the caller gets the finding set to
 * surface as a loud, named error.
 */
export function materializeOkfPage(publishedRoot: string, content: OkfPageContent): OkfMaterializeResult {
  let rendered: { path: string; content: string };
  try {
    rendered = renderOkfDocument({
      path: content.path,
      frontmatter: parseFrontmatter(content.frontmatter),
      body: content.body,
    });
  } catch {
    return { ok: false, reason: 'render_failed' };
  }

  const findings = scanContentSet([{ path: rendered.path, content: rendered.content }]);
  if (findings.length > 0) {
    return { ok: false, reason: 'scan_blocked', findings };
  }

  const absolutePath = resolveWithinRoot(publishedRoot, rendered.path);
  if (!absolutePath) {
    return { ok: false, reason: 'path_escape' };
  }

  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, rendered.content, 'utf-8');
  return { ok: true, absolutePath, relativePath: rendered.path, content: rendered.content };
}
