/**
 * Which prompt-id derivation applies to a transcript: its pinned scheme.
 *
 * A transcript is pinned once, when it is registered or restored, and the pin never changes: a trigger refuses an
 * update of a set scheme, and a parser derives every record of the transcript through it, so a reread or a later
 * declaration never names an existing prompt a second way.
 *
 * Every transcript of one agent in one session is pinned to one scheme (`admitPromptScheme`), so a record two of
 * them hold (a replaced file, a continuation) is named one way. The group's existing pins and the scheme that already
 * read any of its unpinned transcripts are what it needs; with none, the agent's declaration; with two or more, none,
 * and the transcript is not read (`parse.ts` `scheme_conflict`). Registration decides it in its own insert
 * (`admittedScheme`), and restore over the whole artifact before it writes a row (`core/backup.ts`).
 */
import { CAPTURE_RULE_BUNDLES } from '@goondocks/myco-shared/capture-rules-data';
import { hookScheme, isPromptIdScheme, PROMPT_ID_SCHEMES, type DeclarableScheme, type PromptIdScheme, type PromptScopeReason } from '@goondocks/myco-shared/prompt-identity';
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

/** A parse has read this transcript: a parser version or parse time set (a pending reread or repair keeps both), or a cursor past its first byte. */
const READ_SQL = (t: string): string => `(${t}.parser_version > 0 OR ${t}.parsed_at IS NOT NULL OR ${t}.parsed_offset > 0)`;
export const transcriptRead = (row: { parser_version?: unknown; parsed_at?: unknown; parsed_offset?: unknown }): boolean =>
  (typeof row.parser_version === 'number' && row.parser_version > 0) || (row.parsed_at !== null && row.parsed_at !== undefined)
  || (typeof row.parsed_offset === 'number' && row.parsed_offset > 0);

/** What one (project, session, agent) group of transcripts holds that its scheme is decided by. */
export interface SchemeGroup {
  agent: string | null;
  /** The schemes its transcripts are already pinned to. */
  pins: readonly string[];
  /** Whether an unpinned transcript of the group has already been read, by the scheme its agent's transcripts are read by before pins. */
  unpinnedRead: boolean;
}

/** The declarations and pre-pin readings a decision is made over: this build's, unless a caller names others. */
export interface SchemeMaps { declared: Readonly<Record<string, string>>; readBeforePin: Readonly<Record<string, string>> }
const CURRENT_MAPS: SchemeMaps = { declared: DECLARED_SCHEMES, readBeforePin: READ_BEFORE_PIN };

/**
 * The scheme an unpinned transcript of a group is pinned to: the one scheme the group needs (its pins, and the
 * pre-pin reading where an unpinned member has been read), the declaration where it needs none, and null where it needs two
 * or more, or names no declared agent. Never a choice among disagreeing pins.
 */
export function admitPromptScheme(group: SchemeGroup, maps: SchemeMaps = CURRENT_MAPS): PromptIdScheme | null {
  if (group.agent === null || maps.declared[group.agent] === undefined) return null;
  const needs = new Set(group.pins);
  if (group.unpinnedRead) needs.add(maps.readBeforePin[group.agent] ?? maps.declared[group.agent]!);
  const [only, ...more] = [...needs];
  const scheme = only === undefined ? maps.declared[group.agent]! : more.length === 0 ? only : null;
  return scheme !== null && isPromptIdScheme(scheme) ? scheme : null;
}

/**
 * `admitPromptScheme` as one expression over the store, for a transcript of `agent` registering into a session now: a
 * column expression and its parameters. It reads the group as the insert that carries it writes, each read a lookup on
 * the session's transcripts, so a group another writer pinned first is joined, or refused, never overridden.
 */
