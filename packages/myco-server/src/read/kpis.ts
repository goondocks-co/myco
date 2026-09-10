/**
 * The six measures the Deployment reports about itself, each with the sample
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
 * from a machine joining to its first served context, and the evaluation pass
 * rate — are properties of the Deployment and of a credential lineage, not of one
 * Project, and splitting the page by Project would leave those two answering a
 * different question from the other four.
 */
import type { RelationalStore } from '../core/adapters.js';

/** A measured value and the number of rows behind it. A sample of zero carries a null value. */
export interface Measure {
  value: number | null;
  sampleSize: number;
}

/** One harness's diagnostic rate, named by the harness the session's transcript reports. */
export interface HarnessMeasure extends Measure {
  harness: string;
}

export interface KpiReport {
  /** The trailing window in days, or null when every row counts. */
  windowDays: number | null;
  /** The earliest stamp a row may carry to be counted, or null for all of them. */
  since: number | null;
  /** Prompts that arrived carrying context this Deployment served, as a share of every prompt. */
  contextPresent: Measure;
  /** Prompts served at least one observation, as a share of every prompt. */
  sporeServeRate: Measure;
  /** Myco tool calls per prompt across the Deployment, with the per-harness split behind it. */
  callsPerPrompt: Measure;
  callsPerPromptByHarness: HarnessMeasure[];
  /** Plan reads per session. */
  planReadsPerSession: Measure;
  /** Median milliseconds from a machine's credential lineage starting to the first context served into one of its sessions. */
  firstInjectionMs: Measure;
  /** The share of recorded evaluations that passed. No evaluation feed exists, so the sample is empty. */
  evalPassRate: Measure;
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
 * Prompts the Deployment served context for.
 *
 * A prompt counts when either record of having served it exists: a
 * `spore_injections` row naming the prompt, or a `session_injections` row for its
 * session stamped no later than the prompt. Both records are written only when
 * something actually reached the agent, which is what makes them evidence of
 * presence rather than of intent.
 */
const SERVED_PROMPTS = `
  EXISTS (SELECT 1 FROM spore_injections i
           WHERE i.project_id = p.project_id AND i.session_id = p.session_id AND i.prompt_id = p.prompt_id)
  OR EXISTS (SELECT 1 FROM session_injections s
              WHERE s.project_id = p.project_id AND s.session_id = p.session_id AND s.created_at <= p.created_at)`;

/** The tool calls that count as reaching Myco at all. */
const MYCO_CALL = `c.myco_tool IS NOT NULL`;

/** The plan calls that read rather than write. `myco_plans` writes under `save`; every other op reads. */
const PLAN_READ = `c.myco_tool = 'myco_plans' AND (c.myco_op IS NULL OR c.myco_op <> 'save')`;

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
                       AND i.prompt_id = p.prompt_id AND i.spore_ids <> '[]')`, w.params),
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
    .map((harness) => ({ harness, ...rate(callsBy.get(harness) ?? 0, promptsBy.get(harness) ?? 0) }))
    .sort((a, b) => b.sampleSize - a.sampleSize || a.harness.localeCompare(b.harness));
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

/** Every measure, over the window a caller asked for. */
export async function readKpis(db: RelationalStore, opts: { windowDays: number | null; now: number }): Promise<KpiReport> {
  const since = opts.windowDays === null ? null : opts.now - opts.windowDays * 86_400_000;
  const sessionWindow = windowClause('first_received_at', since);
  const callWindow = windowClause('c.created_at', since);

  const [{ prompts, served, withSpores }, byHarness, sessions, planReads, mycoCalls, firstInjections] = await Promise.all([
    promptMeasures(db, since),
    harnessSplit(db, since),
    countOf(db, `SELECT COUNT(*) AS n FROM sessions WHERE ${sessionWindow.sql}`, sessionWindow.params),
    countOf(db, `SELECT COUNT(*) AS n FROM tool_calls c WHERE ${callWindow.sql} AND ${PLAN_READ}`, callWindow.params),
    countOf(db, `SELECT COUNT(*) AS n FROM tool_calls c WHERE ${callWindow.sql} AND ${MYCO_CALL}`, callWindow.params),
    firstInjectionSamples(db, since),
  ]);

  return {
    windowDays: opts.windowDays,
    since,
    contextPresent: share(served, prompts),
    sporeServeRate: share(withSpores, prompts),
    callsPerPrompt: rate(mycoCalls, prompts),
    callsPerPromptByHarness: byHarness,
    planReadsPerSession: rate(planReads, sessions),
    firstInjectionMs: { value: median(firstInjections), sampleSize: firstInjections.length },
    evalPassRate: { value: null, sampleSize: 0 },
  };
}
