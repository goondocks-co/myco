/**
 * Release provenance for one Project: its configuration, its credential, and
 * the scheduled check that answers whether captured work shipped.
 *
 * **One owner.** Every write of `project_release_provenance` and every
 * reconciler write of `knowledge_release_state` goes through this module.
 * Reads of release state stay in `provenance.ts`.
 *
 * **The credential has one purpose.** It is sealed under its own slot,
 * `release-provenance:{project}:{revision}`, and is used only to read release
 * tags and pull requests. It never falls back to the repository read
 * credential and is never read by anything else (#1212). A surface learns only
 * whether one is configured and what it is for.
 *
 * **History is kept.** A `released` row is final and never rewritten. A check
 * that cannot reach an answer — a rejected credential, a rate limit, a spent
 * budget, a timeout — writes no row: the previous state stays with its own
 * `checked_at`, and the Project's latest check records what stopped it, so the
 * state's age and the failed check are both visible. A row keeps its identity
 * and source; newer evidence updates its state in place.
 *
 * **Bounded.** One check makes at most the Project's configured number of
 * GitHub reads, classifies at most `SESSIONS_PER_CHECK` sessions, and skips a
 * session already classified under the same refs fingerprint, so a quiet
 * repository costs its tag listings and nothing more.
 */
import type { ServerEnv, OutboundFetch, RelationalStore } from './adapters.js';
import type { SecretStore } from './secrets.js';
import { deploymentSecretStore } from './secrets.js';
import { leafValues } from './settings.js';
import { repositoryIdentity } from './repositories.js';
import { githubReads, isGithubRepo, type GithubFailure } from './github-refs.js';
import {
  classifyCommit, memoizedCompare, resolveRunRefs, type Classification, type PackageTagMapping,
} from './release-classify.js';
import { emit } from '../telemetry.js';

