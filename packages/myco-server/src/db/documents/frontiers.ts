import type { PreparedStatement, RelationalStore } from '../../core/adapters.js';
import { PARSER_VERSION } from '../../constants.js';
import { write } from '../index.js';
import { prepareBound } from '../kernel/statement.js';

const publish=write<[string,number,string,number,number,string]>({name:'publication.saveFrontiers',sql:`INSERT INTO transcript_publication (project_id,transcript_id,generation,session_id,published_offset,segment_lines,
      open_prompt_id,unfinished,reply_unfinished,reply_latest_at,prompt_scheme,record_scheme,parser_version,state,failure,awaited_size,updated_at,
      placed_records,placed_digest,diagnostic)
    SELECT ?,json_extract(value,'$.t'),?,?,json_extract(value,'$.o'),json_extract(value,'$.l'),json_extract(value,'$.p'),json_extract(value,'$.u'),
      json_extract(value,'$.r'),json_extract(value,'$.a'),json_extract(value,'$.ps'),json_extract(value,'$.rs'),COALESCE(json_extract(value,'$.v'),?),json_extract(value,'$.s'),
      json_extract(value,'$.f'),json_extract(value,'$.w'),?,json_extract(value,'$.n'),json_extract(value,'$.d'),json_extract(value,'$.diag') FROM json_each(?) WHERE true
    ON CONFLICT (project_id,transcript_id,generation) DO UPDATE SET published_offset=excluded.published_offset,segment_lines=excluded.segment_lines,
      open_prompt_id=excluded.open_prompt_id,unfinished=excluded.unfinished,reply_unfinished=excluded.reply_unfinished,
      reply_latest_at=excluded.reply_latest_at,parser_version=excluded.parser_version,state=excluded.state,failure=excluded.failure,
      awaited_size=excluded.awaited_size,updated_at=excluded.updated_at,placed_records=excluded.placed_records,placed_digest=excluded.placed_digest,diagnostic=excluded.diagnostic`});
/** Upserts publisher frontiers, retaining an artifact's recorded parser version when supplied. */
export function publicationStatement(db:RelationalStore,projectId:string,sessionId:string,generation:number,now:number,
  rows:readonly Record<string,unknown>[]):PreparedStatement {
  return prepareBound(db,publish.bind(projectId,generation,sessionId,PARSER_VERSION,now,JSON.stringify(rows)));
}
