import type { RelationalStore } from '../../core/adapters.js';
import { read, readSet } from '../index.js';
import { placedPromptSql } from '../documents/live-generation.js';
import { readSlotted, slottedRead, type SlottedRead } from '../slotted-read.js';

/** A hook record a turn does not hold: the record, the prompt it named, and what the read labels it. */
export interface UnplacedHookRow {
  project_id: string; session_id: string; record_key: string; record_kind: string; record_id: string; prompt_hint: string | null; label: string; created_at: number;
}

/**
 * The context records a session received with the prompt each places on: a sub-agent's start (the parent its start event
 * names, when every start of that agent names one) or a plan reminder's delivered prompt. `identities` is a JSON array
 * of the session's sub-agent context records with their canonical sub-agent ids; slot names are the caller's.
 */
const contextHintsSql = (slots: { identities: string; project: string; session: string }): string => `SELECT si.*, (SELECT MAX(json_extract(e.payload, '$.parentPromptId')) FROM events e INDEXED BY idx_events_subagent_start
      WHERE e.project_id = si.project_id AND e.session_id = si.session_id AND e.kind = 'subagent.start'
        AND json_extract(e.payload, '$.subagentId') = json_extract(agent.value, '$.subagent_id')
      HAVING COUNT(DISTINCT json_extract(e.payload, '$.parentPromptId')) = 1
        AND COUNT(*) = COUNT(json_extract(e.payload, '$.parentPromptId'))) AS placement_hint
      FROM json_each(${slots.identities}) agent CROSS JOIN session_injections si
      WHERE si.project_id = json_extract(agent.value, '$.project_id') AND si.session_id = json_extract(agent.value, '$.session_id')
        AND si.kind = json_extract(agent.value, '$.kind')
      UNION ALL SELECT si.*, si.delivered_prompt_id AS placement_hint FROM (SELECT r.* FROM projects pr CROSS JOIN session_injections r
        WHERE r.project_id = pr.project_id AND r.project_id = ${slots.project} AND r.session_id = ${slots.session}) si
      WHERE si.kind = 'plan-nudge' AND si.delivered_at IS NOT NULL`;

const cortexKinds = read<[project: string, session: string], { project_id: string; session_id: string; kind: string }>({ name: 'hookPlacement.cortexKinds', sql:
  `SELECT r.project_id, r.session_id, r.kind FROM (SELECT r.* FROM projects pr CROSS JOIN session_injections r
      WHERE r.project_id = pr.project_id AND r.project_id = ?1 AND r.session_id = ?2) r
    WHERE r.kind >= 'cortex:' AND r.kind < 'cortex;'` });

/** The sub-agent context records a session holds, before their canonical sub-agent ids are derived. */
export async function subagentContextKinds(db: RelationalStore, project: string, session: string): Promise<{ project_id: string; session_id: string; kind: string }[]> {
  const [rows] = await readSet(db, cortexKinds.bind(project, session));
  return rows;
}

const turnContexts = slottedRead<{ prompt_id: string | null; n: number }>('hookPlacement.turnContexts',
  `SELECT r.placement_hint AS prompt_id, COUNT(*) AS n FROM (${contextHintsSql({ identities: '{identities}', project: '{project}', session: '{session}' })}) r
    WHERE r.project_id = {project} AND r.session_id = {session} AND r.kind LIKE 'cortex:%'
      AND ${placedPromptSql({ project: 'r.project_id', session: 'r.session_id', prompt: 'r.placement_hint' })}
    GROUP BY r.placement_hint`);

/** How many sub-agent contexts each prompt of the session placed. */
export async function subagentContextCounts(db: RelationalStore, request: { project: string; session: string; identities: string }): Promise<{ prompt_id: string | null; n: number }[]> {
  return readSlotted(db, turnContexts, request);
}

interface HookSource { table: string; kind: string; id: string; hint: string; label: string; where: string; index?: string; unplacedPrompt?: string }

