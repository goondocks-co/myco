/**
 * The measures the Deployment reports about itself, each with the sample
 * behind it.
 *
 * Every measure here is derived from rows the Deployment already holds — prompts,
 * the records naming what they were served, tool calls, sessions, and credential
 * lineages. Nothing is estimated and nothing is configured: a measure with no
 * rows behind it answers a null value and a sample size of zero, and the surface
 * renders that as an absent sample rather than as a number.
 *
 * `sampleSize` travels with every value as one type. A share of 1.0 over two
 * prompts and a share of 1.0 over two thousand are different claims, and a shape
 * that can carry the first without the second invites a page showing a figure
 * nobody can weigh. The pair is the unit of measurement here, so a tile cannot
 * render one half of it.
 *
 * Measures are Deployment-wide rather than per Project. Two of the six — the time
 * from a machine joining to its first served context, and recall quality — are
 * properties of the Deployment's credential lineages and of the release it runs,
 * not of one Project, and splitting the page by Project would leave those two answering a
 * different question from the other four.
 */
import type { RelationalStore } from '../core/adapters.js';
import { CAPTURE_RULE_BUNDLES } from '@goondocks/myco-shared/capture-rules-data';

/** The agents this build declares a prompt identity for: a transcript of one left unpinned is a scheme conflict. */
const DECLARED_AGENTS: readonly string[] = CAPTURE_RULE_BUNDLES.map((bundle) => bundle.name);
import { recallQuality, caseCount } from '../evals/recall-baseline.js';

/** A measured value and the number of rows behind it. A sample of zero carries a null value. */
export interface Measure {
  value: number | null;
  sampleSize: number;
}

/**
 * One harness's diagnostic rate, named by the harness the session's transcript
 * reports, carrying the call count as well as the rate.
 *
 * The count travels with the rate so the parts account for the whole. A harness
 * whose calls land inside the window while its prompts land outside it has a rate
 * of nothing and a call count of several, and a reader adding up rates alone would
 * come up short against the figure the split sits under.
 */
export interface HarnessMeasure extends Measure {
  harness: string;
  calls: number;
}

export interface KpiReport {
  /** The trailing window in days, or null when every row counts. */
  windowDays: number | null;
  /** The earliest stamp a row may carry to be counted, or null for all of them. */
  since: number | null;
  /** Prompts that received context this Deployment prepared, as a share of every prompt. */
  contextPresent: Measure;
  /** Prompts that received at least one observation, as a share of every prompt. */
  sporeServeRate: Measure;
  /** Sessions served a session start block, as a share of every session. */
  sessionStartPresent: Measure;
  /** Myco tool calls per prompt across the Deployment, with the per-harness split behind it. */
  callsPerPrompt: Measure;
  callsPerPromptByHarness: HarnessMeasure[];
  /** Plan reads per session. */
  planReadsPerSession: Measure;
  /** Median milliseconds from a machine's credential lineage starting to the first context served into one of its sessions. */
  firstInjectionMs: Measure;
  /**
   * Recall quality: how well this release's prompt-time injection serves the recall gold set, the mean over its
   * cases of a graded score. Recorded by CI against real prompts on both front doors and committed with the release
   * (`evals/recall-baseline.ts`, #1154); the window does not apply, and the sample is the number of cases.
   */
  recallQuality: Measure;
  /**
   * Per harness, what its transcripts' parse kept without naming it the usual way: counts, never links. `sampleSize`
   * is the prompts parsed under a scheme that records where each prompt's identity comes from.
   */
  promptIdentity: PromptIdentityCounts[];
}

