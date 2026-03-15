import type { MycoIndex } from './sqlite.js';

export interface FtsResult {
  path: string;
  type: string;
  id: string;
  title: string;
  snippet: string;
  rank: number;
}

export interface FtsSearchOptions {
  type?: string;
  limit?: number;
}

export function initFts(index: MycoIndex): void {
  const db = index.getDb();
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
      path UNINDEXED,
      type UNINDEXED,
      id UNINDEXED,
      title,
      content,
      content='notes',
      content_rowid='rowid'
    );

    CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
      INSERT INTO notes_fts(rowid, path, type, id, title, content)
      VALUES (new.rowid, new.path, new.type, new.id, new.title, new.content);
    END;

    CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
      INSERT INTO notes_fts(notes_fts, rowid, path, type, id, title, content)
      VALUES ('delete', old.rowid, old.path, old.type, old.id, old.title, old.content);
    END;

    CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE ON notes BEGIN
      INSERT INTO notes_fts(notes_fts, rowid, path, type, id, title, content)
      VALUES ('delete', old.rowid, old.path, old.type, old.id, old.title, old.content);
      INSERT INTO notes_fts(rowid, path, type, id, title, content)
      VALUES (new.rowid, new.path, new.type, new.id, new.title, new.content);
    END;
  `);
}

export function searchFts(index: MycoIndex, query: string, options: FtsSearchOptions = {}): FtsResult[] {
  const db = index.getDb();
  const limit = options.limit ?? 20;

  let sql: string;
  const params: unknown[] = [query];

  if (options.type) {
    sql = `
      SELECT path, type, id, title,
             snippet(notes_fts, 4, '<mark>', '</mark>', '...', 40) AS snippet,
             rank
      FROM notes_fts
      WHERE notes_fts MATCH ? AND type = ?
      ORDER BY rank
      LIMIT ?
    `;
    params.push(options.type, limit);
  } else {
    sql = `
      SELECT path, type, id, title,
             snippet(notes_fts, 4, '<mark>', '</mark>', '...', 40) AS snippet,
             rank
      FROM notes_fts
      WHERE notes_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `;
    params.push(limit);
  }

  return db.prepare(sql).all(...params) as FtsResult[];
}
