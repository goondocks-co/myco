import type { IndexedNote } from '../index/sqlite.js';
import type { PlanFrontmatter, SessionFrontmatter, MemoryFrontmatter } from './types.js';

export function planFm(note: IndexedNote): PlanFrontmatter {
  return note.frontmatter as unknown as PlanFrontmatter;
}

export function sessionFm(note: IndexedNote): SessionFrontmatter {
  return note.frontmatter as unknown as SessionFrontmatter;
}

export function memoryFm(note: IndexedNote): MemoryFrontmatter {
  return note.frontmatter as unknown as MemoryFrontmatter;
}
