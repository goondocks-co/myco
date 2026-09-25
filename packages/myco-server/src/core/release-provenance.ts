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
 * credential and is never read by anything else. A surface learns only
 * whether one is configured and what it is for.
 *
 * **The source is the session's latest captured commit.** A session's end
 * commit is classified when captured; with only its start commit, its own work
 * is uncaptured and the answer is `unknown`, as it is for an end commit with
 * uncommitted tracked changes or with cleanliness git could not read. Each row
 * records its source commit, and a new source is classified afresh.
 *
 * **History is kept.** A `released` row is final for the source it was
 * checked from; a row without a recorded source is final outright. Every
 * change of state keeps the state it replaced in `evidence_json.previous`. A
 * check that cannot reach an answer — a rejected credential, a rate limit, a
 * spent budget, a timeout, unreadable stored data — writes no state: the
 * previous one stays with its own `checked_at`, and the Project's latest check
 * records what stopped it.
 *
 * **One check at a time, and only for the settings it read.** A check claims
 * the Project with a run id and a lease under the revision it read. Every
 * state it writes and its outcome land only while that claim stands; a
 * settings save clears the claim, so a check still waiting on GitHub for the
 * previous repository publishes nothing.
 *
 * **Bounded.** One check makes at most the Project's configured number of
 * GitHub reads, classifies at most `SESSIONS_PER_CHECK` sessions, and skips a
 * session already classified from the same inputs — repository, package map,
 * refs and the session's changed paths — so a quiet repository costs its tag
 * listings and nothing more.
 *
 * **Spores and plans follow their session.** Each check gives a spore or plan
 * that has no release state, or that now names another session, its session's
 * state, without a GitHub read; a released row stays.
 */
