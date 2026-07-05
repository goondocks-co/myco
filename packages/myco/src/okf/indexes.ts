import path from 'node:path';
import { escapeInlineText, escapeLinkLabel } from './serialize.js';
import type { OkfConcept } from './types.js';

/**
 * Deterministic directory index generation. No LLM calls: indexes are pure
 * functions of the concept set. Non-root indexes are plain markdown (no
 * frontmatter); the frontmatter-bearing root index is rendered separately by
 * `renderRootIndex` and replaces this map's plain `index.md` entry when the
 * bundle is assembled.
 */

export interface IndexEntryInput {
  path: string;
  type: string;
  title: string;
  description: string;
}

interface DirNode {
  /** Bundle-relative directory path; '' is the bundle root. */
  dir: string;
  concepts: OkfConcept[];
  subdirs: Set<string>;
}

function indexKeyForDir(dir: string): string {
  return dir === '' ? 'index.md' : `${dir}/index.md`;
}

function conceptTitle(concept: OkfConcept): string {
  const title = concept.frontmatter.title;
  if (typeof title === 'string' && title.trim() !== '') return title;
  return path.posix.basename(concept.id);
}

function conceptDescription(concept: OkfConcept): string | null {
  const description = concept.frontmatter.description;
  if (typeof description === 'string' && description.trim() !== '') return description;
  return null;
}

/** Recursive concept census for a directory subtree. */
function subtreeStats(concepts: OkfConcept[]): { count: number; types: Set<string>; single: OkfConcept | null } {
  const types = new Set<string>();
  for (const concept of concepts) types.add(concept.frontmatter.type);
  return { count: concepts.length, types, single: concepts.length === 1 ? concepts[0] : null };
}

/**
 * Directory summary, per spec: a single child's description is reused when it has
 * one; a homogeneous subtree summarizes as "N <type> concepts."; a mixed subtree
 * as "N concepts across M types.".
 */
function directorySummary(subtree: OkfConcept[]): string {
  const { count, types, single } = subtreeStats(subtree);
  if (single) {
    const description = conceptDescription(single);
    if (description) return description;
  }
  if (types.size === 1) {
    const [type] = [...types];
    return `${count} ${type} concept${count === 1 ? '' : 's'}.`;
  }
  return `${count} concepts across ${types.size} types.`;
}

function entryLine(concept: OkfConcept, fromDir: string): string {
  const relPath = path.posix.relative(fromDir, concept.path);
  const label = escapeLinkLabel(conceptTitle(concept));
  const description = conceptDescription(concept);
  // Descriptions sit on link lines — escape link metacharacters, not just HTML.
  return description ? `* [${label}](${relPath}) - ${escapeLinkLabel(description)}` : `* [${label}](${relPath})`;
}

/**
 * Generate an `index.md` for every directory that has at least one concept
 * beneath it. Keys are directory-relative index paths ('index.md',
 * 'spores/index.md', ...); values are rendered markdown. Entries group by
 * `frontmatter.type` (headings sorted), sorted by title then path; a
 * `## Directories` section lists direct subdirectories with summaries.
 */
export function generateDirectoryIndexes(concepts: OkfConcept[]): Map<string, string> {
  const nodes = new Map<string, DirNode>();
  const subtreeConcepts = new Map<string, OkfConcept[]>();

  const nodeFor = (dir: string): DirNode => {
    let node = nodes.get(dir);
    if (!node) {
      node = { dir, concepts: [], subdirs: new Set() };
      nodes.set(dir, node);
    }
    return node;
  };

  for (const concept of concepts) {
    const dir = path.posix.dirname(concept.path);
    const ownDir = dir === '.' ? '' : dir;
    nodeFor(ownDir).concepts.push(concept);

    // Register the full ancestor chain and accumulate recursive membership.
    let current = ownDir;
    for (;;) {
      const bucket = subtreeConcepts.get(current) ?? [];
      bucket.push(concept);
      subtreeConcepts.set(current, bucket);
      if (current === '') break;
      const parentDir = path.posix.dirname(current);
      const parent = parentDir === '.' ? '' : parentDir;
      nodeFor(parent).subdirs.add(current);
      current = parent;
    }
  }

  const out = new Map<string, string>();
  for (const dir of [...nodes.keys()].sort()) {
    const node = nodes.get(dir)!;
    if ((subtreeConcepts.get(dir) ?? []).length === 0) continue;

    const parts: string[] = [dir === '' ? '# Index' : `# ${escapeInlineText(dir)}`];

    const byType = new Map<string, OkfConcept[]>();
    for (const concept of node.concepts) {
      const group = byType.get(concept.frontmatter.type) ?? [];
      group.push(concept);
      byType.set(concept.frontmatter.type, group);
    }
    for (const type of [...byType.keys()].sort()) {
      const group = byType
        .get(type)!
        .slice()
        .sort((a, b) => conceptTitle(a).localeCompare(conceptTitle(b)) || a.path.localeCompare(b.path));
      parts.push(`## ${escapeInlineText(type)}`, group.map((concept) => entryLine(concept, dir)).join('\n'));
    }

    const subdirs = [...node.subdirs].filter((sub) => (subtreeConcepts.get(sub) ?? []).length > 0).sort();
    if (subdirs.length > 0) {
      const lines = subdirs.map((sub) => {
        const basename = path.posix.basename(sub);
        return `* [${escapeLinkLabel(basename)}](${basename}/index.md) - ${escapeLinkLabel(directorySummary(subtreeConcepts.get(sub)!))}`;
      });
      parts.push('## Directories', lines.join('\n'));
    }

    out.set(indexKeyForDir(dir), parts.join('\n\n') + '\n');
  }
  return out;
}
