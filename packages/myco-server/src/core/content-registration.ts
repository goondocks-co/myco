import type { PreparedStatement,RelationalStore } from './adapters.js';
import type { Fragment } from '../ingest/projections.js';

export interface ContentRegistration {
  projectId:string;key:string;size:number;mediaType:string;tokenId:string;receivedAt:number;generation:string;
  authority:Fragment;
}

/** Member uploads and internally verified bodies publish the same immutable registration. */
export function registerContentStatement(db:RelationalStore,row:ContentRegistration):PreparedStatement {
  return db.prepare(`INSERT INTO blobs(project_id,key,size,media_type,token_id,received_at,generation)
    SELECT ?,?,?,?,?,?,? WHERE ${row.authority.sql} ON CONFLICT(project_id,key) DO NOTHING`)
    .bind(row.projectId,row.key,row.size,row.mediaType,row.tokenId,row.receivedAt,row.generation,...row.authority.params);
}
