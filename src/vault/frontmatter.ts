import YAML from 'yaml';
import type { IndexedNote } from '../index/sqlite.js';
import type { PlanFrontmatter, SessionFrontmatter, SporeFrontmatter } from './types.js';

/** Strip YAML frontmatter from a markdown string, returning the body and parsed frontmatter. */
export function stripFrontmatter(raw: string): { body: string; frontmatter: Record<string, unknown> } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n*/);
  if (!match) return { body: raw.trim(), frontmatter: {} };

  let frontmatter: Record<string, unknown> = {};
  try {
    frontmatter = YAML.parse(match[1]) as Record<string, unknown>;
  } catch { /* malformed frontmatter */ }

  return { body: raw.slice(match[0].length).trim(), frontmatter };
}

export function planFm(note: IndexedNote): PlanFrontmatter {
  return note.frontmatter as unknown as PlanFrontmatter;
}

export function sessionFm(note: IndexedNote): SessionFrontmatter {
  return note.frontmatter as unknown as SessionFrontmatter;
}

export function sporeFm(note: IndexedNote): SporeFrontmatter {
  return note.frontmatter as unknown as SporeFrontmatter;
}