import type { ServerEnv, OutboundFetch, RelationalStore } from './adapters.js';
import type { SecretStore } from './secrets.js';
import { deploymentSecretStore } from './secrets.js';
import { leafValues } from './settings.js';
import { repositoryIdentity } from './repositories.js';
import { GITHUB_READ_TIMEOUT_MS, githubReads, isGithubRepo, type GithubFailure } from './github-refs.js';
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
/** Stored data that no longer parses as what it records. */
export class StoredValueUnreadable extends Error {
  constructor(readonly field: string) { super(`stored ${field} is unreadable`); }
}
export const STORED_SETTINGS_UNREADABLE = 'stored_settings_unreadable';
export const CHANGED_PATHS_UNREADABLE = 'changed_paths_unreadable';
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
  /** Set when the stored settings cannot be read: the fields above are then not the Project's settings, and no check runs until they are saved again. */
  problem: typeof STORED_SETTINGS_UNREADABLE | null;
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
  checkRunId: string | null;
  checkLeaseUntil: number | null;
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
  check_requested_at AS checkRequestedAt, check_run_id AS checkRunId, check_lease_until AS checkLeaseUntil, check_started_at AS checkStartedAt, check_finished_at AS checkFinishedAt,
  check_status AS checkStatus, check_failure AS checkFailure, check_counts AS checkCounts,
  check_lookups AS checkLookups, last_complete_at AS lastCompleteAt
  FROM project_release_provenance WHERE project_id = ?`;

function parseStored<T>(json: string | null, field: string, admits: (value: unknown) => value is T): T {
  let value: unknown;
  try { value = JSON.parse(json ?? 'null'); } catch { throw new StoredValueUnreadable(field); }
  if (!admits(value)) throw new StoredValueUnreadable(field);
  return value;
}

const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');
const isMappingList = (v: unknown): v is PackageTagMapping[] => Array.isArray(v)
  && v.every((m) => typeof m === 'object' && m !== null && typeof (m as PackageTagMapping).pathGlob === 'string' && typeof (m as PackageTagMapping).tagPattern === 'string');
const isCounts = (v: unknown): v is ReleaseCheckCounts => typeof v === 'object' && v !== null
  && ['checked', 'changed', 'unchanged', 'unknown', 'unavailable', 'deferred'].every((k) => typeof (v as Record<string, unknown>)[k] === 'number');

const DEFAULTS: ReleaseProvenanceSettings = {
  enabled: false, githubRepo: null, productionRefs: [], integrationRefs: [], packageMap: [], includeUnknown: true, maxLookups: DEFAULT_MAX_LOOKUPS,
};

function settingsOf(row: Row): ReleaseProvenanceSettings {
  return {
    enabled: row.enabled === 1,
    githubRepo: row.githubRepo,
    productionRefs: parseStored(row.productionRefs, 'production refs', isStringList),
    integrationRefs: parseStored(row.integrationRefs, 'integration refs', isStringList),
    packageMap: parseStored(row.packageMap, 'package map', isMappingList),
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
    counts: row.checkCounts === null ? null : parseStored(row.checkCounts, 'check counts', isCounts),
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
    let settings = DEFAULTS;
    let check: ReleaseCheck | null = null;
    let problem: ReleaseProvenanceView['problem'] = null;
    if (current !== null) {
      try {
        settings = settingsOf(current);
        check = checkOf(current);
      } catch (error) {
        if (!(error instanceof StoredValueUnreadable)) throw error;
        settings = { ...DEFAULTS, enabled: current.enabled === 1, githubRepo: current.githubRepo, maxLookups: current.maxLookups };
        problem = STORED_SETTINGS_UNREADABLE;
      }
    }
    return {
      ...settings,
      revision: current?.revision ?? null,
      updatedAt: current?.updatedAt ?? null,
      updatedBy: current?.updatedBy ?? null,
      credential: { configured, purpose: RELEASE_CREDENTIAL_PURPOSE },
      suggestedRepo: githubRepoOf(identity?.url),
      check,
      problem,
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
            package_map, include_unknown, max_lookups, secret_slot, updated_at, updated_by, check_requested_at, project_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(...values, now, projectId)
        : db.prepare(`UPDATE project_release_provenance SET revision = ?, enabled = ?, github_repo = ?, production_refs = ?, integration_refs = ?,
            package_map = ?, include_unknown = ?, max_lookups = ?, secret_slot = ?, updated_at = ?, updated_by = ?,
            check_run_id = NULL, check_lease_until = NULL, check_requested_at = ?
            WHERE project_id = ? AND revision = ?`).bind(...values, now, projectId, previous.revision);
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

/** How long a claimed check holds the Project: every read at its timeout, and a margin. */
const leaseMs = (maxLookups: number) => Math.min(maxLookups * GITHUB_READ_TIMEOUT_MS + 60_000, 30 * 60_000);

/** Whether tracked files differed from the commit: `0`, `1`, or `unknown` when git could not say. */
type Cleanliness = '0' | '1' | 'unknown';

interface Candidate { sessionId: string; point: 'session_start' | 'session_end'; headSha: string; cleanliness: Cleanliness; pathsMark: number }

/** A git provenance row's cleanliness as `Cleanliness`; a row that records an observation error is `unknown`. */
const CLEANLINESS_SQL = "CASE WHEN g.error IS NOT NULL THEN 'unknown' ELSE CAST(g.is_dirty AS TEXT) END";
/**
 * How many tool calls the session holds when a package map is in use, so
 * changed paths that arrive later mark its classification stale, and 0
 * without a package map. Binds the map flag.
 */
const PATHS_MARK_SQL = 'CASE WHEN ? = 1 THEN (SELECT COUNT(*) FROM tool_calls t WHERE t.project_id = g.project_id AND t.session_id = g.session_id) ELSE 0 END';

const identityOf = (projectId: string, namespace: string, recordId: string) => `${projectId}:${namespace}:${recordId}`;

/** The captured commit a row is classified from: a new one is classified afresh. */
const sourceOf = (c: Candidate) => `${c.point}:${c.headSha}:${c.cleanliness}`;

/** Failures that stop the whole check: every later read would meet the same answer. */
const STOPS_CHECK = new Set<GithubFailure>(['budget_exhausted', 'credential_rejected', 'rate_limited', 'timeout', 'network', 'not_found', 'unexpected_response']);

/** The paths a session's tool calls touched, or null when a stored list cannot be read. */
async function changedPaths(db: RelationalStore, projectId: string, sessionId: string): Promise<string[] | null> {
  const { results } = await db.prepare(`SELECT files_affected AS files FROM tool_calls
    WHERE project_id = ? AND session_id = ? AND files_affected IS NOT NULL LIMIT 200`).bind(projectId, sessionId).all<{ files: string }>();
  const paths = new Set<string>();
  for (const { files } of results) {
    let list: string[];
    try { list = parseStored(files, 'changed paths', isStringList); } catch { return null; }
    for (const path of list) {
      paths.add(path);
      if (paths.size >= MAX_PATHS_PER_SESSION) return [...paths];
    }
  }
  return [...paths];
}

const uncaptured = (c: Candidate, basisKind: Classification['basisKind'], reason: string): Classification => ({
  state: 'unknown', confidence: 'low', basisKind, basisRef: null, basisSha: c.headSha, releasePrNumber: null, reason, evidence: {},
});

interface Claim { projectId: string; runId: string; revision: string }

/** The claim the fenced writes carry: they land only while this run holds the Project under the revision it read. */
const FENCE = 'EXISTS (SELECT 1 FROM project_release_provenance f WHERE f.project_id = ? AND f.check_run_id = ? AND f.revision = ?)';
const fenceParams = (claim: Claim) => [claim.projectId, claim.runId, claim.revision];

const HELD_SOURCE = "json_extract(knowledge_release_state.evidence_json, '$.source')";
const NEW_SOURCE = "json_extract(excluded.evidence_json, '$.source')";
/**
 * The upsert every release state write ends with. A released row stays for its
 * recorded source, and a row without a recorded source stays released; any
 * change of state keeps the replaced state in `evidence_json.previous`.
 */
const RELEASE_UPSERT = `ON CONFLICT(project_id, identity_key) DO UPDATE SET source_session_id = excluded.source_session_id, state = excluded.state, confidence = excluded.confidence,
    basis_kind = excluded.basis_kind, basis_ref = excluded.basis_ref, basis_sha = excluded.basis_sha,
    release_pr_number = excluded.release_pr_number, reason = excluded.reason,
    evidence_json = CASE WHEN knowledge_release_state.state IS excluded.state AND ${HELD_SOURCE} IS ${NEW_SOURCE}
      THEN json_set(excluded.evidence_json, '$.previous', json(COALESCE(json_extract(knowledge_release_state.evidence_json, '$.previous'), 'null')))
      ELSE json_set(excluded.evidence_json, '$.previous', json_object('state', knowledge_release_state.state, 'source', ${HELD_SOURCE},
        'basis_ref', knowledge_release_state.basis_ref, 'checked_at', knowledge_release_state.checked_at)) END,
    checked_at = excluded.checked_at, updated_at = excluded.checked_at
  WHERE knowledge_release_state.state <> 'released' OR (${HELD_SOURCE} IS NOT NULL AND ${HELD_SOURCE} IS NOT ${NEW_SOURCE})`;

/** The records that carry their session's release state: namespace, table and key column. */
const DERIVED = [['spores', 'spores', 'id'], ['plans', 'plans', 'plan_key']] as const;

/**
 * Write one session's classification and carry it to the spores and plans the
 * session produced, inside the claim. Answers whether the session's state
 * changed, or null when the claim is gone.
 */
async function writeClassification(
  db: RelationalStore, claim: Claim, c: Candidate, classification: Classification, fingerprint: string | null, now: number,
): Promise<boolean | null> {
  const { projectId } = claim;
  const identity = identityOf(projectId, 'sessions', c.sessionId);
  const previous = await db.prepare('SELECT state FROM knowledge_release_state WHERE project_id = ? AND identity_key = ?')
    .bind(projectId, identity).first<{ state: string }>();
  const k = classification;
  const evidence = JSON.stringify({ ...k.evidence, source: sourceOf(c), refs_fingerprint: fingerprint, paths_mark: c.pathsMark });
  const columns = [k.state, k.confidence, k.basisKind, k.basisRef, k.basisSha, k.releasePrNumber, k.reason, evidence, now];
  const derived = (namespace: string, table: string, key: string) => db.prepare(`INSERT INTO knowledge_release_state
      (project_id, id, identity_key, namespace, record_id, source_session_id, state, confidence, basis_kind, basis_ref,
       basis_sha, release_pr_number, reason, evidence_json, checked_at, created_at)
    SELECT project_id, 'rs_' || lower(hex(randomblob(16))), project_id || ':${namespace}:' || ${key}, '${namespace}', ${key}, session_id,
       ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      FROM ${table} WHERE project_id = ? AND session_id = ? AND ${FENCE} ${RELEASE_UPSERT}`).bind(...columns, now, projectId, c.sessionId, ...fenceParams(claim));
  await db.batch([
    db.prepare(`INSERT INTO knowledge_release_state (project_id, id, identity_key, namespace, record_id, source_session_id,
        state, confidence, basis_kind, basis_ref, basis_sha, release_pr_number, reason, evidence_json, checked_at, created_at)
      SELECT ?, ?, ?, 'sessions', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${FENCE} ${RELEASE_UPSERT}`)
      .bind(projectId, `rs_${crypto.randomUUID().replaceAll('-', '')}`, identity, c.sessionId, c.sessionId, ...columns, now, ...fenceParams(claim)),
    ...DERIVED.map(([namespace, table, key]) => derived(namespace, table, key)),
  ]);
  // The row is read back rather than counted: a store may report no changes for an INSERT ... SELECT.
  const written = await db.prepare(`SELECT 1 AS written FROM knowledge_release_state WHERE project_id = ? AND identity_key = ?
    AND checked_at = ? AND json_extract(evidence_json, '$.source') = ?`).bind(projectId, identity, now, sourceOf(c)).first();
  if (written === null) return (await holds(db, claim)) ? false : null;
  return previous?.state !== k.state;
}

/**
 * Give each spore and plan its session's current release state when it has
 * none, or when it now names another session, inside the claim. Reads no
 * GitHub; a released row is kept. At most `SESSIONS_PER_CHECK` records per
 * namespace, so a backlog completes over later checks.
 */
async function propagateDerived(db: RelationalStore, claim: Claim, now: number): Promise<void> {
  const { projectId } = claim;
  const sessionPrefix = identityOf(projectId, 'sessions', '');
  await db.batch(DERIVED.map(([namespace, table, key]) => db.prepare(`INSERT INTO knowledge_release_state
      (project_id, id, identity_key, namespace, record_id, source_session_id, state, confidence, basis_kind, basis_ref,
       basis_sha, release_pr_number, reason, evidence_json, checked_at, created_at)
    SELECT r.project_id, 'rs_' || lower(hex(randomblob(16))), r.project_id || ':${namespace}:' || r.${key}, '${namespace}', r.${key}, r.session_id,
       k.state, k.confidence, k.basis_kind, k.basis_ref, k.basis_sha, k.release_pr_number, k.reason,
       json_remove(k.evidence_json, '$.previous'), k.checked_at, ?
      FROM ${table} r JOIN knowledge_release_state k ON k.project_id = r.project_id AND k.identity_key = ? || r.session_id
      WHERE r.project_id = ? AND ${FENCE} AND NOT EXISTS (SELECT 1 FROM knowledge_release_state d
        WHERE d.project_id = r.project_id AND d.identity_key = r.project_id || ':${namespace}:' || r.${key}
          AND (d.source_session_id IS r.session_id OR d.state = 'released'))
      LIMIT ? ${RELEASE_UPSERT}`).bind(now, sessionPrefix, projectId, ...fenceParams(claim), SESSIONS_PER_CHECK)));
}

const holds = async (db: RelationalStore, claim: Claim) => (await db.prepare(`SELECT 1 AS held FROM project_release_provenance
  WHERE project_id = ? AND check_run_id = ? AND revision = ?`).bind(...fenceParams(claim)).first()) !== null;

/**
 * Check one Project. Answers how many release states changed.
 *
 * The claim admits one check at a time: a running check's lease excludes
 * every other until it finishes or the lease lapses.
 */
export async function checkProject(
  db: RelationalStore, secrets: SecretStore, outbound: OutboundFetch, projectId: string, now: number,
): Promise<number> {
  const current = await db.prepare(SELECT_ROW).bind(projectId).first<Row>();
  if (current === null || current.enabled !== 1 || current.githubRepo === null) return 0;
  const claim: Claim = { projectId, runId: crypto.randomUUID(), revision: current.revision };
  const claimed = await db.prepare(`UPDATE project_release_provenance SET check_run_id = ?, check_lease_until = ?, check_started_at = ?
    WHERE project_id = ? AND revision = ? AND enabled = 1 AND github_repo IS NOT NULL AND (check_run_id IS NULL OR check_lease_until <= ?)`)
    .bind(claim.runId, now + leaseMs(current.maxLookups), now, projectId, claim.revision, now).run();
  if (claimed.meta.changes !== 1) return 0;

  const counts: ReleaseCheckCounts = { checked: 0, changed: 0, unchanged: 0, unknown: 0, unavailable: 0, deferred: 0 };
  let failure: string | null = null;
  let fingerprint: string | null = null;
  let lookups = 0;
  let settings: ReleaseProvenanceSettings | null = null;
  let superseded = false;
  try { settings = settingsOf(current); } catch (error) {
    if (!(error instanceof StoredValueUnreadable)) throw error;
    failure = STORED_SETTINGS_UNREADABLE;
  }

  if (settings !== null) {
    const token = current.secretSlot === null ? null : await secrets.get(current.secretSlot);
    const reads = githubReads({ repo: current.githubRepo, token, maxLookups: settings.maxLookups, fetcher: outbound });
    const outcome = await classifyProject(db, reads, claim, settings, counts, token !== null, now);
    lookups = reads.lookupsUsed();
    if (outcome === null) superseded = true;
    else ({ failure, fingerprint } = outcome);
    // What the check ran with, not the setting read later: a token lifts GitHub's per-address limit.
    if (!token && failure === 'rate_limited') failure += '_without_credential';
  }

  const status: ReleaseCheckStatus = failure === null
    ? (counts.deferred > 0 ? 'partial' : 'complete')
    : (counts.checked > 0 ? 'partial' : 'unavailable');
  const recorded = superseded ? null : await db.prepare(`UPDATE project_release_provenance SET check_finished_at = ?, check_status = ?, check_failure = ?,
      check_counts = ?, check_lookups = ?, check_fingerprint = ?, check_run_id = NULL, check_lease_until = NULL,
      last_complete_at = CASE WHEN ? = 'complete' THEN ? ELSE last_complete_at END
    WHERE project_id = ? AND check_run_id = ? AND revision = ?`)
    .bind(now, status, failure, JSON.stringify(counts), lookups, fingerprint, status, now, ...fenceParams(claim)).run();
  const published = recorded !== null && recorded.meta.changes === 1;
  emit({ kind: 'release_provenance_check', status: published ? status : 'superseded', failure: failure ?? 'none', lookups, ...counts });
  return published ? counts.changed : 0;
}

/**
 * Classify the Project's pending sessions inside the claim. Answers the
 * failure that stopped it and the refs fingerprint, or null when the claim was
 * lost and nothing more may be published.
 */
async function classifyProject(
  db: RelationalStore, reads: ReturnType<typeof githubReads>, claim: Claim, settings: ReleaseProvenanceSettings,
  counts: ReleaseCheckCounts, hasToken: boolean, now: number,
): Promise<{ failure: string | null; fingerprint: string | null } | null> {
  const { projectId } = claim;
  await propagateDerived(db, claim, now);
  const repository = await reads.repository();
  if (!repository.ok) {
    const notFound = hasToken ? 'repository_not_found' : 'repository_not_found_without_credential';
    return { failure: repository.failure === 'not_found' ? notFound : repository.failure, fingerprint: null };
  }
  const run = await resolveRunRefs(reads, settings);
  const fingerprint = run.fingerprint === null ? null : `repo=${settings.githubRepo}\n${run.fingerprint}`;
  const mapped = settings.packageMap.length > 0 ? 1 : 0;
  // The session's latest captured commit: its end, or its start while no end is captured.
  const { results: candidates } = await db.prepare(`SELECT g.session_id AS sessionId, g.capture_point AS point, g.head_sha AS headSha,
      ${CLEANLINESS_SQL} AS cleanliness, ${PATHS_MARK_SQL} AS pathsMark, g.captured_at AS capturedAt
    FROM knowledge_git_provenance g
    WHERE g.project_id = ? AND g.session_id IS NOT NULL AND g.head_sha IS NOT NULL
      AND (g.capture_point = 'session_end' OR (g.capture_point = 'session_start' AND NOT EXISTS (
        SELECT 1 FROM knowledge_git_provenance e WHERE e.project_id = g.project_id AND e.identity_key = 'session:' || g.session_id || ':session_end')))
      AND NOT EXISTS (SELECT 1 FROM knowledge_release_state k
        WHERE k.project_id = g.project_id AND k.identity_key = ? || g.session_id
          AND ((k.state = 'released' AND json_extract(k.evidence_json, '$.source') IS NULL)
            OR (json_extract(k.evidence_json, '$.source') = g.capture_point || ':' || g.head_sha || ':' || ${CLEANLINESS_SQL}
              AND (k.state = 'released' OR (? IS NOT NULL AND json_extract(k.evidence_json, '$.refs_fingerprint') = ?
                AND json_extract(k.evidence_json, '$.paths_mark') IS ${PATHS_MARK_SQL})))))
    ORDER BY capturedAt DESC, sessionId LIMIT ?`)
    .bind(mapped, projectId, identityOf(projectId, 'sessions', ''), fingerprint, fingerprint, mapped, SESSIONS_PER_CHECK + 1)
    .all<Candidate & { capturedAt: number }>();
  if (candidates.length > SESSIONS_PER_CHECK) counts.deferred += candidates.length - SESSIONS_PER_CHECK;
  const compare = memoizedCompare(reads);
  const batch = candidates.slice(0, SESSIONS_PER_CHECK);
  let failure: string | null = null;
  for (let i = 0; i < batch.length; i += 1) {
    const candidate = batch[i];
    let classification: Classification;
    if (candidate.point === 'session_start') {
      classification = uncaptured(candidate, 'missing_git_evidence', 'Only the commit the session started on is captured; its own work is not');
    } else if (candidate.cleanliness === '1') {
      classification = uncaptured(candidate, 'dirty_worktree', 'The session ended with uncommitted changes to tracked files');
    } else if (candidate.cleanliness === 'unknown') {
      classification = uncaptured(candidate, 'missing_git_evidence', 'Whether the session ended with uncommitted changes could not be read');
    } else {
      const paths = settings.packageMap.length === 0 ? [] : await changedPaths(db, projectId, candidate.sessionId);
      if (paths === null) {
        classification = uncaptured(candidate, 'missing_git_evidence', 'The paths the session changed could not be read, so its package is not established');
        failure ??= CHANGED_PATHS_UNREADABLE;
      } else {
        const outcome = await classifyCommit(reads, compare, run, { headSha: candidate.headSha, changedPaths: paths });
        if (outcome.kind === 'unavailable') {
          counts.unavailable += 1;
          failure = outcome.failure;
          if (STOPS_CHECK.has(outcome.failure)) { counts.deferred += batch.length - i - 1; break; }
          continue;
        }
        classification = outcome.classification;
      }
    }
    counts.checked += 1;
    if (classification.state === 'unknown') {
      counts.unknown += 1;
      if (!settings.includeUnknown) continue;
    }
    const changed = await writeClassification(db, claim, candidate, classification, fingerprint, now);
    if (changed === null) return null;
    if (changed) counts.changed += 1;
    else counts.unchanged += 1;
  }
  return { failure, fingerprint };
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
 * owner asked for a check after the last one started, oldest first; a Project
 * whose check still holds its lease waits.
 */
export async function reconcileReleaseProvenance(env: ServerEnv, now: number): Promise<number> {
  const interval = await intervalMs(env.db);
  const { results } = await env.db.prepare(`SELECT project_id AS projectId FROM project_release_provenance
    WHERE enabled = 1 AND github_repo IS NOT NULL AND (check_run_id IS NULL OR check_lease_until <= ?)
      AND (check_started_at IS NULL OR check_started_at <= ? OR check_requested_at > check_started_at)
    ORDER BY COALESCE(check_started_at, 0), project_id LIMIT ?`).bind(now, now - interval, PROJECTS_PER_PASS).all<{ projectId: string }>();
  if (results.length === 0) return 0;
  const secrets = deploymentSecretStore(env.db, env.wrappingKey);
  let changed = 0;
  for (const { projectId } of results) changed += await checkProject(env.db, secrets, env.outbound, projectId, now);
  return changed;
}
