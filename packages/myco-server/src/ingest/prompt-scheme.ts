/**
 * Which prompt-id derivation applies to a transcript: its pinned scheme.
 *
 * A transcript is pinned once, when its first segment registers it, to the scheme its agent's manifest declares then
 * (`transcripts.prompt_identity_scheme`, written by the registration insert in `projections.ts` and nowhere else).
 * The pin never changes: a trigger refuses an update of a set scheme, and a parser derives every record of the
 * transcript through it, so a reread or a later declaration never names an existing prompt a second way.
 *
 * Rows written before the pin existed, by the migration that added it or by restoring a backup taken before it, get
 * their scheme from `promptSchemeBackfillSql`: a transcript a parse has already read keeps the scheme that read it, and
 * any other takes the one its agent declares.
 */
import { CAPTURE_RULE_BUNDLES } from '@goondocks/myco-shared/capture-rules-data';
import { PROMPT_ID_SCHEMES, type DeclarableScheme, type PromptIdScheme, type PromptScopeReason } from '@goondocks/myco-shared/prompt-identity';
import type { RelationalStore } from '../core/adapters.js';

/** The scheme each agent's manifest declares in this build: what a transcript registered now is pinned to. */
export const DECLARED_SCHEMES: Readonly<Record<string, DeclarableScheme>> = Object.fromEntries(
  CAPTURE_RULE_BUNDLES.map((bundle) => [bundle.name, bundle.promptIdentity.scheme]),
);

/** The scheme a transcript of `agent` registered now is pinned to; null for a transcript that names no agent this build declares. */
export const declaredScheme = (agent: string | null): DeclarableScheme | null => (agent === null ? null : DECLARED_SCHEMES[agent] ?? null);

/**
 * The scheme that read each agent's transcripts before the pin existed: its manifest's `readBeforePin`, where it names
 * one, and its declaration where it names none.
 */
export const READ_BEFORE_PIN: Readonly<Record<string, DeclarableScheme>> = Object.fromEntries(
  CAPTURE_RULE_BUNDLES.map((bundle) => [bundle.name, bundle.promptIdentity.readBeforePin ?? bundle.promptIdentity.scheme]),
);

const SQL_SAFE = /^[a-z0-9-]+$/;

function schemeByAgent(schemes: Readonly<Record<string, string>>, column = 'agent'): string {
  const arms = Object.entries(schemes).map(([agent, scheme]) => {
    if (!SQL_SAFE.test(agent) || !SQL_SAFE.test(scheme) || !Object.hasOwn(PROMPT_ID_SCHEMES, scheme)) throw new Error(`no SQL-safe agent and registered scheme: ${agent} ${scheme}`);
    return `WHEN '${agent}' THEN '${scheme}'`;
  });
  return arms.length === 0 ? 'NULL' : `CASE ${column} ${arms.join(' ')} END`;
}

/**
 * The statement that pins every transcript holding no scheme and naming an agent: one a parse has already read
 * (`parser_version > 0` or `parsed_at` set, which a pending reread or repair leaves in place, or a cursor past its
 * first byte) to the scheme that read it, any other to `declared`, the agents' declarations. A transcript of an agent neither names stays unpinned.
 */
export function promptSchemeBackfillSql(declared: Readonly<Record<string, string>>): string {
  return `UPDATE transcripts SET prompt_identity_scheme = CASE WHEN parser_version > 0 OR parsed_at IS NOT NULL OR parsed_offset > 0
      THEN COALESCE(${schemeByAgent(READ_BEFORE_PIN)}, ${schemeByAgent(declared)}) ELSE ${schemeByAgent(declared)} END
    WHERE prompt_identity_scheme IS NULL AND agent IS NOT NULL`;
}

