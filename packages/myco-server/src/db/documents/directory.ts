import type { RelationalStore } from '../../core/adapters.js';
import type { ChunkRow, PageRow } from '../../content/document-reader.js';
import { registeredObjectKeySql } from '../../core/blob-objects.js';
import { jsonPages } from '../json-pages.js';
import { read, readSet } from '../index.js';

const chunkColumns = `c.chunk_no,c.blob_key,c.kind,c.bytes,c.source_id,${registeredObjectKeySql('c.project_id', 'c.blob_key')} object_key`;
const exists = read<[string, string, number], { present: number }>({ name: 'publication.hasChunks', sql: `SELECT EXISTS(
  SELECT 1 FROM session_chunks WHERE project_id=? AND session_id=? AND generation=?) AS present` });

export async function generationHasChunks(db: RelationalStore, project: string, session: string, generation: number): Promise<boolean> {
  const [rows] = await readSet(db, exists.bind(project, session, generation));
  return rows[0]!.present === 1;
}
const tail = read<[string, string, number], ChunkRow>({ name: 'publication.tail', sql: `SELECT ${chunkColumns}
  FROM session_chunks c WHERE c.project_id=?1 AND c.session_id=?2 AND c.generation=?3 AND c.kind='page' ORDER BY c.chunk_no DESC LIMIT 1` });
const chunk = read<[string, string, number, number], ChunkRow>({ name: 'publication.chunk', sql: `SELECT ${chunkColumns}
  FROM session_chunks c WHERE c.project_id=?1 AND c.session_id=?2 AND c.generation=?3 AND c.chunk_no=?4` });
const pages = read<[string, string, number, string], PageRow>({ name: 'publication.openPages', sql: `SELECT p.owner,p.page,p.chunk_no,p.records,p.bytes,p.sealed
  FROM json_each(?4) j CROSS JOIN session_pages p ON p.project_id=?1 AND p.session_id=?2 AND p.generation=?3 AND p.owner=j.value AND p.sealed=0 ORDER BY p.owner,p.page` });
const page = read<[string, string, number, string, number], PageRow>({ name: 'publication.page', sql: `SELECT owner,page,chunk_no,records,bytes,sealed
  FROM session_pages WHERE project_id=?1 AND session_id=?2 AND generation=?3 AND owner=?4 AND page=?5` });
const sealed = read<[string, string, number, string], { owner: string }>({ name: 'publication.sealedPage', sql: `SELECT j.value AS owner
  FROM json_each(?4) j WHERE EXISTS(SELECT 1 FROM session_pages p WHERE p.project_id=?1 AND p.session_id=?2 AND p.generation=?3 AND p.owner=j.value AND p.sealed=1)` });


/** A generation's catalog, loaded only for the tail and owners the pass visits. */
export class PublicationDirectory {
  readonly chunks = new Map<number, ChunkRow>();
  constructor(private readonly db: RelationalStore, private readonly project: string, private readonly session: string,
    readonly generation: number, private readonly admit: (statements: number) => void) {}

  async tail(): Promise<number | null> {
    this.admit(1);
    const [rows] = await readSet(this.db, tail.bind(this.project, this.session, this.generation));
    for (const row of rows) this.chunks.set(row.chunk_no, row);
    return rows[0]?.chunk_no ?? null;
  }

  async chunk(number: number): Promise<ChunkRow> {
    const held = this.chunks.get(number);
    if (held) return held;
    this.admit(1);
    const [rows] = await readSet(this.db, chunk.bind(this.project, this.session, this.generation, number));
    const row = rows[0];
    if (!row) throw new Error('document_chunk_missing');
    this.chunks.set(number, row);
    return row;
  }

  async owners(owners: readonly string[]): Promise<{ pages: PageRow[]; sealed: string[] }> {
    const result: { pages: PageRow[]; sealed: string[] } = { pages: [], sealed: [] };
    for (const names of jsonPages(owners)) {
      this.admit(2);
      const keys = JSON.stringify(names);
      const [rows, closed] = await readSet(this.db, pages.bind(this.project, this.session, this.generation, keys),
        sealed.bind(this.project, this.session, this.generation, keys));
      result.pages.push(...rows);
      result.sealed.push(...closed.map(row => row.owner));
    }
    return result;
  }

  async page(owner: string, number: number): Promise<PageRow | undefined> {
    this.admit(1);
    const [rows] = await readSet(this.db, page.bind(this.project, this.session, this.generation, owner, number));
    return rows[0];
  }
}