const DELIVERY_SOURCES: readonly HookSource[] = [
  { table: 'spore_injections', kind: 'receipt', id: 'id', hint: 'r.delivered_prompt_id', label: "'Context received'", where: 'delivered_at IS NOT NULL' },
  {
    table: 'prompt_context_answers', kind: 'answer', id: 'id', hint: 'r.delivered_prompt_id', label: "'Context received'", where: `outcome = 'served' AND delivered_at IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM spore_injections receipt WHERE receipt.project_id = r.project_id AND receipt.session_id = r.session_id AND receipt.id = r.receipt_id)`, unplacedPrompt: 'r.prompt_id',
  },
];

/** The placement hint for each hook record class. Selection remains diagnostic. */
const SOURCES: readonly HookSource[] = [
  ...DELIVERY_SOURCES,
  { table: 'session_injections', kind: 'session_context', id: 'kind', hint: 'r.placement_hint', label: "CASE WHEN kind = 'plan-nudge' THEN 'Plan reminder' ELSE 'Context for a sub-agent' END", where: '1 = 1' },
  { table: 'attachments', kind: 'attachment', id: 'attachment_id', hint: 'r.prompt_id', label: "COALESCE(description, 'Attachment')", where: '1 = 1' },
  { table: 'events', index: 'idx_events_subagent_start', kind: 'event', id: 'event_id', hint: "json_extract(payload, '$.parentPromptId')", label: "'Sub-agent started'", where: "kind = 'subagent.start'" },
  { table: 'events', kind: 'event', id: 'event_id', hint: "CASE WHEN kind = 'turn' THEN json_extract(payload, '$.promptId') ELSE json_extract(payload, '$.parentPromptId') END", label: "CASE kind WHEN 'turn' THEN 'Turn ' || COALESCE(json_extract(payload, '$.phase'), '') ELSE 'Sub-agent stopped' END", where: "kind IN ('turn', 'subagent.stop')" },
];

function unplacedSourceSql(source: HookSource, relation: string): string {
  const table = `${relation} r${source.index === undefined ? '' : ` INDEXED BY ${source.index}`}`;
  const placed = (prompt: string) => placedPromptSql({ project: 'r.project_id', session: 'r.session_id', prompt });
  return `SELECT project_id, session_id, '${source.kind}:' || ${source.id} AS record_key,
    '${source.kind}' AS record_kind, ${source.id} AS record_id, ${source.hint} AS prompt_hint,
    ${source.label} AS label, created_at FROM ${table}
    WHERE ${source.where}${source.unplacedPrompt === undefined ? '' : `\n    AND NOT ${placed(source.unplacedPrompt)}`}
      AND NOT ${placed(source.hint)}`;
}

/** One page of a source's unplaced records: its own Project and session, after a key when given. */
const sourcePage = (index: number, after: boolean): SlottedRead<UnplacedHookRow> => {
  const source = SOURCES[index]!;
  const relation = source.table === 'session_injections'
    ? `(${contextHintsSql({ identities: '{identities}', project: '{project}', session: '{session}' })})` : source.table;
  return slottedRead<UnplacedHookRow>(`hookPlacement.unplaced${index}${after ? 'After' : 'First'}`, `SELECT * FROM (${unplacedSourceSql(source, relation)})
    WHERE project_id = {project} AND session_id = {session}${after ? ' AND created_at >= {at} AND (created_at > {at} OR (created_at = {at} AND record_key > {afterKey}))' : ''}
    ORDER BY created_at, record_key LIMIT {limit}`);
};
const firstPages = SOURCES.map((_, index) => sourcePage(index, false));
const nextPages = SOURCES.map((_, index) => sourcePage(index, true));

/** Up to `limit` unplaced records of each hook source, each source's own page after the key `(createdAt, key)` when given. */
export async function unplacedHookRows(db: RelationalStore, request: { project: string; session: string; identities: string; after: { createdAt: number; id: string } | null; limit: number }): Promise<UnplacedHookRow[][]> {
  const { project, session, identities, after, limit } = request;
  const values = { project, session, identities, limit, at: after?.createdAt ?? null, afterKey: after?.id ?? null };
  return Promise.all((after === null ? firstPages : nextPages).map(variant => readSlotted(db, variant, values)));
}