export const RELEASE_PROVENANCE_JOB = 'release-provenance-reconcile';
export const RECONCILE_INTERVAL_LEAF = 'release_provenance.reconcile_interval_minutes';
export const DEFAULT_RECONCILE_INTERVAL_MINUTES = 15;
export const DEFAULT_MAX_LOOKUPS = 50;
export const MAX_LOOKUPS_CEILING = 1_000;
export const SESSIONS_PER_CHECK = 200;
/** How many Projects one pass checks; the rest are due on the next tick. */
export const PROJECTS_PER_PASS = 3;
const MAX_REFS = 20;
const MAX_REF_CHARS = 200;
const MAX_PACKAGE_MAPPINGS = 50;
const MAX_PATHS_PER_SESSION = 500;
const MAX_CREDENTIAL_CHARS = 4096;
const REF_GRAMMAR = /^[A-Za-z0-9._/*?-]+$/;

/** What the credential is for, in the words a settings surface shows. */
export const RELEASE_CREDENTIAL_PURPOSE = 'Reads release tags and pull requests for this Project. It is not used for code tasks.';

export class ReleaseProvenanceInputError extends Error {}
export class ReleaseProvenanceConflictError extends Error {
  constructor() { super('The release provenance settings changed. Refresh before saving again.'); }
}

export interface ReleaseProvenanceSettings {
  enabled: boolean;
  githubRepo: string | null;
  productionRefs: string[];
  integrationRefs: string[];
  packageMap: PackageTagMapping[];
  includeUnknown: boolean;
  maxLookups: number;
}

export interface ReleaseCheckCounts {
  checked: number;
  changed: number;
  unchanged: number;
  unknown: number;
  unavailable: number;
  deferred: number;
}

export type ReleaseCheckStatus = 'complete' | 'partial' | 'unavailable';

export interface ReleaseCheck {
  requestedAt: number | null;
  startedAt: number | null;
  finishedAt: number | null;
  status: ReleaseCheckStatus | null;
  failure: string | null;
  counts: ReleaseCheckCounts | null;
  lookups: number | null;
  lastCompleteAt: number | null;
}

export interface ReleaseProvenanceView extends ReleaseProvenanceSettings {
  revision: string | null;
  updatedAt: number | null;
  updatedBy: string | null;
  credential: { configured: boolean; purpose: string };
  /** The `owner/name` the connected repository names, when it is on GitHub: a default the owner may accept, never stored silently. */
  suggestedRepo: string | null;
  check: ReleaseCheck | null;
}

export interface ReleaseProvenanceWrite extends ReleaseProvenanceSettings {
  revision: string | null;
  /** Omitted keeps the stored credential while the repository is unchanged; null removes it. */
  credential?: { token: string } | null;
}

interface Row {
  revision: string;
  enabled: number;
  githubRepo: string | null;
  productionRefs: string;
  integrationRefs: string;
  packageMap: string;
  includeUnknown: number;
  maxLookups: number;
  secretSlot: string | null;
  updatedAt: number;
  updatedBy: string;
  checkRequestedAt: number | null;
  checkStartedAt: number | null;
  checkFinishedAt: number | null;
  checkStatus: ReleaseCheckStatus | null;
  checkFailure: string | null;
  checkCounts: string | null;
  checkLookups: number | null;
  lastCompleteAt: number | null;
}

const SELECT_ROW = `SELECT revision, enabled, github_repo AS githubRepo, production_refs AS productionRefs,
  integration_refs AS integrationRefs, package_map AS packageMap, include_unknown AS includeUnknown,
  max_lookups AS maxLookups, secret_slot AS secretSlot, updated_at AS updatedAt, updated_by AS updatedBy,
  check_requested_at AS checkRequestedAt, check_started_at AS checkStartedAt, check_finished_at AS checkFinishedAt,
  check_status AS checkStatus, check_failure AS checkFailure, check_counts AS checkCounts,
  check_lookups AS checkLookups, last_complete_at AS lastCompleteAt
  FROM project_release_provenance WHERE project_id = ?`;

const parseList = <T>(json: string | null): T[] => {
  try { const value = JSON.parse(json ?? '[]'); return Array.isArray(value) ? value as T[] : []; } catch { return []; }
};

const DEFAULTS: ReleaseProvenanceSettings = {
  enabled: false, githubRepo: null, productionRefs: [], integrationRefs: [], packageMap: [], includeUnknown: true, maxLookups: DEFAULT_MAX_LOOKUPS,
};

function settingsOf(row: Row): ReleaseProvenanceSettings {
  return {
    enabled: row.enabled === 1,
    githubRepo: row.githubRepo,
    productionRefs: parseList<string>(row.productionRefs),
    integrationRefs: parseList<string>(row.integrationRefs),
    packageMap: parseList<PackageTagMapping>(row.packageMap),
    includeUnknown: row.includeUnknown === 1,
    maxLookups: row.maxLookups,
  };
}

function checkOf(row: Row): ReleaseCheck | null {
  if (row.checkRequestedAt === null && row.checkStartedAt === null) return null;
  return {
    requestedAt: row.checkRequestedAt,
    startedAt: row.checkStartedAt,
    finishedAt: row.checkFinishedAt,
    status: row.checkStatus,
    failure: row.checkFailure,
    counts: row.checkCounts === null ? null : JSON.parse(row.checkCounts) as ReleaseCheckCounts,
    lookups: row.checkLookups,
    lastCompleteAt: row.lastCompleteAt,
  };
}

/** `owner/name` from a GitHub HTTPS URL, or null for any other host. */
export function githubRepoOf(url: string | null | undefined): string | null {
  if (!url) return null;
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(url.trim());
  const repo = match ? `${match[1]}/${match[2]}` : null;
  return isGithubRepo(repo) ? repo : null;
}

function refList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_REFS) throw new ReleaseProvenanceInputError(`${label} is a list of at most ${MAX_REFS} refs.`);
  const refs = value.map((ref) => (typeof ref === 'string' ? ref.trim() : ''));
  for (const ref of refs) {
    if (!ref || ref.length > MAX_REF_CHARS || !REF_GRAMMAR.test(ref) || ref.includes('..')) {
      throw new ReleaseProvenanceInputError(`${label} holds a ref that is not a git ref or pattern.`);
    }
  }
  return [...new Set(refs)];
}

