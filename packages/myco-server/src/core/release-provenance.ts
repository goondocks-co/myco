import { saveReleaseSettings } from '../db/settings/release-connection.js';
import { commitClassification, settleUnrecorded, type ClassificationOutcome } from '../db/release/classification.js';
import { readReleaseConfig, requestReleaseCheck, unresolvedReleaseStates, type ReleaseConfigRow } from '../db/release/config.js';
import { claimReleaseCheck, dueReleaseChecks, openReleaseGeneration, releaseDueAfterSave, settleReleaseCheck, type ReleaseClaim } from '../db/release/due.js';
import { openReleaseWork, sessionPaths, type ReleaseWork } from '../db/release/work.js';
import { drainReleasePropagation } from '../db/release/propagation.js';
import { RELEASE_PROJECTION } from '../db/release/schema.js';
import { SESSION_PATHS_LIMIT } from '../db/document-tables.js';
import { projectionReadiness } from '../db/projections/catchup.js';
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
 * the Project's due row with a lease under the revision it read. Every state it
 * writes and its outcome land only while that claim stands; a settings save
 * clears the claim, so a check still waiting on GitHub for the previous
 * repository publishes nothing, and a lease that lapses leaves the row due.
 *
 * **Bounded, and only ever forward.** One check makes at most the Project's
 * configured number of GitHub reads and classifies at most `SESSIONS_PER_CHECK`
 * sessions, read from the Project's open work rows rather than from history. A
 * capture, a changed path or a settings save moves a work row; a classification
 * settles only the capture it read, so a stale result cannot replace a newer one.
 * A repository that cannot be read leaves every state and work row as it was.
 *
 * **Spores and plans follow their session** through a keyed queue drained in
 * bounded pages, without a GitHub read; a released row stays. While a record's
 * session state is still being carried, a read says so.
 */
import type { ServerEnv, OutboundFetch, RelationalStore } from './adapters.js';
import type { SecretStore } from './secrets.js';
import { deploymentSecretStore } from './secrets.js';
import { settingTexts } from './settings.js';
import { repositoryIdentity } from './repositories.js';
import { GITHUB_READ_TIMEOUT_MS, githubReads, isGithubRepo } from './github-refs.js';
import {
  classifyCommit, memoizedCompare, resolveRunRefs, type Classification, type PackageTagMapping,
} from './release-classify.js';
import { emit } from '../telemetry.js';
import { sourceOf } from './provenance.js';
const RECONCILE_INTERVAL_LEAF = 'release_provenance.reconcile_interval_minutes';
const DEFAULT_RECONCILE_INTERVAL_MINUTES = 15;
const DEFAULT_MAX_LOOKUPS = 50;
const MAX_LOOKUPS_CEILING = 1_000;
const SESSIONS_PER_CHECK = 200;
/** How many Projects one pass checks; the rest are due on the next tick. */
export const PROJECTS_PER_PASS = 3;
const MAX_REFS = 20;
const MAX_REF_CHARS = 200;
const MAX_PACKAGE_MAPPINGS = 50;
/** The report a surface states exactly up to; past it, "at least". */
const UNRESOLVED_REPORT_CAP = 1000;
const MAX_CREDENTIAL_CHARS = 4096;
const REF_GRAMMAR = /^[A-Za-z0-9._/*?-]+$/;

/** What the credential is for, in the words a settings surface shows. */
export const RELEASE_CREDENTIAL_PURPOSE = 'Reads release tags and pull requests for this Project. It is not used for code tasks.';

export class ReleaseProvenanceInputError extends Error {}
/** Stored data that no longer parses as what it records. */
class StoredValueUnreadable extends Error {
  constructor(readonly field: string) { super(`stored ${field} is unreadable`); }
}
const STORED_SETTINGS_UNREADABLE = 'stored_settings_unreadable';
const CHANGED_PATHS_UNREADABLE = 'changed_paths_unreadable';
export class ReleaseProvenanceConflictError extends Error {
  constructor() { super('The release provenance settings changed. Refresh before saving again.'); }
}

interface ReleaseProvenanceSettings {
  enabled: boolean;
  githubRepo: string | null;
  productionRefs: string[];
  integrationRefs: string[];
  packageMap: PackageTagMapping[];
  includeUnknown: boolean;
  maxLookups: number;
}

interface ReleaseCheckCounts {
  checked: number;
  changed: number;
  unchanged: number;
  unknown: number;
  unavailable: number;
  deferred: number;
}

type ReleaseCheckStatus = 'complete' | 'partial' | 'unavailable';

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
  /** True while release history is still being prepared after an upgrade: no check runs yet, and an absent state means not yet looked at, never not released. */
  building: boolean;
  /** Stored release rows that could not be placed under one current row per record, up to the report cap: left as they were, or preserved in the report, never guessed at. */
  unresolvedStates: number;
}

