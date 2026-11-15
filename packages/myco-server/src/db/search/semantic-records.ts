import type { RelationalStore } from '../../core/adapters.js';
import { read, rows } from '../index.js';
import { occurredAt } from '../session-dates.js';

interface SemanticRecord {
  type: 'session' | 'spore' | 'plan'; id: string; agent_line: string | null; learned_at: number;
}

const presentation = read<[project: string, records: string, agent: string | null, branch: string | null], SemanticRecord>({
  name: 'searchSemantic.records',
  sql: `WITH wanted AS (SELECT json_extract(value,'$[0]') AS type, json_extract(value,'$[1]') AS id FROM json_each(?2))
    SELECT w.type,w.id,NULL AS agent_line,${occurredAt('s.')} AS learned_at
      FROM wanted w CROSS JOIN sessions s ON s.project_id=?1 AND s.session_id=w.id
      WHERE w.type='session' AND (?3 IS NULL OR s.agent=?3) AND (?4 IS NULL OR s.branch=?4)
    UNION ALL SELECT w.type,w.id,s.agent_line,COALESCE(${occurredAt('se.')},s.created_at) AS learned_at
      FROM wanted w CROSS JOIN spores s ON s.project_id=?1 AND s.id=w.id
      LEFT JOIN sessions se ON se.project_id=s.project_id AND se.session_id=s.session_id
      WHERE w.type='spore' AND (?3 IS NULL OR se.agent=?3) AND (?4 IS NULL OR se.branch=?4)
    UNION ALL SELECT w.type,w.id,NULL AS agent_line,p.created_at AS learned_at
      FROM wanted w CROSS JOIN plans p ON p.project_id=?1 AND p.plan_key=w.id
      LEFT JOIN sessions se ON se.project_id=p.project_id AND se.session_id=p.session_id
      WHERE w.type='plan' AND (?3 IS NULL OR se.agent=?3) AND (?4 IS NULL OR se.branch=?4)`,
});

/** Metadata of the bounded vector candidates, admitted by the same session facets as word hits. */
export async function semanticRecords(db: RelationalStore, request: {
  project: string; records: readonly { type: string; record_id: string }[]; agent?: string; branch?: string;
}): Promise<Map<string, SemanticRecord>> {
  if (request.records.length === 0) return new Map();
  const found = await rows(db, presentation.bind(request.project, JSON.stringify(request.records.map(r => [r.type, r.record_id])), request.agent ?? null, request.branch ?? null));
  return new Map(found.map(row => [JSON.stringify([row.type, row.id]), row]));
}