/** The validated settings a write carries, or an input error naming the field. */
export function validateSettings(input: Record<string, unknown>): ReleaseProvenanceSettings {
  const githubRepo = input.githubRepo === null || input.githubRepo === '' ? null : input.githubRepo;
  if (githubRepo !== null && !isGithubRepo(githubRepo)) throw new ReleaseProvenanceInputError('The GitHub repository is named owner/name.');
  if (typeof input.enabled !== 'boolean' || typeof input.includeUnknown !== 'boolean') throw new ReleaseProvenanceInputError('Tracking and unknown reporting are on or off.');
  const productionRefs = refList(input.productionRefs, 'Production refs');
  const integrationRefs = refList(input.integrationRefs, 'Integration refs');
  if (!Array.isArray(input.packageMap) || input.packageMap.length > MAX_PACKAGE_MAPPINGS) {
    throw new ReleaseProvenanceInputError(`The package map holds at most ${MAX_PACKAGE_MAPPINGS} mappings.`);
  }
  const packageMap = input.packageMap.map((entry) => {
    const { pathGlob, tagPattern } = (entry ?? {}) as Record<string, unknown>;
    if (typeof pathGlob !== 'string' || !pathGlob.trim() || pathGlob.length > 256 || pathGlob.includes('..')) {
      throw new ReleaseProvenanceInputError('Each package mapping names a repository path.');
    }
    return { pathGlob: pathGlob.trim(), tagPattern: refList([tagPattern], 'A package mapping')[0] };
  });
  const maxLookups = input.maxLookups;
  if (typeof maxLookups !== 'number' || !Number.isInteger(maxLookups) || maxLookups < 1 || maxLookups > MAX_LOOKUPS_CEILING) {
    throw new ReleaseProvenanceInputError(`Lookups per check is a whole number from 1 to ${MAX_LOOKUPS_CEILING}.`);
  }
  if (input.enabled === true && githubRepo === null) throw new ReleaseProvenanceInputError('Tracking needs a GitHub repository.');
  if (input.enabled === true && productionRefs.length === 0 && integrationRefs.length === 0) {
    throw new ReleaseProvenanceInputError('Tracking needs at least one production or integration ref.');
  }
  return { enabled: input.enabled, githubRepo, productionRefs, integrationRefs, packageMap, includeUnknown: input.includeUnknown, maxLookups };
}

