import path from 'node:path';
import { serializeConceptDoc } from './frontmatter.js';
import { conceptPathForId, OkfPathError } from './paths.js';
import { OKF_RESERVED_FILES, OKF_VERSION, type OkfConcept } from './types.js';

/**
 * Rendering for concept documents and the reserved root files.
 *
 * Escaping rule (spec "Frontmatter and markdown sanitization"): frontmatter-derived
 * text flowing into rendered indexes, the root index, the root log, and generated
 * guide text is escaped at render time. A concept's OWN frontmatter is data and is
 * stored verbatim; only text re-rendered into generated markdown is neutralized.
 */

/** Neutralize raw HTML in generated markdown text. */
export function escapeInlineText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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

/** POSIX-relative path from the directory of `fromPath` to the file of concept `toId`. */
export function relativeConceptHref(fromPath: string, toId: string): string {
  const fromDir = path.posix.dirname(fromPath);
  return path.posix.relative(fromDir === '.' ? '' : fromDir, conceptPathForId(toId));
}

/**
 * Render one concept to its bundle-relative path + document content.
 *
 * Provenance from `concept.source` is injected into frontmatter under `myco_*`
 * keys when the projector did not already set them, so every Myco-generated
 * concept carries stable source identity (`myco_id`) and passes `myco_strict`.
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
  const provenance: Record<string, unknown> = {
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
    const lines = input.sections.map(
      (section) => `* [${escapeLinkLabel(section.dir)}/](${section.dir}/index.md) - ${escapeLinkLabel(section.summary)}`,
    );
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