export function admittedScheme(projectId: string, sessionId: string, agent: string | null): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const named = (): string => { params.push(agent); return '?'; };
  const group = (): string => { params.push(projectId, sessionId, agent); return 't.project_id = ? AND t.session_id = ? AND t.agent = ?'; };
  const pin = (pick: 'MIN' | 'MAX'): string => `(SELECT ${pick}(t.prompt_identity_scheme) FROM transcripts t WHERE ${group()} AND t.prompt_identity_scheme IS NOT NULL)`;
  const unpinnedRead = (): string => `EXISTS (SELECT 1 FROM transcripts t WHERE ${group()} AND t.prompt_identity_scheme IS NULL AND ${READ_SQL('t')})`;
  const sql = `(CASE WHEN ${schemeByAgent(DECLARED_SCHEMES, named())} IS NULL THEN NULL
      WHEN ${pin('MIN')} IS NULL THEN CASE WHEN ${unpinnedRead()} THEN ${schemeByAgent(READ_BEFORE_PIN, named())} ELSE ${schemeByAgent(DECLARED_SCHEMES, named())} END
      WHEN ${pin('MIN')} <> ${pin('MAX')} THEN NULL
      WHEN ${unpinnedRead()} AND ${schemeByAgent(READ_BEFORE_PIN, named())} <> ${pin('MIN')} THEN NULL
      ELSE ${pin('MIN')} END)`;
  return { sql, params };
}

/** The group a transcript row belongs to. */
export const schemeGroupKey = (row: Record<string, unknown>): string => JSON.stringify([row.project_id, row.session_id, row.agent ?? null]);

/** Sessions per read of the transcripts a restore's groups already hold. */
const RESTORE_SESSIONS_PER_READ = 50;

/**
 * The scheme each group of a restore's transcripts is admitted to, decided over the whole artifact and what the
 * destination already holds of the same groups, before any of its rows is written: a group split across the restore's
 * chunks is decided once, and a resumed restore decides it again the same way: the rows it already wrote carry the
 * decided pin. Keyed by `schemeGroupKey`; null where the group needs two or more schemes or names no declared agent.
 */
export async function restoreSchemeDecisions(db: RelationalStore, rows: readonly Record<string, unknown>[], maps: SchemeMaps = CURRENT_MAPS): Promise<Map<string, PromptIdScheme | null>> {
  const groups = new Map<string, { agent: string | null; pins: Set<string>; unpinnedRead: boolean }>();
  const hold = (row: Record<string, unknown>, create: boolean): void => {
    const key = schemeGroupKey(row);
    let group = groups.get(key);
    if (group === undefined) {
      if (!create) return;
      group = { agent: typeof row.agent === 'string' ? row.agent : null, pins: new Set(), unpinnedRead: false };
      groups.set(key, group);
    }
    if (typeof row.prompt_identity_scheme === 'string') group.pins.add(row.prompt_identity_scheme);
    else if (transcriptRead(row)) group.unpinnedRead = true;
  };
  for (const row of rows) hold(row, true);
  const sessions = [...new Set(rows.map((row) => JSON.stringify([row.project_id, row.session_id])))];
  for (let at = 0; at < sessions.length; at += RESTORE_SESSIONS_PER_READ) {
    const { results } = await db.prepare(`SELECT t.project_id, t.session_id, t.agent, t.prompt_identity_scheme, t.parser_version, t.parsed_at, t.parsed_offset
        FROM json_each(?) j JOIN transcripts t ON t.project_id = json_extract(j.value, '$[0]') AND t.session_id = json_extract(j.value, '$[1]')`)
      .bind(`[${sessions.slice(at, at + RESTORE_SESSIONS_PER_READ).join(',')}]`).all<Record<string, unknown>>();
    for (const row of results) hold(row, false);
  }
  return new Map([...groups].map(([key, group]) => [key, admitPromptScheme({ agent: group.agent, pins: [...group.pins], unpinnedRead: group.unpinnedRead }, maps)]));
}

/**
 * The pin a restored transcript row is written with, as the column expression of its insert and its parameters: its
 * own pin where the artifact carries one, and its group's decision where it carries none, which the insert still
 * refuses (leaving the row unpinned) when another writer has meanwhile pinned the group to another scheme.
 */
export function restoredPin(row: Record<string, unknown>, decisions: ReadonlyMap<string, PromptIdScheme | null>): { sql: string; params: unknown[] } {
  if (typeof row.prompt_identity_scheme === 'string') return { sql: '?', params: [row.prompt_identity_scheme] };
  const decided = decisions.get(schemeGroupKey(row)) ?? null;
  if (decided === null) return { sql: 'NULL', params: [] };
  return {
    sql: `CASE WHEN NOT EXISTS (SELECT 1 FROM transcripts g WHERE g.project_id = ? AND g.session_id = ? AND g.agent IS ?
      AND g.prompt_identity_scheme IS NOT NULL AND g.prompt_identity_scheme <> ?) THEN ? END`,
    params: [row.project_id, row.session_id, row.agent ?? null, decided, decided],
  };
}