/** The single writer of a Project's release provenance settings, its sealed credential and its check requests. */
export function releaseProvenance(db: RelationalStore, secrets: SecretStore) {
  const row = (projectId: string) => db.prepare(SELECT_ROW).bind(projectId).first<Row>();

  const describe = async (projectId: string): Promise<ReleaseProvenanceView> => {
    const [current, identity] = await Promise.all([row(projectId), repositoryIdentity(db, { projectId })]);
    const configured = current?.secretSlot ? (await secrets.describe(current.secretSlot)).configured : false;
    return {
      ...(current === null ? DEFAULTS : settingsOf(current)),
      revision: current?.revision ?? null,
      updatedAt: current?.updatedAt ?? null,
      updatedBy: current?.updatedBy ?? null,
      credential: { configured, purpose: RELEASE_CREDENTIAL_PURPOSE },
      suggestedRepo: githubRepoOf(identity?.url),
      check: current === null ? null : checkOf(current),
    };
  };

  return {
    describe,
    async save(projectId: string, input: ReleaseProvenanceWrite, actor: string, now: number): Promise<ReleaseProvenanceView> {
      const settings = validateSettings(input as unknown as Record<string, unknown>);
      const credential = input.credential;
      if (credential != null && (typeof credential.token !== 'string' || !credential.token.trim() || credential.token.length > MAX_CREDENTIAL_CHARS)) {
        throw new ReleaseProvenanceInputError(`A release lookup token is at most ${MAX_CREDENTIAL_CHARS} characters.`);
      }
      const previous = await row(projectId);
      if ((previous?.revision ?? null) !== input.revision) throw new ReleaseProvenanceConflictError();
      const revision = crypto.randomUUID();
      // A token saved for one repository is never carried to another.
      const preserve = credential === undefined && previous?.githubRepo === settings.githubRepo;
      const secretSlot = credential == null ? (preserve ? previous?.secretSlot ?? null : null) : `release-provenance:${projectId}:${revision}`;
      if (credential != null) await secrets.put(secretSlot!, credential.token, actor, now);
      const values = [
        revision, settings.enabled ? 1 : 0, settings.githubRepo, JSON.stringify(settings.productionRefs),
        JSON.stringify(settings.integrationRefs), JSON.stringify(settings.packageMap), settings.includeUnknown ? 1 : 0,
        settings.maxLookups, secretSlot, now, actor,
      ];
      const statement = previous === null
        ? db.prepare(`INSERT OR IGNORE INTO project_release_provenance (revision, enabled, github_repo, production_refs, integration_refs,
            package_map, include_unknown, max_lookups, secret_slot, updated_at, updated_by, project_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(...values, projectId)
        : db.prepare(`UPDATE project_release_provenance SET revision = ?, enabled = ?, github_repo = ?, production_refs = ?, integration_refs = ?,
            package_map = ?, include_unknown = ?, max_lookups = ?, secret_slot = ?, updated_at = ?, updated_by = ?
            WHERE project_id = ? AND revision = ?`).bind(...values, projectId, previous.revision);
      const result = await statement.run();
      if (result.meta.changes !== 1) {
        if (credential != null) await secrets.delete(secretSlot!, actor, now);
        throw new ReleaseProvenanceConflictError();
      }
      if (previous?.secretSlot != null && previous.secretSlot !== secretSlot) await secrets.delete(previous.secretSlot, actor, now);
      return describe(projectId);
    },
    /** Asks the next tick to check this Project now; answers false when tracking is off. */
    async requestCheck(projectId: string, now: number): Promise<boolean> {
      const result = await db.prepare(`UPDATE project_release_provenance SET check_requested_at = ?
        WHERE project_id = ? AND enabled = 1 AND github_repo IS NOT NULL`).bind(now, projectId).run();
      return result.meta.changes === 1;
    },
  };
}

// --- The scheduled check ---

interface Candidate { sessionId: string; headSha: string | null }

const sessionIdentity = (projectId: string, namespace: string, recordId: string) => `${projectId}:${namespace}:${recordId}`;

/** Failures that stop the whole check: every later read would meet the same answer. */
const STOPS_CHECK = new Set<GithubFailure>(['budget_exhausted', 'credential_rejected', 'rate_limited', 'timeout', 'network', 'not_found', 'unexpected_response']);

async function changedPaths(db: RelationalStore, projectId: string, sessionId: string): Promise<string[]> {
  const { results } = await db.prepare(`SELECT files_affected AS files FROM tool_calls
    WHERE project_id = ? AND session_id = ? AND files_affected IS NOT NULL LIMIT 200`).bind(projectId, sessionId).all<{ files: string }>();
  const paths = new Set<string>();
  for (const { files } of results) {
    for (const path of parseList<unknown>(files)) {
      if (typeof path === 'string') paths.add(path);
      if (paths.size >= MAX_PATHS_PER_SESSION) return [...paths];
    }
  }
  return [...paths];
}

/**
 * Write one session's classification and carry it to the spores and plans
 * that session produced. A `released` row is final; everything else is
 * updated in place, keeping its id, identity and creation time.
 */
async function writeClassification(
  db: RelationalStore, projectId: string, sessionId: string, c: Classification, fingerprint: string | null, now: number,
): Promise<boolean> {
  const identity = sessionIdentity(projectId, 'sessions', sessionId);
  const previous = await db.prepare('SELECT state FROM knowledge_release_state WHERE project_id = ? AND identity_key = ?')
    .bind(projectId, identity).first<{ state: string }>();
  const evidence = JSON.stringify({ ...c.evidence, refs_fingerprint: fingerprint });
  const columns = [c.state, c.confidence, c.basisKind, c.basisRef, c.basisSha, c.releasePrNumber, c.reason, evidence, now];
  const upsert = `ON CONFLICT(project_id, identity_key) DO UPDATE SET state = excluded.state, confidence = excluded.confidence,
      basis_kind = excluded.basis_kind, basis_ref = excluded.basis_ref, basis_sha = excluded.basis_sha,
      release_pr_number = excluded.release_pr_number, reason = excluded.reason, evidence_json = excluded.evidence_json,
      checked_at = excluded.checked_at, updated_at = excluded.checked_at
    WHERE knowledge_release_state.state <> 'released'`;
  const derived = (namespace: string, table: string, key: string) => db.prepare(`INSERT INTO knowledge_release_state
      (project_id, id, identity_key, namespace, record_id, source_session_id, state, confidence, basis_kind, basis_ref,
       basis_sha, release_pr_number, reason, evidence_json, checked_at, created_at)
    SELECT project_id, 'rs_' || lower(hex(randomblob(16))), project_id || ':${namespace}:' || ${key}, '${namespace}', ${key}, session_id,
       ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      FROM ${table} WHERE project_id = ? AND session_id = ? ${upsert}`).bind(...columns, now, projectId, sessionId);
  await db.batch([
    db.prepare(`INSERT INTO knowledge_release_state (project_id, id, identity_key, namespace, record_id, source_session_id,
        state, confidence, basis_kind, basis_ref, basis_sha, release_pr_number, reason, evidence_json, checked_at, created_at)
      VALUES (?, ?, ?, 'sessions', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ${upsert}`)
      .bind(projectId, `rs_${crypto.randomUUID().replaceAll('-', '')}`, identity, sessionId, sessionId, ...columns, now),
    derived('spores', 'spores', 'id'),
    derived('plans', 'plans', 'plan_key'),
  ]);
  return previous?.state !== c.state && previous?.state !== 'released';
}

/**
 * Check one Project. Answers how many release states changed.
 *
 * The claim is optimistic: the check starts only if no other pass started it
 * after this one read the row, so two wakes racing one due Project check it once.
 */
export async function checkProject(
  db: RelationalStore, secrets: SecretStore, outbound: OutboundFetch, projectId: string, now: number,
): Promise<number> {
  const current = await db.prepare(SELECT_ROW).bind(projectId).first<Row>();
  if (current === null || current.enabled !== 1 || current.githubRepo === null) return 0;
  const claim = await db.prepare(`UPDATE project_release_provenance SET check_started_at = ?
    WHERE project_id = ? AND check_started_at IS ?`).bind(now, projectId, current.checkStartedAt).run();
  if (claim.meta.changes !== 1) return 0;

  const settings = settingsOf(current);
  const counts: ReleaseCheckCounts = { checked: 0, changed: 0, unchanged: 0, unknown: 0, unavailable: 0, deferred: 0 };
  const token = current.secretSlot === null ? null : await secrets.get(current.secretSlot);
  const reads = githubReads({ repo: current.githubRepo, token, maxLookups: settings.maxLookups, fetcher: outbound });
  let failure: string | null = null;
  let fingerprint: string | null = null;

  const repository = await reads.repository();
  if (!repository.ok) {
    failure = repository.failure === 'not_found' ? (token === null ? 'repository_not_found_without_credential' : 'repository_not_found') : repository.failure;
  } else {
    const run = await resolveRunRefs(reads, settings);
    fingerprint = run.fingerprint;
    const { results: candidates } = await db.prepare(`SELECT g.session_id AS sessionId,
        COALESCE(MAX(CASE WHEN g.capture_point = 'session_end' THEN g.head_sha END),
                 MAX(CASE WHEN g.capture_point = 'session_start' THEN g.head_sha END)) AS headSha,
        MAX(g.captured_at) AS capturedAt
      FROM knowledge_git_provenance g
      WHERE g.project_id = ? AND g.session_id IS NOT NULL AND g.capture_point IN ('session_start', 'session_end')
        AND NOT EXISTS (SELECT 1 FROM knowledge_release_state k
          WHERE k.project_id = g.project_id AND k.identity_key = ? || g.session_id
            AND (k.state = 'released' OR (? IS NOT NULL AND json_extract(k.evidence_json, '$.refs_fingerprint') = ?)))
      GROUP BY g.session_id ORDER BY capturedAt DESC, g.session_id LIMIT ?`)
      .bind(projectId, sessionIdentity(projectId, 'sessions', ''), fingerprint, fingerprint, SESSIONS_PER_CHECK + 1)
      .all<Candidate & { capturedAt: number }>();
    if (candidates.length > SESSIONS_PER_CHECK) counts.deferred += candidates.length - SESSIONS_PER_CHECK;
    const compare = memoizedCompare(reads);
    const batch = candidates.slice(0, SESSIONS_PER_CHECK);
    for (let i = 0; i < batch.length; i += 1) {
      const candidate = batch[i];
      const outcome = await classifyCommit(reads, compare, run, {
        headSha: candidate.headSha, changedPaths: await changedPaths(db, projectId, candidate.sessionId),
      });
      if (outcome.kind === 'unavailable') {
        counts.unavailable += 1;
        failure = outcome.failure;
        if (STOPS_CHECK.has(outcome.failure)) { counts.deferred += batch.length - i - 1; break; }
        continue;
      }
      counts.checked += 1;
      if (outcome.classification.state === 'unknown') {
        counts.unknown += 1;
        if (!settings.includeUnknown) continue;
      }
      if (await writeClassification(db, projectId, candidate.sessionId, outcome.classification, fingerprint, now)) counts.changed += 1;
      else counts.unchanged += 1;
    }
  }

  const status: ReleaseCheckStatus = failure === null
    ? (counts.deferred > 0 ? 'partial' : 'complete')
    : (counts.checked > 0 ? 'partial' : 'unavailable');
  await db.prepare(`UPDATE project_release_provenance SET check_finished_at = ?, check_status = ?, check_failure = ?,
      check_counts = ?, check_lookups = ?, check_fingerprint = ?,
      last_complete_at = CASE WHEN ? = 'complete' THEN ? ELSE last_complete_at END
    WHERE project_id = ?`)
    .bind(now, status, failure, JSON.stringify(counts), reads.lookupsUsed(), fingerprint, status, now, projectId).run();
  emit({ kind: 'release_provenance_check', status, failure: failure ?? 'none', lookups: reads.lookupsUsed(), ...counts });
  return counts.changed;
}

/** The interval the Deployment's leaf names, in milliseconds. */
async function intervalMs(db: RelationalStore): Promise<number> {
  const raw = (await leafValues(db, [RECONCILE_INTERVAL_LEAF])).get(RECONCILE_INTERVAL_LEAF);
  let minutes = DEFAULT_RECONCILE_INTERVAL_MINUTES;
  try { if (raw !== undefined) minutes = Number(JSON.parse(raw)); } catch { /* the default stands */ }
  return (Number.isFinite(minutes) && minutes >= 1 ? minutes : DEFAULT_RECONCILE_INTERVAL_MINUTES) * 60_000;
}

/**
 * The job: check each enabled Project whose interval has passed, or whose
 * owner asked for a check after the last one started, oldest first.
 */
export async function reconcileReleaseProvenance(env: ServerEnv, now: number): Promise<number> {
  const interval = await intervalMs(env.db);
  const { results } = await env.db.prepare(`SELECT project_id AS projectId FROM project_release_provenance
    WHERE enabled = 1 AND github_repo IS NOT NULL
      AND (check_started_at IS NULL OR check_started_at <= ? OR check_requested_at > check_started_at)
    ORDER BY COALESCE(check_started_at, 0), project_id LIMIT ?`).bind(now - interval, PROJECTS_PER_PASS).all<{ projectId: string }>();
  if (results.length === 0) return 0;
  const secrets = deploymentSecretStore(env.db, env.wrappingKey);
  let changed = 0;
  for (const { projectId } of results) changed += await checkProject(env.db, secrets, env.outbound, projectId, now);
  return changed;
}