export interface ReleaseProvenanceWrite extends ReleaseProvenanceSettings {
  revision: string | null;
  /** Omitted keeps the stored credential while the repository is unchanged; null removes it. */
  credential?: { token: string } | null;
}

type Row = ReleaseConfigRow;

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
function githubRepoOf(url: string | null | undefined): string | null {
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
function validateSettings(input: Record<string, unknown>): ReleaseProvenanceSettings {
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
  const row = (projectId: string) => readReleaseConfig(db, projectId);

  const describe = async (projectId: string): Promise<ReleaseProvenanceView> => {
    const [current, identity, readiness, unresolvedStates] = await Promise.all([
      row(projectId), repositoryIdentity(db, { projectId }), projectionReadiness(db, RELEASE_PROJECTION), unresolvedReleaseStates(db, projectId, UNRESOLVED_REPORT_CAP),
    ]);
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
      building: readiness === 'building',
      unresolvedStates,
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
      const sealed = credential == null ? null : await secrets.preparePut(secretSlot!, credential.token, actor, now);
      const values = [
        revision, settings.enabled ? 1 : 0, settings.githubRepo, JSON.stringify(settings.productionRefs),
        JSON.stringify(settings.integrationRefs), JSON.stringify(settings.packageMap), settings.includeUnknown ? 1 : 0,
        settings.maxLookups, secretSlot, now, actor,
      ];
      const due = releaseDueAfterSave({ projectId, revision, tracked: settings.enabled && settings.githubRepo !== null });
      if (!await saveReleaseSettings(db, { project: projectId, previous, values, slot: secretSlot, sealed, now, actor, due })) throw new ReleaseProvenanceConflictError();
      return describe(projectId);
    },
    /** Asks the next tick to check this Project now; answers false when tracking is off. */
    async requestCheck(projectId: string, now: number): Promise<boolean> {
      return requestReleaseCheck(db, projectId, now);
    },
  };
}

// --- The scheduled check ---

/** How long a claimed check holds the Project: every read at its timeout, and a margin. */
const leaseMs = (maxLookups: number) => Math.min(maxLookups * GITHUB_READ_TIMEOUT_MS + 60_000, 30 * 60_000);

/** The paths a session changed: `unreadable` while its document still converts or a stored list cannot be parsed, and `too_many` once the stored catalogue is full, where a partial list can prove no package absent. */
type SessionChangedPaths = { paths: string[]; mark: number } | 'unreadable' | 'too_many';

async function changedPaths(db: RelationalStore, projectId: string, sessionId: string): Promise<SessionChangedPaths> {
  const row = await sessionPaths(db, projectId, sessionId, SESSION_PATHS_LIMIT);
  if (row === null) return { paths: [], mark: 0 };
  let list: string[];
  try { list = parseStored(row.files, 'changed paths', isStringList); } catch { return 'unreadable'; }
  if (list.length >= SESSION_PATHS_LIMIT) return 'too_many';
  return { paths: list, mark: row.toolCalls };
}

const uncaptured = (w: ReleaseWork, basisKind: Classification['basisKind'], reason: string): Classification => ({
  state: 'unknown', confidence: 'low', basisKind, basisRef: null, basisSha: w.headSha, releasePrNumber: null, reason, evidence: {},
});

/**
 * Write one session's classification inside the claim, only for the capture read.
 */