/** One harness's prompt identity counts over the window (`KpiReport.promptIdentity`). */
export interface PromptIdentityCounts {
  harness: string;
  sampleSize: number;
  /** A line of a shape the parse does not know, or a turn opener whose fields name no known class. */
  unrecognized: number;
  /** A record that claimed a key carrying none of the fields that name who opened a turn. */
  unmarked: number;
  /** A turn opener whose fields name two different classes. */
  openerConflict: number;
  /** A record whose fields contradict how its transcript is registered (a delegated agent's or the session's own). */
  contractViolation: number;
  /** A later submission that reused a key an earlier one owns. */
  reused: number;
  /** A prompt id a second source tried to name, refused (`prompt_identity_conflicts`). */
  identityConflicts: number;
  /** A transcript left unpinned, and so not read: its session's transcripts need two schemes. */
  schemeConflicts: number;
  /** A session whose transcripts of this agent hold two schemes between them, pinned before one admission rule applied. */
  mixedSchemeSessions: number;
  /** A context answer whose receipt is skipped: another receipt already names its prompt id. */
  duplicatePromptSkips: number;
}

/** The windows the surface offers. `null` is every row the Deployment holds. */
export const KPI_WINDOWS: readonly number[] = [7, 30, 90];

/** The window a caller asked for, or null for all of them; anything that is not one of the offered windows reads as all. */
export function kpiWindow(raw: string | null): number | null {
  if (raw === null || raw === 'all') return null;
  const days = Number(raw);
  return KPI_WINDOWS.includes(days) ? days : null;
}

/** A share over a sample, or a null value for an empty one. */
const share = (numerator: number, sampleSize: number): Measure =>
  ({ value: sampleSize === 0 ? null : numerator / sampleSize, sampleSize });

/** A rate over a sample, or a null value for an empty one. */
const rate = share;

