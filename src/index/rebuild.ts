import { VaultReader } from '../vault/reader.js';
import type { MycoIndex } from './sqlite.js';
import type { VaultNote } from '../vault/types.js';

export function indexNote(index: MycoIndex, vaultDir: string, relativePath: string): void {
  const reader = new VaultReader(vaultDir);
  const note = reader.readNote(relativePath);
  indexVaultNote(index, note);
}

function indexVaultNote(index: MycoIndex, note: VaultNote): void {
  const fm = note.frontmatter;
  const title = extractTitle(note.content) || ('id' in fm ? String(fm.id) : note.path);
  const created = 'started' in fm ? fm.started
    : 'created' in fm ? fm.created
    : 'joined' in fm ? fm.joined
    : new Date().toISOString();

  index.upsertNote({
    path: note.path,
    type: fm.type,
    id: 'id' in fm ? String(fm.id) : 'user' in fm ? String(fm.user) : note.path,
    title,
    content: note.content,
    frontmatter: fm as Record<string, unknown>,
    created: String(created),
  });
}

export function rebuildIndex(index: MycoIndex, vaultDir: string): number {
  const db = index.getDb();
  db.exec('DELETE FROM notes');

  const reader = new VaultReader(vaultDir);
  const notes = reader.readAllNotes();
  let count = 0;

  for (const note of notes) {
    indexVaultNote(index, note);
    count++;
  }

  return count;
}

function extractTitle(content: string): string {
  const match = content.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : '';
}