function writeClassification(db: RelationalStore, claim: ReleaseClaim, work: ReleaseWork, classification: Classification,
  run: { fingerprint: string | null; generation: number; pathsMark: number | null; now: number }): Promise<ClassificationOutcome> {
  const k = classification;
  const source = sourceOf(work);
  return commitClassification(db, claim, {
    sessionId: work.sessionId, sourceRevision: work.sourceRevision, generation: run.generation,
    state: k.state, confidence: k.confidence, basisKind: k.basisKind, basisRef: k.basisRef, basisSha: k.basisSha, releasePrNumber: k.releasePrNumber, reason: k.reason,
    evidence: JSON.stringify({ ...k.evidence, source, refs_fingerprint: run.fingerprint, paths_mark: run.pathsMark }),
    source, configRevision: claim.revision, fingerprint: run.fingerprint, pathsMark: run.pathsMark, now: run.now,
  });
}

/**
 * Check one Project. Answers how many release states changed.
 *
 * The claim admits one check at a time: a running check's lease excludes
 * every other until it finishes or the lease lapses.
 */
export async function checkProject(
  db: RelationalStore, secrets: SecretStore, outbound: OutboundFetch, projectId: string, now: number,
): Promise<number> {
  const current = await readReleaseConfig(db, projectId);
  if (current === null || current.enabled !== 1 || current.githubRepo === null) return 0;
  const claim: ReleaseClaim = { projectId, leaseId: crypto.randomUUID(), revision: current.revision };
  const intervalMs = (await reconcileIntervalMinutes(db)) * 60_000;
  const opened = await claimReleaseCheck(db, claim, { until: now + leaseMs(current.maxLookups), now, intervalMs });
  if (opened === null) return 0;

  const counts: ReleaseCheckCounts = { checked: 0, changed: 0, unchanged: 0, unknown: 0, unavailable: 0, deferred: 0 };
  let failure: string | null = null;
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
    const outcome = await classifyProject(db, reads, { claim, settings, counts, hasToken: token !== null, now });
    lookups = reads.lookupsUsed();
    if (outcome === null) superseded = true;
    else failure = outcome.failure;
    // What the check ran with, not the setting read later: a limit or refusal met without a token says so.
    if (!token && (failure === 'rate_limited' || failure === 'forbidden')) failure += '_without_credential';
  }

  const status: ReleaseCheckStatus = failure === null
    ? (counts.deferred > 0 ? 'partial' : 'complete')
    : (counts.checked > 0 ? 'partial' : 'unavailable');
  const published = !superseded && await settleReleaseCheck(db, claim, { now, status, failure, counts: JSON.stringify(counts), lookups });
  emit({ kind: 'release_provenance_check', status: published ? status : 'superseded', failure: failure ?? 'none', lookups, ...counts });
  return published ? counts.changed : 0;
}

/**
 * Classify the Project's open sessions inside the claim. Answers the failure
 * that stopped it, or null when the claim is gone and nothing more may be
 * published. A repository that cannot be read returns before any work row is
 * touched, so it marks nothing.
 */
