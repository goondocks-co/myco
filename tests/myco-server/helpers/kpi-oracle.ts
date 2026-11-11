import type { RelationalStore as kpis_import_RelationalStore } from "@myco-server-worker/core/adapters.js";
import { CAPTURE_RULE_BUNDLES as kpis_import_CAPTURE_RULE_BUNDLES } from "@goondocks/myco-shared/capture-rules-data";
import { recallQuality as kpis_import_recallQuality } from "@myco-server-worker/evals/recall-baseline.js";
import { caseCount as kpis_import_caseCount } from "@myco-server-worker/evals/recall-baseline.js";
import { placedPromptSql } from '@myco-server-worker/db/documents/live-generation.js';

const kpis_PROMPTS = `(SELECT p.* FROM projects pr CROSS JOIN session_prompts p CROSS JOIN session_documents d
  WHERE p.project_id = pr.project_id AND d.project_id = p.project_id AND d.session_id = p.session_id
    AND d.generation = p.generation AND d.state = 'live')`;

const kpis_MYCO_CALLS = `(SELECT c.* FROM projects pr CROSS JOIN myco_tool_calls c CROSS JOIN session_documents d
  WHERE c.project_id = pr.project_id AND d.project_id = c.project_id AND d.session_id = c.session_id
    AND d.generation = c.generation AND d.state = 'live')`;

const kpis_DECLARED_AGENTS: readonly string[] = kpis_import_CAPTURE_RULE_BUNDLES.map((bundle) => bundle.name);

interface kpis_Measure {
  value: number | null;
  sampleSize: number;
}

interface kpis_HarnessMeasure extends kpis_Measure {
  harness: string;
  calls: number;
}

interface kpis_KpiReport {
  windowDays: number | null;
  since: number | null;
  promptsServed: number;
  deliveries: { placed: number; unplaced: number };
  servedShare: kpis_Measure;
  sporeServeRate: kpis_Measure;
  sessionStartPresent: kpis_Measure;
  callsPerPrompt: kpis_Measure;
  callsPerPromptByHarness: kpis_HarnessMeasure[];
  planReadsPerSession: kpis_Measure;
  firstInjectionMs: kpis_Measure;
  recallQuality: kpis_Measure;
  promptIdentity: kpis_PromptIdentityCounts[];
}

interface kpis_PromptIdentityCounts {
  harness: string;
  sampleSize: number;
  unrecognized: number;
  unmarked: number;
  openerConflict: number;
  contractViolation: number;
  reused: number;
  identityConflicts: number;
  schemeConflicts: number;
  mixedSchemeSessions: number;
  duplicatePromptSkips: number;
}

const kpis_share = (numerator: number, sampleSize: number): kpis_Measure =>
  ({ value: sampleSize === 0 ? null : numerator / sampleSize, sampleSize });

const kpis_rate = kpis_share;

