import type { MycoIndex, IndexedNote } from '../../index/sqlite.js';

const WIKILINK_RE = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;

interface GraphInput {
  note_id: string;
  direction?: 'incoming' | 'outgoing' | 'both';
  depth?: number;
}

interface GraphLink {
  source: string;
  target: string;
  source_type: string;
  target_type: string;
  source_title: string;
  target_title: string;
}

interface GraphResult {
  note_id: string;
  links: GraphLink[];
}

function extractWikilinks(content: string): string[] {
  const links: string[] = [];
  let match;
  while ((match = WIKILINK_RE.exec(content)) !== null) {
    links.push(match[1]);
  }
  return links;
}

function findNoteById(index: MycoIndex, noteId: string): IndexedNote | null {
  const results = index.query({ id: noteId, limit: 1 });
  return results[0] ?? null;
}

export async function handleMycoGraph(
  index: MycoIndex,
  input: GraphInput,
): Promise<GraphResult> {
  const direction = input.direction ?? 'both';
  const depth = Math.min(input.depth ?? 1, 3);

  const visited = new Set<string>();
  const allLinks: GraphLink[] = [];

  function traverse(noteId: string, currentDepth: number): void {
    if (currentDepth > depth || visited.has(noteId)) return;
    visited.add(noteId);

    const note = findNoteById(index, noteId);

    // Outgoing: wikilinks in this note's content
    if (direction === 'outgoing' || direction === 'both') {
      if (note) {
        const targets = extractWikilinks(note.content);
        for (const target of targets) {
          const targetNote = findNoteById(index, target);
          allLinks.push({
            source: noteId,
            target,
            source_type: note.type,
            target_type: targetNote?.type ?? 'unknown',
            source_title: note.title,
            target_title: targetNote?.title ?? target,
          });
          if (currentDepth < depth) traverse(target, currentDepth + 1);
        }
      }
    }

    // Incoming: other notes whose content links to this note
    if (direction === 'incoming' || direction === 'both') {
      const allNotes = index.query({ limit: 500 });
      for (const n of allNotes) {
        if (n.id === noteId) continue;
        const links = extractWikilinks(n.content);
        if (links.includes(noteId)) {
          allLinks.push({
            source: n.id,
            target: noteId,
            source_type: n.type,
            target_type: note?.type ?? 'unknown',
            source_title: n.title,
            target_title: note?.title ?? noteId,
          });
          if (currentDepth < depth) traverse(n.id, currentDepth + 1);
        }
      }
    }
  }

  traverse(input.note_id, 1);

  // Deduplicate links
  const seen = new Set<string>();
  const unique = allLinks.filter((link) => {
    const key = `${link.source}->${link.target}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return { note_id: input.note_id, links: unique };
}

interface OrphansResult {
  orphans: Array<{ id: string; type: string; title: string; path: string }>;
}

export async function handleMycoOrphans(index: MycoIndex): Promise<OrphansResult> {
  const allNotes = index.query({ limit: 1000 });

  // Build maps of all links
  const hasOutgoing = new Set<string>();
  const isLinkedTo = new Set<string>();

  for (const note of allNotes) {
    const links = extractWikilinks(note.content);
    if (links.length > 0) hasOutgoing.add(note.id);
    for (const target of links) {
      isLinkedTo.add(target);
    }
    // Also check frontmatter session/plan refs
    const fm = note.frontmatter as Record<string, unknown>;
    if (fm.session && typeof fm.session === 'string') {
      isLinkedTo.add(fm.session);
    }
    if (fm.plan && typeof fm.plan === 'string') {
      isLinkedTo.add(fm.plan);
    }
  }

  const orphans = allNotes.filter((note) =>
    !hasOutgoing.has(note.id) && !isLinkedTo.has(note.id),
  ).map((note) => ({
    id: note.id,
    type: note.type,
    title: note.title,
    path: note.path,
  }));

  return { orphans };
}
