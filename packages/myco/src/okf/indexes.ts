import path from 'node:path';
import { escapeInlineText, escapeLinkLabel } from './serialize.js';
import type { OkfConcept, OkfDocument } from './types.js';

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

/**
 * Bundle assemblers cast parsed frontmatter, so `type` may arrive as any YAML
 * value at runtime; narrow it the same way title/description are narrowed.
 */
function conceptType(concept: OkfConcept): string {
  const type: unknown = concept.frontmatter.type;
  if (typeof type === 'string' && type.trim() !== '') return type;
  return 'unknown';
}

/** Locale-independent comparison — index bytes must not vary by runtime locale or ICU build. */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function conceptDescription(concept: OkfConcept): string | null {
  const description = concept.frontmatter.description;
  if (typeof description === 'string' && description.trim() !== '') return description;
  return null;
}

/** Recursive concept census for a directory subtree. */
function subtreeStats(concepts: OkfConcept[]): { count: number; types: Set<string>; single: OkfConcept | null } {
  const types = new Set<string>();
  for (const concept of concepts) types.add(conceptType(concept));
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
      const type = conceptType(concept);
      const group = byType.get(type) ?? [];
      group.push(concept);
      byType.set(type, group);
    }
    for (const type of [...byType.keys()].sort(compareStrings)) {
      const group = byType
        .get(type)!
        .slice()
        .sort((a, b) => compareStrings(conceptTitle(a), conceptTitle(b)) || compareStrings(a.path, b.path));
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

// ---------------------------------------------------------------------------
// OKF v0.1 document-based index generation (Task 1.3) — mirrors
// reference_agent/bundle/index.py's `_build_index_text`/`regenerate_indexes`
// byte-for-byte in structure: type-grouped `# <Type>` sections in sorted
// type-name order, a `# Subdirectories` pseudo-type for child directories,
// bullets sorted by title (case-folded), relative child-name links, and
// deepest-first directory processing so a child directory's summary exists
// before its parent's index references it. Unlike `generateDirectoryIndexes`
// above (the concept-era `## <Type>` format for the still-live `OkfConcept`
// bundle path), these indexes carry EMPTY frontmatter and single-`#` headers.
// ---------------------------------------------------------------------------

interface DocIndexEntry {
  type: string;
  title: string;
  link: string;
  desc: string;
}

function docTitle(doc: OkfDocument): string {
  const title = doc.frontmatter.title;
  if (typeof title === 'string' && title.trim() !== '') return title;
  return path.posix.basename(doc.path, '.md');
}

function docDescription(doc: OkfDocument): string {
  const description = doc.frontmatter.description;
  return typeof description === 'string' && description.trim() !== '' ? description : '';
}

/** `frontmatter.type` may arrive as any YAML value at runtime; narrow defensively. */
function docType(doc: OkfDocument): string {
  const type: unknown = doc.frontmatter.type;
  return typeof type === 'string' && type.trim() !== '' ? type : '';
}

/**
 * `_build_index_text` mirror: group entries by type (empty type → "Other"),
 * type sections in sorted type-name order, bullets within a section sorted
 * by `title.toLowerCase()`. A ` - {desc}` suffix is appended only when the
 * description is non-empty. No escaping — this mirrors the reference
 * verbatim; Task 1.4's validator is the conformance backstop.
 */
function buildIndexBody(entries: DocIndexEntry[]): string {
  const grouped = new Map<string, Array<{ title: string; link: string; desc: string }>>();
  for (const { type, title, link, desc } of entries) {
    const key = type || 'Other';
    const group = grouped.get(key) ?? [];
    group.push({ title, link, desc });
    grouped.set(key, group);
  }

  const sections = [...grouped.keys()].sort(compareStrings).map((type) => {
    const lines = [`# ${type}`, ''];
    const group = grouped
      .get(type)!
      .slice()
      .sort((a, b) => compareStrings(a.title.toLowerCase(), b.title.toLowerCase()));
    for (const { title, link, desc } of group) {
      lines.push(desc ? `* [${title}](${link}) - ${desc}` : `* [${title}](${link})`);
    }
    return lines.join('\n');
  });
  return sections.join('\n\n') + '\n';
}

/**
 * Deterministic stand-in for the reference's LLM `synthesize()`: a directory
 * with exactly one entry that carries a description reuses it verbatim;
 * otherwise a derived summary — "N <type> concepts" for a homogeneous
 * directory, "N concepts across M types" for a mixed one. Pure function of
 * the directory's immediate entries; never calls out to a model.
 */
function docDirectorySummary(entries: DocIndexEntry[]): string {
  if (entries.length === 1 && entries[0].desc) return entries[0].desc;
  const types = new Set(entries.map((entry) => entry.type || 'Other'));
  if (types.size === 1) {
    const [type] = types;
    return `${entries.length} ${type} concept${entries.length === 1 ? '' : 's'}`;
  }
  return `${entries.length} concepts across ${types.size} types`;
}

/**
 * Generate one `index.md` {@link OkfDocument} per directory with at least one
 * document beneath it — mirrors `regenerate_indexes`/`_directories_to_index`.
 * `docs` are the bundle's rendered content documents; the returned array
 * holds only the generated indexes, never the input docs. An existing
 * `index.md` among `docs` is skipped when building entries (reserved
 * filename) but its directory is still registered.
 *
 * Index documents carry frontmatter `{}` — a deliberate escape from
 * `OkfFrontmatter`'s required `type` field: they are plain markdown with no
 * `---` block at all, unlike an ordinary rendered `OkfDocument`, which always
 * satisfies the four-key write-time floor.
 */
export function generateIndexes(docs: OkfDocument[]): OkfDocument[] {
  const filesByDir = new Map<string, OkfDocument[]>();
  const subdirsByDir = new Map<string, Set<string>>();
  const allDirs = new Set<string>();

  const registerDir = (dir: string): void => {
    let current = dir;
    allDirs.add(current);
    while (current !== '') {
      const rawParent = path.posix.dirname(current);
      const parent = rawParent === '.' ? '' : rawParent;
      const siblings = subdirsByDir.get(parent) ?? new Set<string>();
      siblings.add(path.posix.basename(current));
      subdirsByDir.set(parent, siblings);
      allDirs.add(parent);
      current = parent;
    }
  };

  for (const doc of docs) {
    const rawDir = path.posix.dirname(doc.path);
    const dir = rawDir === '.' ? '' : rawDir;
    registerDir(dir);

    if (path.posix.basename(doc.path) === 'index.md') continue; // reserved — never becomes an entry
    const files = filesByDir.get(dir) ?? [];
    files.push(doc);
    filesByDir.set(dir, files);
  }

  // Deepest-first: a subdirectory's summary must exist before its parent's
  // index references it. Ties break on the directory path itself.
  const dirDepth = (dir: string): number => (dir === '' ? 0 : dir.split('/').length);
  const orderedDirs = [...allDirs].sort((a, b) => dirDepth(b) - dirDepth(a) || compareStrings(a, b));

  const dirDescriptions = new Map<string, string>();
  const indexes: OkfDocument[] = [];

  for (const dir of orderedDirs) {
    const entries: DocIndexEntry[] = (filesByDir.get(dir) ?? []).map((doc) => ({
      type: docType(doc),
      title: docTitle(doc),
      link: path.posix.basename(doc.path),
      desc: docDescription(doc),
    }));

    for (const sub of [...(subdirsByDir.get(dir) ?? [])].sort(compareStrings)) {
      const childDir = dir === '' ? sub : `${dir}/${sub}`;
      entries.push({
        type: 'Subdirectories',
        title: sub,
        link: `${sub}/index.md`,
        desc: dirDescriptions.get(childDir) ?? '',
      });
    }

    if (entries.length === 0) continue;

    const indexPath = dir === '' ? 'index.md' : `${dir}/index.md`;
    indexes.push({ path: indexPath, frontmatter: {} as OkfDocument['frontmatter'], body: buildIndexBody(entries) });

    if (dir === '') continue; // root has no parent to summarize for
    dirDescriptions.set(dir, docDirectorySummary(entries));
  }

  return indexes;
}