/** The middle value of an ordered set, averaging the two middles of an even one. */
export function median(sorted: readonly number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * The harness behind a prompt or a tool call, as a correlated subquery over the
 * session's primary transcript.
 *
 * A subquery rather than a join: a session may hold more than one transcript row,
 * and a join would count one prompt once per row. The oldest primary transcript
 * is the session's own, and a session whose transcript never arrived reads as
 * `unrecorded` rather than being dropped from the split.
 */
const HARNESS_OF = (alias: string): string => `COALESCE((
  SELECT t.agent FROM transcripts t
   WHERE t.project_id = ${alias}.project_id AND t.session_id = ${alias}.session_id AND t.role = 'primary'
   ORDER BY t.first_received_at LIMIT 1), 'unrecorded')`;

/** A `created_at >= ?` clause for the window, or an always-true one for all rows. */
const windowClause = (column: string, since: number | null): { sql: string; params: number[] } =>
  since === null ? { sql: '1 = 1', params: [] } : { sql: `${column} >= ?`, params: [since] };

const countOf = async (db: RelationalStore, sql: string, params: readonly unknown[]): Promise<number> => {
  const row = await db.prepare(sql).bind(...params).first<{ n: number }>();
  return row?.n ?? 0;
};

/**
 * Prompts that received context the Deployment prepared: a receipt, or the session's plan nudge, whose delivery named
 * the prompt. These are the durable records of what a served answer carried, so the count outlives the answers'
 * retention. A selection never delivered, a delivery to a prompt that has no name, and a member that reports no
 * deliveries count for no prompt. A session's start block is a session's, counted over sessions
 * (`SESSIONS_STARTED_WITH_BLOCK`).
 */
const SERVED_PROMPTS = `
  EXISTS (SELECT 1 FROM spore_injections i
           WHERE i.project_id = p.project_id AND i.session_id = p.session_id AND i.delivered_prompt_id = p.prompt_id)
  OR EXISTS (SELECT 1 FROM session_injections j
              WHERE j.project_id = p.project_id AND j.session_id = p.session_id AND j.kind = 'plan-nudge'
                AND j.delivered_prompt_id = p.prompt_id)`;

/** Sessions the Deployment served a session start block. */
const SESSIONS_STARTED_WITH_BLOCK = `EXISTS (SELECT 1 FROM session_injections j
  WHERE j.project_id = sessions.project_id AND j.session_id = sessions.session_id AND j.kind = 'cortex')`;

/** The tool calls that count as reaching Myco at all. */
const MYCO_CALL = `c.myco_tool IS NOT NULL`;

/**
 * The plan calls that read.
 *
 * An allow-list, not a deny-list. `myco_plans` today reads under `list` and `get`
 * and writes under `save` and `delete`; naming what reads means a write op added
 * later is counted by nobody, where naming what writes would have every new op
 * counted as a read until someone remembered this line. The absent op is the
 * tool's own default, which is `list`.
 */
const PLAN_READ = `c.myco_tool = 'myco_plans' AND (c.myco_op IS NULL OR c.myco_op IN ('list', 'get'))`;

/** Prompts and the served share of them. */
async function promptMeasures(db: RelationalStore, since: number | null): Promise<{ prompts: number; served: number; withSpores: number }> {
  const w = windowClause('p.created_at', since);
  const [prompts, served, withSpores] = await Promise.all([
    countOf(db, `SELECT COUNT(*) AS n FROM prompt_batches p WHERE ${w.sql}`, w.params),
    countOf(db, `SELECT COUNT(*) AS n FROM prompt_batches p WHERE ${w.sql} AND (${SERVED_PROMPTS})`, w.params),
    countOf(db, `SELECT COUNT(*) AS n FROM prompt_batches p
                  WHERE ${w.sql} AND EXISTS (
                    SELECT 1 FROM spore_injections i
                     WHERE i.project_id = p.project_id AND i.session_id = p.session_id
                       AND i.delivered_prompt_id = p.prompt_id AND i.spore_ids <> '[]')`, w.params),
  ]);
  return { prompts, served, withSpores };
}

/**
 * Myco calls and prompts, split by the harness each session ran under.
 *
 * The harnesses are the union of the two sides, not the prompt side alone. A
 * harness whose calls land inside the window while its prompts land outside it
 * has calls counted in the whole and would have them counted in no part, leaving
 * the split unable to account for the figure above it. Such a harness takes a row
 * with an empty sample, which the surface renders as no value — the same rule the
 * page applies everywhere else.
 */
async function harnessSplit(db: RelationalStore, since: number | null): Promise<HarnessMeasure[]> {
  const prompts = windowClause('p.created_at', since);
  const calls = windowClause('c.created_at', since);
  const [promptRows, callRows] = await Promise.all([
    db.prepare(`SELECT ${HARNESS_OF('p')} AS harness, COUNT(*) AS n FROM prompt_batches p WHERE ${prompts.sql} GROUP BY harness`)
      .bind(...prompts.params).all<{ harness: string; n: number }>(),
    db.prepare(`SELECT ${HARNESS_OF('c')} AS harness, COUNT(*) AS n FROM tool_calls c WHERE ${calls.sql} AND ${MYCO_CALL} GROUP BY harness`)
      .bind(...calls.params).all<{ harness: string; n: number }>(),
  ]);
  const promptsBy = new Map(promptRows.results.map((r) => [r.harness, r.n]));
  const callsBy = new Map(callRows.results.map((r) => [r.harness, r.n]));
  return [...new Set([...promptsBy.keys(), ...callsBy.keys()])]
    .map((harness) => ({ harness, calls: callsBy.get(harness) ?? 0, ...rate(callsBy.get(harness) ?? 0, promptsBy.get(harness) ?? 0) }))
    .sort((a, b) => b.sampleSize - a.sampleSize || b.calls - a.calls || a.harness.localeCompare(b.harness));
}

/**
 * Milliseconds from each credential lineage starting to the first context served
 * into one of its sessions.
 *
 * Grouped by `lineage_root` rather than by credential id: a machine refreshes its
 * credential on a schedule, and counting each refresh as a fresh install would
 * report the refresh interval instead of the time a person waited. A lineage whose
 * sessions have been served nothing yet contributes no row, so the sample counts
 * lineages that reached a first injection rather than every lineage that exists.
 *
 * The window selects on when a lineage STARTED, so a trailing window measures the
 * machines that joined inside it. A span that comes out negative — an injection
 * stamped ahead of the lineage that produced it, which two clocks can disagree
 * enough to write — is dropped rather than counted as an instant arrival; the
 * sample size shrinks with it, which is what the surface renders.
 */
async function firstInjectionSamples(db: RelationalStore, since: number | null): Promise<number[]> {
  const w = windowClause('c.lineage_started_at', since);
  const { results } = await db
    .prepare(`SELECT c.lineage_root AS lineage, MIN(c.lineage_started_at) AS started,
                     MIN((SELECT MIN(x.created_at) FROM (
                            SELECT i.created_at, i.project_id, i.session_id FROM spore_injections i
                            UNION ALL
                            SELECT s.created_at, s.project_id, s.session_id FROM session_injections s) x
                          WHERE x.project_id = sess.project_id AND x.session_id = sess.session_id)) AS first_served
                FROM member_credentials c
                JOIN sessions sess ON sess.created_by_token_id = c.id
               WHERE ${w.sql}
               GROUP BY c.lineage_root`)
    .bind(...w.params)
    .all<{ lineage: string; started: number; first_served: number | null }>();
  return results
    .flatMap((r) => (r.first_served === null ? [] : [r.first_served - r.started]))
    .filter((ms) => ms >= 0)
    .sort((a, b) => a - b);
}

const IDENTITY_KINDS = { unrecognized: 'unrecognized', unmarked: 'unmarked', openerConflict: 'opener_conflict', contractViolation: 'contract_violation' } as const;

/** The prompt identity counts per harness (`KpiReport.promptIdentity`), each a count over stored rows. */
async function promptIdentityCounts(db: RelationalStore, since: number | null): Promise<PromptIdentityCounts[]> {
  const claimed = windowClause('p.created_at', since);
  const refused = windowClause('c.created_at', since);
  const answered = windowClause('a.created_at', since);
  const registered = windowClause('t.first_received_at', since);
  const kinds = Object.values(IDENTITY_KINDS).map((kind) => `SUM(p.prompt_kind = '${kind}') AS "${kind}"`).join(', ');
  const [rows, conflicts, unpinned, duplicates, mixed] = await Promise.all([
    db.prepare(`SELECT ${HARNESS_OF('p')} AS harness, COUNT(*) AS n, ${kinds}, SUM(p.claim = 'reused') AS reused
        FROM projects pr CROSS JOIN prompt_batches p WHERE p.project_id = pr.project_id AND p.claim IS NOT NULL AND ${claimed.sql} GROUP BY harness`)
      .bind(...claimed.params).all<Record<string, number | string>>(),
    db.prepare(`SELECT ${HARNESS_OF('c')} AS harness, COUNT(*) AS n FROM projects pr CROSS JOIN prompt_identity_conflicts c
        WHERE c.project_id = pr.project_id AND ${refused.sql} GROUP BY harness`).bind(...refused.params).all<{ harness: string; n: number }>(),
    db.prepare(`SELECT t.agent AS harness, COUNT(*) AS n FROM transcripts t WHERE t.prompt_identity_scheme IS NULL
        AND t.agent IN (${DECLARED_AGENTS.map(() => '?').join(', ')}) AND ${registered.sql} GROUP BY t.agent`)
      .bind(...DECLARED_AGENTS, ...registered.params).all<{ harness: string; n: number }>(),
    db.prepare(`SELECT ${HARNESS_OF('a')} AS harness, COUNT(*) AS n FROM prompt_context_answers a
        WHERE ${answered.sql} AND EXISTS (SELECT 1 FROM json_each(a.skipped) j WHERE j.value = 'spores:duplicate_prompt') GROUP BY harness`)
      .bind(...answered.params).all<{ harness: string; n: number }>(),
    db.prepare(`SELECT agent AS harness, COUNT(*) AS n FROM (SELECT t.agent AS agent FROM transcripts t
        WHERE t.agent IN (${DECLARED_AGENTS.map(() => '?').join(', ')}) AND t.prompt_identity_scheme IS NOT NULL AND ${registered.sql}
        GROUP BY t.project_id, t.session_id, t.agent HAVING COUNT(DISTINCT t.prompt_identity_scheme) > 1) GROUP BY agent`)
      .bind(...DECLARED_AGENTS, ...registered.params).all<{ harness: string; n: number }>(),
  ]);
  const byHarness = new Map<string, PromptIdentityCounts>();
  const of = (harness: string): PromptIdentityCounts => {
    let counts = byHarness.get(harness);
    if (counts === undefined) {
      counts = { harness, sampleSize: 0, unrecognized: 0, unmarked: 0, openerConflict: 0, contractViolation: 0, reused: 0, identityConflicts: 0, schemeConflicts: 0, mixedSchemeSessions: 0, duplicatePromptSkips: 0 };
      byHarness.set(harness, counts);
    }
    return counts;
  };
  for (const row of rows.results) {
    const counts = of(String(row.harness));
    counts.sampleSize = Number(row.n);
    counts.reused = Number(row.reused ?? 0);
    for (const [field, kind] of Object.entries(IDENTITY_KINDS)) counts[field as keyof typeof IDENTITY_KINDS] = Number(row[kind] ?? 0);
  }
  for (const row of conflicts.results) of(row.harness).identityConflicts = row.n;
  for (const row of unpinned.results) of(row.harness).schemeConflicts = row.n;
  for (const row of duplicates.results) of(row.harness).duplicatePromptSkips = row.n;
  for (const row of mixed.results) of(row.harness).mixedSchemeSessions = row.n;
  return [...byHarness.values()].sort((a, b) => b.sampleSize - a.sampleSize || a.harness.localeCompare(b.harness));
}

/** Every measure, over the window a caller asked for. */
export async function readKpis(db: RelationalStore, opts: { windowDays: number | null; now: number }): Promise<KpiReport> {
  const since = opts.windowDays === null ? null : opts.now - opts.windowDays * 86_400_000;
  const sessionWindow = windowClause('first_received_at', since);
  const callWindow = windowClause('c.created_at', since);

  const [{ prompts, served, withSpores }, byHarness, sessions, startedWithBlock, planReads, mycoCalls, firstInjections, identity] = await Promise.all([
    promptMeasures(db, since),
    harnessSplit(db, since),
    countOf(db, `SELECT COUNT(*) AS n FROM sessions WHERE ${sessionWindow.sql}`, sessionWindow.params),
    countOf(db, `SELECT COUNT(*) AS n FROM sessions WHERE ${sessionWindow.sql} AND ${SESSIONS_STARTED_WITH_BLOCK}`, sessionWindow.params),
    countOf(db, `SELECT COUNT(*) AS n FROM tool_calls c WHERE ${callWindow.sql} AND ${PLAN_READ}`, callWindow.params),
    countOf(db, `SELECT COUNT(*) AS n FROM tool_calls c WHERE ${callWindow.sql} AND ${MYCO_CALL}`, callWindow.params),
    firstInjectionSamples(db, since),
    promptIdentityCounts(db, since),
  ]);

  return {
    windowDays: opts.windowDays,
    since,
    contextPresent: share(served, prompts),
    sporeServeRate: share(withSpores, prompts),
    sessionStartPresent: share(startedWithBlock, sessions),
    callsPerPrompt: rate(mycoCalls, prompts),
    callsPerPromptByHarness: byHarness,
    planReadsPerSession: rate(planReads, sessions),
    firstInjectionMs: { value: median(firstInjections), sampleSize: firstInjections.length },
    recallQuality: { value: recallQuality, sampleSize: caseCount },
    promptIdentity: identity,
  };
}
