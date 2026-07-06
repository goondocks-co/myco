import path from 'node:path';
import { parseConceptDoc, serializeConceptDoc, serializeOkfFrontmatter } from './frontmatter.js';
import { conceptPathForId, OkfPathError } from './paths.js';
import { OKF_RESERVED_FILES, OKF_VERSION, type OkfConcept, type OkfDocument } from './types.js';

/**
 * Rendering for concept documents and the reserved root files.
 *
 * Escaping rule (spec "Frontmatter and markdown sanitization"): frontmatter-derived
 * text flowing into rendered indexes, the root index, the root log, and generated
 * guide text is escaped at render time. A concept's OWN frontmatter is data and is
 * stored verbatim; only text re-rendered into generated markdown is neutralized.
 */

/**
 * Neutralize raw HTML in generated markdown text. Newlines collapse to a
 * single space: every consumer interpolates into line-oriented constructs
 * (headings, bullets, log lines), where an embedded newline would inject
 * arbitrary markdown structure.
 */
export function escapeInlineText(text: string): string {
  return text
    .replace(/[\r\n]+/g, ' ')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Escape text used as a markdown link label: raw HTML plus link metacharacters. */
export function escapeLinkLabel(text: string): string {
  return escapeInlineText(text)
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

const RESERVED_BASENAMES = new Set<string>(OKF_RESERVED_FILES);

/**
 * POSIX-relative path from the directory of `fromPath` to the file of concept
 * `toId`. Link targets must be derivation-produced ids — an id carrying
 * whitespace, parentheses, or angle brackets (all percent-encoded by
 * `deriveConceptId`) would break or reshape the markdown link, so those are
 * rejected rather than emitted.
 */
export function relativeConceptHref(fromPath: string, toId: string): string {
  const fromDir = path.posix.dirname(fromPath);
  const href = path.posix.relative(fromDir === '.' ? '' : fromDir, conceptPathForId(toId));
  if (/[\s()<>]/.test(href)) {
    throw new OkfPathError(`unsafe_link_target: ${JSON.stringify(toId)} is not a derivation-produced concept id`);
  }
  return href;
}

/**
 * Render one concept to its bundle-relative path + document content.
 *
 * Provenance from `concept.source` is injected into frontmatter under `myco_*`
 * keys when the projector did not already set them, so every Myco-generated
 * concept carries stable source identity (`myco_id`) and passes `myco_strict`.
 *
 * Canonical concepts (`sourceKind === 'okf_concept'` — agent-maintained
 * concepts and the generated guide) are the source of truth: their own
 * frontmatter is complete, so ONLY the `myco_id` identity anchor is injected.
 * Injecting the projection-provenance fields (`myco_source_hash`, the
 * mtime-based `myco_source_updated_at`, etc.) would rewrite the file on the
 * next maintain — non-deterministic churn on a git-committed bundle.
 *
 * Outgoing links render as a deterministic `## Related` section.
 */
export function renderConcept(concept: OkfConcept): { path: string; content: string } {
  const derivedPath = conceptPathForId(concept.id);
  if (concept.path !== derivedPath) {
    throw new OkfPathError(
      `path_identity_violation: concept path ${JSON.stringify(concept.path)} must equal ${JSON.stringify(derivedPath)}`,
    );
  }
  if (RESERVED_BASENAMES.has(path.posix.basename(derivedPath))) {
    throw new OkfPathError(
      `reserved_filename: ${JSON.stringify(derivedPath)} collides with a reserved bundle file`,
    );
  }

  const fm: Record<string, unknown> = { ...concept.frontmatter };
  const source = concept.source;
  const provenance: Record<string, unknown> =
    source.sourceKind === 'okf_concept'
      ? { myco_id: source.id }
      : {
          myco_id: source.id,
          myco_source_kind: source.sourceKind,
          myco_project: source.projectId ?? undefined,
          myco_machine_id: source.machineId,
          myco_source_hash: source.sourceHash,
          myco_source_updated_at: source.sourceUpdatedAt,
          myco_projection_version: source.projectionVersion,
          myco_generated_by_run_ref: source.generatedByRunId ?? undefined,
        };
  for (const [key, value] of Object.entries(provenance)) {
    if (value !== undefined && fm[key] === undefined) fm[key] = value;
  }
  if (concept.stale) fm.stale = true;

  let body = concept.body;
  if (concept.links.length > 0) {
    const lines = concept.links.map(
      (link) => `- [${escapeLinkLabel(link.label)}](${relativeConceptHref(derivedPath, link.to)}) — ${link.reason}`,
    );
    body = `${body}\n\n## Related\n\n${lines.join('\n')}`;
  }

  return { path: derivedPath, content: serializeConceptDoc(fm, body) };
}

/**
 * Render an OKF v0.1 document — the portable-wiki document Phase 2 synthesis
 * produces. Unlike {@link renderConcept}, no provenance is injected: the
 * frontmatter is exactly what the caller supplies, subject to the OKF
 * write-time floor (`type`/`title`/`description`/`timestamp` non-empty).
 */
export function renderOkfDocument(doc: OkfDocument): { path: string; content: string } {
  const yamlText = serializeOkfFrontmatter(doc.frontmatter);
  const canonicalBody = doc.body.replace(/\r\n/g, '\n').replace(/\n+$/, '');
  const head = `---\n${yamlText}---\n`;
  return { path: doc.path, content: canonicalBody === '' ? head : `${head}\n${canonicalBody}\n` };
}

/**
 * Parse an OKF v0.1 document back from raw markdown. `path` is supplied by
 * the caller — a document's bundle-relative location is filesystem context,
 * not something recoverable from its own content — and defaults to `''`.
 */
export function parseOkfDocument(raw: string, filePath = ''): OkfDocument {
  const { frontmatter, body } = parseConceptDoc(raw);
  return { path: filePath, frontmatter: frontmatter as OkfDocument['frontmatter'], body };
}

/**
 * Render the bundle-root `index.md` — the only index that carries frontmatter,
 * led by `okf_version`. Sections render in caller order (the caller owns section
 * ordering and determinism).
 */
export function renderRootIndex(input: {
  title: string;
  description: string;
  timestamp: string;
  mycoProjectRef: string;
  inputsHash: string;
  generatedByRunRef?: string | null;
  sections: Array<{ dir: string; summary: string }>;
}): string {
  const fm: Record<string, unknown> = {
    okf_version: OKF_VERSION,
    type: 'Myco OKF Bundle',
    title: input.title,
    description: input.description,
    timestamp: input.timestamp,
    generator: 'myco',
    myco_project_ref: input.mycoProjectRef,
    inputs_hash: input.inputsHash,
  };
  if (input.generatedByRunRef != null) fm.generated_by_run_ref = input.generatedByRunRef;

  const bodyParts = [`# ${escapeInlineText(input.title)}`, escapeInlineText(input.description)];
  if (input.sections.length > 0) {
    const lines = input.sections.map((section) => {
      if (/[\s()<>]/.test(section.dir)) {
        throw new OkfPathError(`unsafe_link_target: section dir ${JSON.stringify(section.dir)} is not a safe path`);
      }
      return `* [${escapeLinkLabel(section.dir)}/](${section.dir}/index.md) - ${escapeLinkLabel(section.summary)}`;
    });
    bodyParts.push('## Contents', lines.join('\n'));
  }

  return serializeConceptDoc(fm, bodyParts.join('\n\n'), { keyOrder: 'insertion' });
}

export interface OkfLogEntry {
  date: string;
  lines: string[];
}

/**
 * Render the root `log.md`. Entries render in caller order — prepend-preserving
 * (newest first) is handled by the caller.
 */
export function renderRootLog(entries: OkfLogEntry[]): string {
  const sections = entries.map(
    (entry) =>
      `## ${escapeInlineText(entry.date)}\n\n${entry.lines.map((line) => `- ${escapeInlineText(line)}`).join('\n')}`,
  );
  return ['# Directory Update Log', ...sections].join('\n\n') + '\n';
}
