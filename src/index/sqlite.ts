import Database from 'better-sqlite3';

export interface IndexedNote {
  path: string;
  type: string;
  id: string;
  title: string;
  content: string;
  frontmatter: Record<string, unknown>;
  created: string;
  updated_at?: string;
}

export interface QueryOptions {
  type?: string;
  id?: string;
  limit?: number;
  since?: string;
  /** Filter by updated_at — returns notes with updated_at >= this ISO string. */
  updatedSince?: string;
  /** Filter by frontmatter fields using json_extract. Applied before LIMIT. */
  frontmatter?: Record<string, string>;
}

export class MycoIndex {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS notes (
        path TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        id TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL DEFAULT '',
        frontmatter TEXT NOT NULL DEFAULT '{}',
        created TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_notes_type ON notes(type);
      CREATE INDEX IF NOT EXISTS idx_notes_id ON notes(id);
      CREATE INDEX IF NOT EXISTS idx_notes_created ON notes(created);
    `);
  }

  getPragma(name: string): unknown {
    return this.db.pragma(`${name}`, { simple: true });
  }

  getDb(): Database.Database {
    return this.db;
  }

  upsertNote(note: Omit<IndexedNote, 'updated_at'>): void {
    const stmt = this.db.prepare(`
      INSERT INTO notes (path, type, id, title, content, frontmatter, created, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(path) DO UPDATE SET
        type = excluded.type,
        id = excluded.id,
        title = excluded.title,
        content = excluded.content,
        frontmatter = excluded.frontmatter,
        created = excluded.created,
        updated_at = datetime('now')
    `);
    stmt.run(
      note.path,
      note.type,
      note.id,
      note.title,
      note.content,
      JSON.stringify(note.frontmatter),
      note.created,
    );
  }

  getNoteByPath(notePath: string): IndexedNote | null {
    const row = this.db.prepare('SELECT * FROM notes WHERE path = ?').get(notePath) as any;
    if (!row) return null;
    return { ...row, frontmatter: JSON.parse(row.frontmatter) };
  }

  deleteNote(notePath: string): void {
    this.db.prepare('DELETE FROM notes WHERE path = ?').run(notePath);
  }

  query(options: QueryOptions): IndexedNote[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (options.type) {
      conditions.push('type = ?');
      params.push(options.type);
    }
    if (options.id) {
      conditions.push('id = ?');
      params.push(options.id);
    }
    if (options.since) {
      conditions.push('created >= ?');
      params.push(options.since);
    }
    if (options.updatedSince) {
      conditions.push('updated_at >= ?');
      params.push(options.updatedSince);
    }
    if (options.frontmatter) {
      for (const [key, value] of Object.entries(options.frontmatter)) {
        conditions.push(`json_extract(frontmatter, '$.' || ?) = ?`);
        params.push(key, value);
      }
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limitClause = options.limit ? 'LIMIT ?' : '';
    if (options.limit) params.push(options.limit);
    const sql = `SELECT * FROM notes ${where} ORDER BY created DESC ${limitClause}`;

    const rows = this.db.prepare(sql).all(...params) as any[];
    return rows.map((row) => ({ ...row, frontmatter: JSON.parse(row.frontmatter) }));
  }

  queryByIds(ids: string[]): IndexedNote[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    const sql = `SELECT * FROM notes WHERE id IN (${placeholders})`;
    const rows = this.db.prepare(sql).all(...ids) as any[];
    return rows.map((row) => ({ ...row, frontmatter: JSON.parse(row.frontmatter) }));
  }

  close(): void {
    this.db.close();
  }
}
