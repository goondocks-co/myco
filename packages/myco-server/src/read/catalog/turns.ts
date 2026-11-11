import type { RelationalStore as turns_import_RelationalStore } from "../../core/adapters.js";
import { PROMPT_ORIGINS as turns_import_PROMPT_ORIGINS } from "../../ingest/kinds.js";
import { promptPlaced } from "../../db/documents/prompt-placement.js";
import { subagentContextCounts } from "../../db/sessions/hook-placement.js";
import type { ReadScope as turns_import_ReadScope } from "../scope.js";
import { hook_placement_sessionContextIdentities } from './hook-placement.js';

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
  return promptPlaced(db, scope.projectId, sessionId, promptId);
}

/** Sub-agent preambles use the parent hint carried by their canonical start event. */
async function turns_sessionTurnContexts(db: turns_import_RelationalStore, scope: turns_import_ReadScope, sessionId: string): Promise<Record<string, turns_TurnContext>> {
  const identities = await hook_placement_sessionContextIdentities(db, scope, sessionId);
  const results = await subagentContextCounts(db, { project: scope.projectId, session: sessionId, identities });
  return Object.fromEntries(results.map(row => [row.prompt_id, { subagents: row.n }]));
}

export { turns_parseOrigins, turns_promptInSession, turns_sessionTurnContexts };