/** The checkpoint generation of each scheme, over a `transcripts` row's pinned scheme; a transcript with none has none. */
export const SCHEME_GENERATION_SQL = `CASE prompt_identity_scheme ${Object.entries(PROMPT_ID_SCHEMES).map(([scheme, entry]) => {
  if (!SQL_SAFE.test(scheme) || !Number.isSafeInteger(entry.generation)) throw new Error(`scheme ${scheme} names no SQL-safe name and generation`);
  return `WHEN '${scheme}' THEN ${entry.generation}`;
}).join(' ')} END`;

/** The checkpoint generation of one scheme. */
export const schemeGeneration = (scheme: PromptIdScheme): number => PROMPT_ID_SCHEMES[scheme].generation;

/** A pinned scheme as a hook names its prompts (`hookScheme`), over a column holding one; a scheme with no `hookIdentity` is its own name. */
const HOOK_SCHEME_SQL = (column: string): string => {
  const arms = Object.keys(PROMPT_ID_SCHEMES).filter((scheme) => isPromptIdScheme(scheme) && hookScheme(scheme) !== scheme)
    .map((scheme) => `WHEN '${scheme}' THEN '${hookScheme(scheme as PromptIdScheme)}'`);
  return arms.length === 0 ? column : `CASE ${column} ${arms.join(' ')} ELSE ${column} END`;
};
/** Each agent's declaration as its hooks name it. */
const HOOK_DECLARED_SCHEMES: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(DECLARED_SCHEMES).map(([agent, scheme]) => [agent, hookScheme(scheme)]),
);

/**
 * Whether a prompt id derived under a scheme names a prompt of the session as the Deployment names them. The scheme is
 * the one a hook names under (`hookScheme`), and a transcript pinned to a scheme whose hook derives by it shares it. Once the
 * session has a primary transcript, every primary transcript of it is pinned to that scheme: one pinned to another,
 * or pinned to none (it names no agent this Deployment declares), names its prompts some other way or not at all.
 * Before one is registered, the scheme the session's agent declares, which its transcript will be pinned to; a session
 * whose agent this build declares nothing for takes the scheme as named. Bound as `(projectId, sessionId, scheme)` by
 * `schemeSharedParams`.
 */
const SCHEME_SHARED_SQL = `(CASE WHEN EXISTS (SELECT 1 FROM transcripts t WHERE t.project_id = ? AND t.session_id = ? AND t.role = 'primary')
    THEN NOT EXISTS (SELECT 1 FROM transcripts t WHERE t.project_id = ? AND t.session_id = ? AND t.role = 'primary'
      AND (t.prompt_identity_scheme IS NULL OR ${HOOK_SCHEME_SQL('t.prompt_identity_scheme')} <> ?))
    ELSE COALESCE((SELECT ${schemeByAgent(HOOK_DECLARED_SCHEMES, 's.agent')} FROM sessions s WHERE s.project_id = ? AND s.session_id = ?), ?) = ? END)`;
const schemeSharedParams = (projectId: string, sessionId: string, scheme: PromptIdScheme): unknown[] =>
  [projectId, sessionId, projectId, sessionId, hookScheme(scheme), projectId, sessionId, hookScheme(scheme), hookScheme(scheme)];

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
export function deliveredFields(d:DeliveredNaming):{column:string;sql:string;params:unknown[]}[]{
  const scope=d.promptId===null||d.scheme===undefined||d.scheme===null?null:schemeSharedParams(d.projectId,d.sessionId,d.scheme);
  return [
    {column:'delivered_at',sql:'?',params:[d.at]},
    {column:'delivered_prompt_id',sql:scope===null?'?':`CASE WHEN ${SCHEME_SHARED_SQL} THEN ? END`,params:scope===null?[d.promptId]:[...scope,d.promptId]},
    {column:'delivered_scope_reason',sql:scope===null?'?':`CASE WHEN ${SCHEME_SHARED_SQL} THEN NULL ELSE 'scheme' END`,params:scope===null?[d.scopeReason]:scope},
  ];
}

export function deliveredAssignment(d:DeliveredNaming):{sql:string;params:unknown[]}{
  const fields=deliveredFields(d);
  return {sql:fields.map(field=>field.column+' = '+field.sql).join(', '),params:fields.flatMap(field=>field.params)};
}
