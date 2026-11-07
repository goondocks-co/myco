import type { RelationalStore as kpis_import_RelationalStore } from "../../core/adapters.js";
import { CAPTURE_RULE_BUNDLES as kpis_import_CAPTURE_RULE_BUNDLES } from "@goondocks/myco-shared/capture-rules-data";
import { recallQuality as kpis_import_recallQuality } from "../../evals/recall-baseline.js";
import { caseCount as kpis_import_caseCount } from "../../evals/recall-baseline.js";
import { hook_placement_hookPlacementSql } from './hook-placement.js';

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
 * Measures are Deployment-wide rather than per Project. The time
 * from a machine joining to its first served context and recall quality are
 * properties of the Deployment's credential lineages and of the release it runs,
 * not of one Project, and splitting the page by Project would leave those two answering a
 * different question from the other measures.
 */

/** The agents this build declares a prompt identity for: a transcript of one left unpinned is a scheme conflict. */
/** The live generation's prompts and Myco tool calls of every session, as the measures read them. */
const kpis_PROMPTS = `(SELECT p.* FROM projects pr CROSS JOIN session_prompts p CROSS JOIN session_documents d
  WHERE p.project_id = pr.project_id AND d.project_id = p.project_id AND d.session_id = p.session_id
    AND d.generation = p.generation AND d.state = 'live')`;

const kpis_MYCO_CALLS = `(SELECT c.* FROM projects pr CROSS JOIN myco_tool_calls c CROSS JOIN session_documents d
  WHERE c.project_id = pr.project_id AND d.project_id = c.project_id AND d.session_id = c.session_id
    AND d.generation = c.generation AND d.state = 'live')`;

const kpis_DECLARED_AGENTS: readonly string[] = kpis_import_CAPTURE_RULE_BUNDLES.map((bundle) => bundle.name);

