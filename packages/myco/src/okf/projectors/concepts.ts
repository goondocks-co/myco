import { sha256Hex } from '@myco/canopy/hash.js';
import { OkfFrontmatterError, parseConceptDoc, serializeConceptDoc } from '../frontmatter.js';
import {
  OKF_PROJECTION_VERSION,
  type OkfConcept,
  type OkfFrontmatter,
  type OkfValidationIssue,
} from '../types.js';

/**
 * Adoption of file-backed agent-maintained concepts under `okf/concepts/`.
 *
 * Adoption NEVER silently drops or rewrites a file: invalid input surfaces as
 * error-level issues (the bundle capability fails maintenance with these
 * diagnostics), and valid content is carried verbatim — frontmatter and body
 * untouched, unknown keys preserved.
 *
 * Citation rules (recorded spec deviation #7): a concept citing nothing gets
 * the WARNING `concept_missing_citation`; the hard ERROR
 * `concept_citation_dangling` fires only for declared `source_concepts`
 * entries under `concepts/` that don't resolve within the adopted set —
 * cross-namespace targets (spores/, canopy/) are verified by the bundle
 * capability, which sees the full concept universe.
 */

const CONCEPTS_PREFIX = 'concepts/';
/** Matches in-body markdown links to bundle-relative .md targets. */
const IN_BUNDLE_LINK = /\]\((?!https?:\/\/)[^)]*\.md(#[^)]*)?\)/;

export interface ConceptAdoptionInput {
  files: Array<{ bundleRelPath: string; raw: string; mtimeIso: string }>;
}

export interface ConceptAdoptionResult {
  concepts: OkfConcept[];
  /** Error-level entries fail maintenance; warning-level entries are advisory. */
  errors: OkfValidationIssue[];
}

export function adoptConcepts(input: ConceptAdoptionInput): ConceptAdoptionResult {
  const concepts: OkfConcept[] = [];
  const errors: OkfValidationIssue[] = [];

  const adoptedIds = new Set(
    input.files
      .filter((file) => file.bundleRelPath.startsWith(CONCEPTS_PREFIX) && file.bundleRelPath.endsWith('.md'))
      .map((file) => file.bundleRelPath.slice(0, -'.md'.length)),
  );

  for (const file of input.files) {
    const relPath = file.bundleRelPath;

    if (!relPath.startsWith(CONCEPTS_PREFIX)) {
      errors.push({
        level: 'error',
        code: 'deterministic_path_not_adoptable',
        path: relPath,
        message: `only files under "${CONCEPTS_PREFIX}" are agent-maintained; ${JSON.stringify(relPath)} is a deterministic projection path`,
      });
      continue;
    }
    if (!relPath.endsWith('.md')) {
      errors.push({
        level: 'error',
        code: 'unparseable_frontmatter',
        path: relPath,
        message: 'agent-maintained concepts must be .md files',
      });
      continue;
    }

    let frontmatter: Record<string, unknown>;
    let body: string;
    try {
      ({ frontmatter, body } = parseConceptDoc(file.raw));
    } catch (err) {
      const code = err instanceof OkfFrontmatterError ? err.code : 'unparseable_frontmatter';
      errors.push({
        level: 'error',
        code,
        path: relPath,
        message: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    if (typeof frontmatter.type !== 'string' || frontmatter.type.trim() === '') {
      errors.push({
        level: 'error',
        code: 'missing_type',
        path: relPath,
        message: 'agent-maintained concepts must declare a non-empty "type" (producer-defined values are allowed)',
      });
      continue;
    }

    // Citations: declared source_concepts must resolve; absent citations warn.
    const sourceConcepts = frontmatter.source_concepts;
    let hasCitation = false;
    if (Array.isArray(sourceConcepts) && sourceConcepts.length > 0) {
      hasCitation = true;
      for (const target of sourceConcepts) {
        if (typeof target !== 'string') continue;
        if (target.startsWith(CONCEPTS_PREFIX) && !adoptedIds.has(target)) {
          errors.push({
            level: 'error',
            code: 'concept_citation_dangling',
            path: relPath,
            message: `declared source concept ${JSON.stringify(target)} does not exist`,
          });
        }
      }
    }
    if (!hasCitation && IN_BUNDLE_LINK.test(body)) hasCitation = true;
    if (!hasCitation) {
      errors.push({
        level: 'warning',
        code: 'concept_missing_citation',
        path: relPath,
        message: 'concept declares no source_concepts and links to no bundle concept; consider citing its sources',
      });
    }

    const id = relPath.slice(0, -'.md'.length);
    concepts.push({
      id,
      path: relPath,
      frontmatter: frontmatter as OkfFrontmatter,
      body,
      source: {
        sourceKind: 'okf_concept',
        id,
        projectId: null,
        sourceHash: sha256Hex(serializeConceptDoc(frontmatter, body)),
        sourceUpdatedAt: file.mtimeIso,
        projectionVersion: OKF_PROJECTION_VERSION,
      },
      links: [],
    });
  }

  return { concepts, errors };
}
