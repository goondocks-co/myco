import { placedPromptSql } from '../document-catalog.js';
import type { RelationalStore as turns_import_RelationalStore } from "../../core/adapters.js";
import { PROMPT_ORIGINS as turns_import_PROMPT_ORIGINS } from "../../ingest/kinds.js";
import type { ReadScope as turns_import_ReadScope } from "../scope.js";
import { hook_placement_hookPlacementSql, hook_placement_sessionContextHints } from './hook-placement.js';
import { queryRows } from './shared.js';

/** The origin the list shows when the caller names none: what a person typed. */
const turns_DEFAULT_ORIGINS: readonly string[] = ['user'];

/** The origins a query names, or null when one is not an origin the wire admits. Absent means the default. */
function turns_parseOrigins(raw: string | null): readonly string[] | null {
  if (raw === null || raw === '') return turns_DEFAULT_ORIGINS;
  const names = raw.split(',').map((s) => s.trim()).filter((s) => s !== '');
  if (names.length === 0) return null;
  const admitted = new Set<string>(turns_import_PROMPT_ORIGINS);
  return names.every((n) => admitted.has(n)) ? [...new Set(names)] : null;
}

/** What a turn's prompt carried beyond its own answers: the sub-agent preambles prepared under it. */
interface turns_TurnContext { subagents: number }

/** True when a prompt of that id sits in the session. */
 async function turns_promptInSession(db: turns_import_RelationalStore, scope: turns_import_ReadScope, sessionId: string, promptId: string): Promise<boolean> {

  return (await db.prepare(`SELECT 1 AS present WHERE ${placedPromptSql({ project: '?1', session: '?2', prompt: '?3' })}`)
    .bind(scope.projectId, sessionId, promptId).first()) !== null;
}

/** Sub-agent preambles use the parent hint carried by their canonical start event. */
 const turns_sessionTurnContexts = turns_sessionTurnContextsImpl;

async function turns_sessionTurnContextsImpl(db: turns_import_RelationalStore, scope: turns_import_ReadScope, sessionId: string): Promise<Record<string, turns_TurnContext>> {
  const contexts = await hook_placement_sessionContextHints(db, scope, sessionId);
  const { results } = await ({ results: await queryRows<{ prompt_id: string; n: number }>(db,`SELECT r.placement_hint AS prompt_id, COUNT(*) AS n FROM (${contexts.sql}) r
    WHERE r.project_id = ? AND r.session_id = ? AND r.kind LIKE 'cortex:%'
      AND ${hook_placement_hookPlacementSql({ project: 'r.project_id', session: 'r.session_id', prompt: 'r.placement_hint' })}
    GROUP BY r.placement_hint`,[...contexts.params, scope.projectId, sessionId],'all') });
  return Object.fromEntries(results.map(row => [row.prompt_id, { subagents: row.n }]));
}

export { turns_parseOrigins, turns_promptInSession, turns_sessionTurnContexts };