/** A measured value and the number of rows behind it. A sample of zero carries a null value. */
interface kpis_Measure {
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
interface kpis_HarnessMeasure extends kpis_Measure {
  harness: string;
  calls: number;
}

interface kpis_KpiReport {
  /** The trailing window in days, or null when every row counts. */
  windowDays: number | null;
  /** The earliest stamp a row may carry to be counted, or null for all of them. */
  since: number | null;
  /** Prompts in the window with a placed delivery. */
  promptsServed: number;
  /** Receipts delivered in the window, split by whether their delivery hint places them. */
  deliveries: { placed: number; unplaced: number };
  /** Prompts served as a share of prompts in the window. */
  servedShare: kpis_Measure;
  /** Prompts that received at least one observation, as a share of every prompt. */
  sporeServeRate: kpis_Measure;
  /** Sessions served a session start block, as a share of every session. */
  sessionStartPresent: kpis_Measure;
  /** Myco tool calls per prompt across the Deployment, with the per-harness split behind it. */
  callsPerPrompt: kpis_Measure;
  callsPerPromptByHarness: kpis_HarnessMeasure[];
  /** Plan reads per session. */
  planReadsPerSession: kpis_Measure;
  /** Median milliseconds from a machine's credential lineage starting to the first context served into one of its sessions. */
  firstInjectionMs: kpis_Measure;
  /**
   * Recall quality: how well this release's prompt-time injection serves the recall gold set, the mean over its
   * cases of a graded score. Recorded by CI against real prompts on both front doors and committed with the release
   * (`evals/recall-baseline.ts`, #1154); the window does not apply, and the sample is the number of cases.
   */
  recallQuality: kpis_Measure;
  /**
   * Per harness, what its transcripts' parse kept without naming it the usual way: counts, never links. `sampleSize`
   * is the prompts parsed under a scheme that records where each prompt's identity comes from.
   */
  promptIdentity: kpis_PromptIdentityCounts[];
}

/** One harness's prompt identity counts over the window (`KpiReport.promptIdentity`). */
interface kpis_PromptIdentityCounts {
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
const kpis_KPI_WINDOWS: readonly number[] = [7, 30, 90];

/** The window a caller asked for, or null for all of them; anything that is not one of the offered windows reads as all. */
function kpis_kpiWindow(raw: string | null): number | null {
  if (raw === null || raw === 'all') return null;
  const days = Number(raw);
  return kpis_KPI_WINDOWS.includes(days) ? days : null;
}

/** A share over a sample, or a null value for an empty one. */
const kpis_share = (numerator: number, sampleSize: number): kpis_Measure =>
  ({ value: sampleSize === 0 ? null : numerator / sampleSize, sampleSize });

/** A rate over a sample, or a null value for an empty one. */
const kpis_rate = kpis_share;

/** The middle value of an ordered set, averaging the two middles of an even one. */
function kpis_median(sorted: readonly number[]): number | null {
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
const kpis_HARNESS_OF = (alias: string): string => `COALESCE((
  SELECT t.agent FROM transcripts t INDEXED BY idx_transcripts_session
   WHERE t.project_id = ${alias}.project_id AND t.session_id = ${alias}.session_id AND t.role = 'primary'
   ORDER BY t.first_received_at LIMIT 1), 'unrecorded')`;

/** A `created_at >= ?` clause for the window, or an always-true one for all rows. */
const kpis_windowClause = (column: string, since: number | null): { sql: string; params: number[] } =>
  since === null ? { sql: '1 = 1', params: [] } : { sql: `${column} >= ?`, params: [since] };

/**
 * Prompts that received context the Deployment prepared: a receipt, or the session's plan nudge, whose delivery named
 * the prompt. These are the durable records of what a served answer carried, so the count outlives the answers'
 * retention. A selection never delivered, a delivery to a prompt that has no name, and a member that reports no
 * deliveries count for no prompt. A session's start block is a session's, counted over sessions
 * (`SESSIONS_STARTED_WITH_BLOCK`).
 */
const kpis_SERVED_PROMPTS = `
  EXISTS (SELECT 1 FROM spore_injections i
           WHERE i.project_id = p.project_id AND i.session_id = p.session_id AND i.delivered_prompt_id = p.prompt_id AND i.delivered_at IS NOT NULL)
  OR EXISTS (SELECT 1 FROM session_injections j
              WHERE j.project_id = p.project_id AND j.session_id = p.session_id AND j.kind = 'plan-nudge'
                AND j.delivered_prompt_id = p.prompt_id AND j.delivered_at IS NOT NULL)`;

/** Sessions the Deployment served a session start block. */
const kpis_SESSIONS_STARTED_WITH_BLOCK = `EXISTS (SELECT 1 FROM session_injections j
  WHERE j.project_id = sessions.project_id AND j.session_id = sessions.session_id AND j.kind = 'cortex')`;

/** The tool calls that count as reaching Myco at all. */
const kpis_MYCO_CALL = `c.myco_tool IS NOT NULL`;

/**
 * The plan calls that read.
 *
 * An allow-list, not a deny-list. `myco_plans` today reads under `list` and `get`
 * and writes under `save` and `delete`; naming what reads means a write op added
 * later is counted by nobody, where naming what writes would have every new op
 * counted as a read until someone remembered this line. The absent op is the
 * tool's own default, which is `list`.
 */
const kpis_PLAN_READ = `c.myco_tool = 'myco_plans' AND (c.myco_op IS NULL OR c.myco_op IN ('list', 'get'))`;

/** Prompts and the served share of them. */
async function kpis_promptMeasures(db: kpis_import_RelationalStore, since: number | null): Promise<{ prompts: number; served: number; withSpores: number }> {
  const w = kpis_windowClause('p.created_at', since);
  const row = await db.prepare(`SELECT COUNT(*) AS prompts,
      COALESCE(SUM(${kpis_SERVED_PROMPTS}), 0) AS served,
      COALESCE(SUM(EXISTS (SELECT 1 FROM spore_injections i
        WHERE i.project_id = p.project_id AND i.session_id = p.session_id
          AND i.delivered_prompt_id = p.prompt_id AND i.delivered_at IS NOT NULL AND i.spore_ids <> '[]')), 0) AS withSpores
    FROM ${kpis_PROMPTS} p WHERE ${w.sql}`).bind(...w.params)
    .first<{ prompts: number; served: number; withSpores: number }>();
  return row!;
}

/** Receipts use their delivery instant for the window and their delivery hint for placement. */
async function kpis_deliveryMeasures(db: kpis_import_RelationalStore, since: number | null): Promise<kpis_KpiReport['deliveries']> {
  const w = kpis_windowClause('i.delivered_at', since);
  const placed = hook_placement_hookPlacementSql({ project: 'i.project_id', session: 'i.session_id', prompt: 'i.delivered_prompt_id' });
  const row = await db.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN ${placed} THEN 1 ELSE 0 END), 0) AS placed
    FROM projects pr CROSS JOIN spore_injections i
    WHERE i.project_id = pr.project_id AND i.delivered_at IS NOT NULL AND ${w.sql}`)
    .bind(...w.params).first<{ total: number; placed: number }>();
  return { placed: row?.placed ?? 0, unplaced: (row?.total ?? 0) - (row?.placed ?? 0) };
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
async function kpis_harnessSplit(db: kpis_import_RelationalStore, since: number | null): Promise<kpis_HarnessMeasure[]> {
  const prompts = kpis_windowClause('p.created_at', since);
  const calls = kpis_windowClause('c.created_at', since);
  const [promptRows, callRows] = await Promise.all([
    db.prepare(`SELECT ${kpis_HARNESS_OF('p')} AS harness, COUNT(*) AS n FROM ${kpis_PROMPTS} p WHERE ${prompts.sql} GROUP BY harness`)
      .bind(...prompts.params).all<{ harness: string; n: number }>(),
    db.prepare(`SELECT ${kpis_HARNESS_OF('c')} AS harness, COUNT(*) AS n FROM ${kpis_MYCO_CALLS} c WHERE ${calls.sql} AND ${kpis_MYCO_CALL} GROUP BY 1`)
      .bind(...calls.params).all<{ harness: string; n: number }>(),
  ]);
  const promptsBy = new Map(promptRows.results.map((r) => [r.harness, r.n]));
  const callsBy = new Map(callRows.results.map((r) => [r.harness, r.n]));
  return [...new Set([...promptsBy.keys(), ...callsBy.keys()])]
    .map((harness) => ({ harness, calls: callsBy.get(harness) ?? 0, ...kpis_rate(callsBy.get(harness) ?? 0, promptsBy.get(harness) ?? 0) }))
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
async function kpis_firstInjectionSamples(db: kpis_import_RelationalStore, since: number | null): Promise<number[]> {
  const w = kpis_windowClause('c.lineage_started_at', since);
  const { results } = await db.prepare(`SELECT c.lineage_root AS lineage, MIN(c.lineage_started_at) AS started,
                     MIN((SELECT MIN(x.created_at) FROM (
                            SELECT MIN(i.created_at) AS created_at FROM spore_injections i
                              WHERE i.project_id = sess.project_id AND i.session_id = sess.session_id
                            UNION ALL
                            SELECT MIN(s.created_at) AS created_at FROM session_injections s
                              WHERE s.project_id = sess.project_id AND s.session_id = sess.session_id) x)) AS first_served
                FROM member_credentials c ${since === null ? '' : 'INDEXED BY idx_member_credentials_started'}
                CROSS JOIN sessions sess ON sess.created_by_token_id = c.id
               WHERE ${w.sql}
               GROUP BY c.lineage_root`)
    .bind(...w.params)
    .all<{ lineage: string; started: number; first_served: number | null }>();
  return results
    .flatMap((r) => (r.first_served === null ? [] : [r.first_served - r.started]))
    .filter((ms) => ms >= 0)
    .sort((a, b) => a - b);
}

const kpis_IDENTITY_KINDS = { unrecognized: 'unrecognized', unmarked: 'unmarked', openerConflict: 'opener_conflict', contractViolation: 'contract_violation' } as const;

/** The prompt identity counts per harness (`KpiReport.promptIdentity`), each a count over stored rows. */
async function kpis_promptIdentityCounts(db: kpis_import_RelationalStore, since: number | null): Promise<kpis_PromptIdentityCounts[]> {
  const claimed = kpis_windowClause('p.created_at', since);
  const refused = kpis_windowClause('c.created_at', since);
  const answered = kpis_windowClause('a.created_at', since);
  const registered = kpis_windowClause('t.first_received_at', since);
  const kinds = Object.values(kpis_IDENTITY_KINDS).map((kind) => `SUM(p.prompt_kind = '${kind}') AS "${kind}"`).join(', ');
  const [rows, conflicts, unpinned, duplicates, mixed] = await Promise.all([
    db.prepare(`SELECT ${kpis_HARNESS_OF('p')} AS harness, COUNT(*) AS n, ${kinds}, SUM(p.claim = 'reused') AS reused
        FROM ${kpis_PROMPTS} p WHERE p.claim IS NOT NULL AND ${claimed.sql} GROUP BY harness`)
      .bind(...claimed.params).all<Record<string, number | string>>(),
    db.prepare(`SELECT ${kpis_HARNESS_OF('c')} AS harness, COUNT(*) AS n FROM projects pr CROSS JOIN prompt_identity_conflicts c
        WHERE c.project_id = pr.project_id AND ${refused.sql} GROUP BY harness`).bind(...refused.params).all<{ harness: string; n: number }>(),
    db.prepare(`SELECT t.agent AS harness, COUNT(*) AS n FROM projects pr CROSS JOIN transcripts t WHERE t.project_id = pr.project_id AND t.prompt_identity_scheme IS NULL
        AND t.agent IN (${kpis_DECLARED_AGENTS.map(() => '?').join(', ')}) AND ${registered.sql} GROUP BY t.agent`)
      .bind(...kpis_DECLARED_AGENTS, ...registered.params).all<{ harness: string; n: number }>(),
    db.prepare(`SELECT ${kpis_HARNESS_OF('a')} AS harness, COUNT(*) AS n FROM projects pr CROSS JOIN prompt_context_answers a
        WHERE a.project_id = pr.project_id AND ${answered.sql} AND EXISTS (SELECT 1 FROM json_each(a.skipped) j WHERE j.value = 'spores:duplicate_prompt') GROUP BY harness`)
      .bind(...answered.params).all<{ harness: string; n: number }>(),
    db.prepare(`SELECT agent AS harness, COUNT(*) AS n FROM (SELECT t.agent AS agent FROM projects pr CROSS JOIN transcripts t
        WHERE t.project_id = pr.project_id AND t.agent IN (${kpis_DECLARED_AGENTS.map(() => '?').join(', ')}) AND t.prompt_identity_scheme IS NOT NULL AND ${registered.sql}
        GROUP BY t.project_id, t.session_id, t.agent HAVING COUNT(DISTINCT t.prompt_identity_scheme) > 1) GROUP BY agent`)
      .bind(...kpis_DECLARED_AGENTS, ...registered.params).all<{ harness: string; n: number }>(),
  ]);
  const byHarness = new Map<string, kpis_PromptIdentityCounts>();
  const of = (harness: string): kpis_PromptIdentityCounts => {
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
    for (const [field, kind] of Object.entries(kpis_IDENTITY_KINDS)) counts[field as keyof typeof kpis_IDENTITY_KINDS] = Number(row[kind] ?? 0);
  }
  for (const row of conflicts.results) of(row.harness).identityConflicts = row.n;
  for (const row of unpinned.results) of(row.harness).schemeConflicts = row.n;
  for (const row of duplicates.results) of(row.harness).duplicatePromptSkips = row.n;
  for (const row of mixed.results) of(row.harness).mixedSchemeSessions = row.n;
  return [...byHarness.values()].sort((a, b) => b.sampleSize - a.sampleSize || a.harness.localeCompare(b.harness));
}

/** Every measure, over the window a caller asked for. */
async function kpis_readKpis(db: kpis_import_RelationalStore, opts: { windowDays: number | null; now: number }): Promise<kpis_KpiReport> {
  const since = opts.windowDays === null ? null : opts.now - opts.windowDays * 86_400_000;
  const sessionWindow = kpis_windowClause('first_received_at', since);
  const callWindow = kpis_windowClause('c.created_at', since);

  const [{ prompts, served, withSpores }, byHarness, sessionCounts, callCounts, firstInjections, identity, deliveries] = await Promise.all([
    kpis_promptMeasures(db, since),
    kpis_harnessSplit(db, since),
    db.prepare(`SELECT COUNT(*) AS sessions, COALESCE(SUM(${kpis_SESSIONS_STARTED_WITH_BLOCK}), 0) AS startedWithBlock
      FROM projects pr CROSS JOIN sessions ON sessions.project_id = pr.project_id WHERE ${sessionWindow.sql}`)
      .bind(...sessionWindow.params).first<{ sessions: number; startedWithBlock: number }>(),
    db.prepare(`SELECT COUNT(*) AS mycoCalls, COALESCE(SUM(${kpis_PLAN_READ}), 0) AS planReads
      FROM ${kpis_MYCO_CALLS} c WHERE ${callWindow.sql} AND ${kpis_MYCO_CALL}`)
      .bind(...callWindow.params).first<{ mycoCalls: number; planReads: number }>(),
    kpis_firstInjectionSamples(db, since),
    kpis_promptIdentityCounts(db, since),
    kpis_deliveryMeasures(db, since),
  ]);
  const { sessions, startedWithBlock } = sessionCounts!;
  const { mycoCalls, planReads } = callCounts!;

  return {
    windowDays: opts.windowDays,
    since,
    promptsServed: served,
    deliveries,
    servedShare: kpis_share(served, prompts),
    sporeServeRate: kpis_share(withSpores, prompts),
    sessionStartPresent: kpis_share(startedWithBlock, sessions),
    callsPerPrompt: kpis_rate(mycoCalls, prompts),
    callsPerPromptByHarness: byHarness,
    planReadsPerSession: kpis_rate(planReads, sessions),
    firstInjectionMs: { value: kpis_median(firstInjections), sampleSize: firstInjections.length },
    recallQuality: { value: kpis_import_recallQuality, sampleSize: kpis_import_caseCount },
    promptIdentity: identity,
  };
}

export { type kpis_Measure, type kpis_HarnessMeasure, type kpis_KpiReport, type kpis_PromptIdentityCounts, kpis_KPI_WINDOWS, kpis_kpiWindow, kpis_median, kpis_readKpis };