/** The checkpoint generation of each scheme, over a `transcripts` row's pinned scheme; a transcript with none has none. */
export const SCHEME_GENERATION_SQL = `CASE prompt_identity_scheme ${Object.entries(PROMPT_ID_SCHEMES).map(([scheme, entry]) => {
  if (!SQL_SAFE.test(scheme) || !Number.isSafeInteger(entry.generation)) throw new Error(`scheme ${scheme} names no SQL-safe name and generation`);
  return `WHEN '${scheme}' THEN ${entry.generation}`;
}).join(' ')} END`;

/** The checkpoint generation of one scheme. */
export const schemeGeneration = (scheme: PromptIdScheme): number => PROMPT_ID_SCHEMES[scheme].generation;

/**
 * Whether a prompt id derived under a scheme names a prompt of the session as the Deployment names them: every primary
 * transcript of the session is pinned to that scheme, or, before one is registered, the scheme the session's agent
 * declares, which its transcript will be pinned to. A session whose agent this build declares nothing for takes the
 * scheme as named. Bound as `(projectId, sessionId, scheme)` by `schemeSharedParams`.
 */
const SCHEME_SHARED_SQL = `(CASE WHEN EXISTS (SELECT 1 FROM transcripts t WHERE t.project_id = ? AND t.session_id = ? AND t.role = 'primary' AND t.prompt_identity_scheme IS NOT NULL)
    THEN NOT EXISTS (SELECT 1 FROM transcripts t WHERE t.project_id = ? AND t.session_id = ? AND t.role = 'primary'
      AND t.prompt_identity_scheme IS NOT NULL AND t.prompt_identity_scheme <> ?)
    ELSE COALESCE((SELECT ${schemeByAgent(DECLARED_SCHEMES, 's.agent')} FROM sessions s WHERE s.project_id = ? AND s.session_id = ?), ?) = ? END)`;
const schemeSharedParams = (projectId: string, sessionId: string, scheme: PromptIdScheme): unknown[] =>
  [projectId, sessionId, projectId, sessionId, scheme, projectId, sessionId, scheme, scheme];

/** Whether a prompt id derived under `scheme` names a prompt of the session as the Deployment names them (`SCHEME_SHARED_SQL`). */
export async function sharesSessionScheme(db: RelationalStore, projectId: string, sessionId: string, scheme: PromptIdScheme): Promise<boolean> {
  const row = await db.prepare(`SELECT ${SCHEME_SHARED_SQL} AS shared`).bind(...schemeSharedParams(projectId, sessionId, scheme)).first<{ shared: number }>();
  return row?.shared === 1;
}

/** How a delivery names the prompt that carried it: the prompt by its id under `scheme`, or why it names none. */
export interface DeliveredNaming {
  projectId: string;
  sessionId: string;
  at: number;
  promptId: string | null;
  scopeReason: PromptScopeReason | null;
  /** The scheme `promptId` is derived by, where the member named it; absent from a member that names none. */
  scheme?: PromptIdScheme | null;
}

/**
 * The delivery columns a row is marked with: `delivered_at`, and the prompt that carried it, or why it names none. A
 * prompt named under a scheme the session's prompts are not named by is recorded as `scheme`, never as an id that
 * names nothing.
 */
export function deliveredAssignment(d: DeliveredNaming): { sql: string; params: unknown[] } {
  if (d.promptId === null || d.scheme === undefined || d.scheme === null) {
    return { sql: 'delivered_at = ?, delivered_prompt_id = ?, delivered_scope_reason = ?', params: [d.at, d.promptId, d.scopeReason] };
  }
  const shared = schemeSharedParams(d.projectId, d.sessionId, d.scheme);
  return {
    sql: `delivered_at = ?, delivered_prompt_id = CASE WHEN ${SCHEME_SHARED_SQL} THEN ? END,
      delivered_scope_reason = CASE WHEN ${SCHEME_SHARED_SQL} THEN NULL ELSE 'scheme' END`,
    params: [d.at, ...shared, d.promptId, ...shared],
  };
}