async function classifyProject(
  db: RelationalStore, reads: ReturnType<typeof githubReads>,
  { claim, settings, counts, hasToken, now }: { claim: ReleaseClaim; settings: ReleaseProvenanceSettings; counts: ReleaseCheckCounts; hasToken: boolean; now: number },
): Promise<{ failure: string | null } | null> {
  const { projectId } = claim;
  const repository = await reads.repository();
  if (!repository.ok) {
    const notFound = hasToken ? 'repository_not_found' : 'repository_not_found_without_credential';
    return { failure: repository.failure === 'not_found' ? notFound : repository.failure };
  }
  const run = await resolveRunRefs(reads, settings);
  const fingerprint = run.fingerprint === null ? null : `repo=${settings.githubRepo}\n${run.fingerprint}`;
  const generation = await openReleaseGeneration(db, claim, fingerprint);
  if (generation === null) return null;
  const candidates = await openReleaseWork(db, projectId, generation, SESSIONS_PER_CHECK + 1);
  if (candidates.length > SESSIONS_PER_CHECK) counts.deferred += candidates.length - SESSIONS_PER_CHECK;
  const compare = memoizedCompare(reads);
  const batch = candidates.slice(0, SESSIONS_PER_CHECK);
  let failure: string | null = null;
  for (let i = 0; i < batch.length; i += 1) {
    const work = batch[i]!;
    const source = sourceOf(work);
    let classification: Classification;
    let pathsMark: number | null = null;
    if (work.point === 'session_start') {
      classification = uncaptured(work, 'missing_git_evidence', 'Only the commit the session started on is captured; its own work is not');
    } else if (work.cleanliness === '1') {
      classification = uncaptured(work, 'dirty_worktree', 'The session ended with uncommitted changes to tracked files');
    } else if (work.cleanliness === 'unknown') {
      classification = uncaptured(work, 'missing_git_evidence', 'Whether the session ended with uncommitted changes could not be read');
    } else {
      const changed = settings.packageMap.length === 0 ? { paths: [], mark: null } : await changedPaths(db, projectId, work.sessionId);
      if (changed === 'unreadable') {
        classification = uncaptured(work, 'missing_git_evidence', 'The paths the session changed could not be read, so its package is not established');
        failure ??= CHANGED_PATHS_UNREADABLE;
      } else if (changed === 'too_many') {
        classification = uncaptured(work, 'missing_git_evidence', `The session touched at least ${SESSION_PATHS_LIMIT} paths, so its package is not established`);
      } else {
        pathsMark = changed.mark;
        const outcome = await classifyCommit(reads, compare, run, { headSha: work.headSha, changedPaths: changed.paths });
        if (outcome.kind === 'unavailable') {
          counts.unavailable += 1;
          failure = outcome.failure;
          // Every failure but a truncated listing stops the whole check: every later read would meet the same answer.
          if (outcome.failure !== 'truncated') { counts.deferred += batch.length - i - 1; break; }
          continue;
        }
        classification = outcome.classification;
      }
    }
    counts.checked += 1;
    if (classification.state === 'unknown') {
      counts.unknown += 1;
      if (!settings.includeUnknown) {
        if (!await settleUnrecorded(db, claim, { sessionId: work.sessionId, sourceRevision: work.sourceRevision, generation, source })) return null;
        continue;
      }
    }
    const written = await writeClassification(db, claim, work, classification, { fingerprint, generation, pathsMark, now });
    if (written === 'claim_lost') return null;
    if (written === 'source_moved') counts.deferred += 1;
    else if (written === 'changed') counts.changed += 1;
    else counts.unchanged += 1;
  }
  return { failure };
}

/** The interval the Deployment's leaf names, in minutes, or the default where it names none. */
export async function reconcileIntervalMinutes(db: RelationalStore): Promise<number> {
  const raw = (await settingTexts(db, [RECONCILE_INTERVAL_LEAF])).get(RECONCILE_INTERVAL_LEAF);
  return raw === undefined ? DEFAULT_RECONCILE_INTERVAL_MINUTES : JSON.parse(raw) as number;
}

/**
 * The job: wait while release history is still being prepared, check the Projects whose due row has come round,
 * soonest first, then carry session states to their records in one bounded pass. Answers how many release states
 * changed, and asks for a sooner pass while records still wait to be carried.
 */
export async function reconcileReleaseProvenance(env: ServerEnv, now: number): Promise<{ changed: number; more: boolean }> {
  if (await projectionReadiness(env.db, RELEASE_PROJECTION) === 'building') return { changed: 0, more: false };
  const intervalMs = (await reconcileIntervalMinutes(env.db)) * 60_000;
  const due = await dueReleaseChecks(env.db, { countedBefore: now - intervalMs, now, limit: PROJECTS_PER_PASS });
  const secrets = deploymentSecretStore(env.db, env.wrappingKey);
  let changed = 0;
  for (const projectId of due) changed += await checkProject(env.db, secrets, env.outbound, projectId, now);
  const carried = await drainReleasePropagation(env.db, now);
  return { changed, more: carried.more };
}