function kpis_median(sorted: readonly number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const kpis_HARNESS_OF = (alias: string): string => `COALESCE((
  SELECT t.agent FROM transcripts t INDEXED BY idx_transcripts_session
   WHERE t.project_id = ${alias}.project_id AND t.session_id = ${alias}.session_id AND t.role = 'primary'
   ORDER BY t.first_received_at, t.transcript_id LIMIT 1), 'unrecorded')`;

const kpis_windowClause = (column: string, since: number | null, until: number): { sql: string; params: number[] } =>
  since === null ? { sql: `${column} <= ?`, params: [until] } : { sql: `${column} BETWEEN ? AND ?`, params: [since, until] };

const kpis_SERVED_PROMPTS = `
  EXISTS (SELECT 1 FROM spore_injections i
           WHERE i.project_id = p.project_id AND i.session_id = p.session_id AND i.delivered_prompt_id = p.prompt_id AND i.delivered_at IS NOT NULL)
  OR EXISTS (SELECT 1 FROM session_injections j
              WHERE j.project_id = p.project_id AND j.session_id = p.session_id AND j.kind = 'plan-nudge'
                AND j.delivered_prompt_id = p.prompt_id AND j.delivered_at IS NOT NULL)`;

const kpis_SESSIONS_STARTED_WITH_BLOCK = `EXISTS (SELECT 1 FROM session_injections j
  WHERE j.project_id = sessions.project_id AND j.session_id = sessions.session_id AND j.kind = 'cortex')`;

const kpis_MYCO_CALL = `c.myco_tool IS NOT NULL`;

const kpis_PLAN_READ = `c.myco_tool = 'myco_plans' AND (c.myco_op IS NULL OR c.myco_op IN ('list', 'get'))`;

async function kpis_promptMeasures(db: kpis_import_RelationalStore, since: number | null, until: number): Promise<{ prompts: number; served: number; withSpores: number }> {
  const w = kpis_windowClause('p.created_at', since, until);
  const row = await db.prepare(`SELECT COUNT(*) AS prompts,
      COALESCE(SUM(${kpis_SERVED_PROMPTS}), 0) AS served,
      COALESCE(SUM(EXISTS (SELECT 1 FROM spore_injections i
        WHERE i.project_id = p.project_id AND i.session_id = p.session_id
          AND i.delivered_prompt_id = p.prompt_id AND i.delivered_at IS NOT NULL AND i.spore_ids <> '[]')), 0) AS withSpores
    FROM ${kpis_PROMPTS} p WHERE ${w.sql}`).bind(...w.params)
    .first<{ prompts: number; served: number; withSpores: number }>();
  return row!;
}

async function kpis_deliveryMeasures(db: kpis_import_RelationalStore, since: number | null, until: number): Promise<kpis_KpiReport['deliveries']> {
  const w = kpis_windowClause('i.delivered_at', since, until);
  const placed = placedPromptSql({ project: 'i.project_id', session: 'i.session_id', prompt: 'i.delivered_prompt_id' });
  const row = await db.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN ${placed} THEN 1 ELSE 0 END), 0) AS placed
    FROM projects pr CROSS JOIN spore_injections i
    WHERE i.project_id = pr.project_id AND i.delivered_at IS NOT NULL AND ${w.sql}`)
    .bind(...w.params).first<{ total: number; placed: number }>();
  return { placed: row?.placed ?? 0, unplaced: (row?.total ?? 0) - (row?.placed ?? 0) };
}

async function kpis_harnessSplit(db: kpis_import_RelationalStore, since: number | null, until: number): Promise<kpis_HarnessMeasure[]> {
  const prompts = kpis_windowClause('p.created_at', since, until);
  const calls = kpis_windowClause('c.created_at', since, until);
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

async function kpis_firstInjectionSamples(db: kpis_import_RelationalStore, since: number | null, until: number): Promise<number[]> {
  const w = kpis_windowClause('c.lineage_started_at', since, until);
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

async function kpis_promptIdentityCounts(db: kpis_import_RelationalStore, since: number | null, until: number): Promise<kpis_PromptIdentityCounts[]> {
  const claimed = kpis_windowClause('p.created_at', since, until);
  const refused = kpis_windowClause('c.created_at', since, until);
  const answered = kpis_windowClause('a.created_at', since, until);
  const registered = kpis_windowClause('t.first_received_at', since, until);
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

async function kpis_readKpis(db: kpis_import_RelationalStore, opts: { windowDays: number | null; now: number }): Promise<kpis_KpiReport> {
  const today = Math.floor(opts.now / 86_400_000);
  const since = opts.windowDays === null ? null : (today - opts.windowDays) * 86_400_000;
  const until = (today + 1) * 86_400_000 - 1;
  const sessionWindow = kpis_windowClause('first_received_at', since, until);
  const callWindow = kpis_windowClause('c.created_at', since, until);

  const [{ prompts, served, withSpores }, byHarness, sessionCounts, callCounts, firstInjections, identity, deliveries] = await Promise.all([
    kpis_promptMeasures(db, since, until),
    kpis_harnessSplit(db, since, until),
    db.prepare(`SELECT COUNT(*) AS sessions, COALESCE(SUM(${kpis_SESSIONS_STARTED_WITH_BLOCK}), 0) AS startedWithBlock
      FROM projects pr CROSS JOIN sessions ON sessions.project_id = pr.project_id WHERE ${sessionWindow.sql}`)
      .bind(...sessionWindow.params).first<{ sessions: number; startedWithBlock: number }>(),
    db.prepare(`SELECT COUNT(*) AS mycoCalls, COALESCE(SUM(${kpis_PLAN_READ}), 0) AS planReads
      FROM ${kpis_MYCO_CALLS} c WHERE ${callWindow.sql} AND ${kpis_MYCO_CALL}`)
      .bind(...callWindow.params).first<{ mycoCalls: number; planReads: number }>(),
    kpis_firstInjectionSamples(db, since, until),
    kpis_promptIdentityCounts(db, since, until),
    kpis_deliveryMeasures(db, since, until),
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

export { kpis_readKpis };
