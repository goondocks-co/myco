/**
 * Machine-global host/attach registry — the member side of Team Host.
 *
 * One record per host this machine has joined, holding the overlay address
 * and the set of local projects attached to that host. Modeled directly on
 * `team/registry.ts`: same on-disk shape (one JSON file per record under a
 * machine-global home, atomic temp+rename writes), same secrets-file bearer
 * storage, same reverse-lookup-by-project pattern.
 *
 * Lives under the same machine-global team home (`~/.myco-team`, see
 * `grove/paths.ts` `resolveTeamsHome`) as a sibling `hosts/` directory to
 * `teams/` — both are "who is this machine connected to" registries.
 *
 * This is a pure-disk-read module: no daemon, no DB. `resolveAttach` in
 * particular must stay this way — it is called from the client process
 * (`ensureProjectRegistered`) before any request round-trip, and from the
 * daemon's per-request routing chokepoint, so it cannot depend on either.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { loadMachineConfig } from '@myco/config/loader.js';

import { HOST_BEARER_SECRET } from '@myco/constants.js';
import { isValidHostUrl } from './host-url.js';
import {
  assertValidSecretEntry,
  readSecretsFile as readExactSecretsFile,
  readSecrets as readSecretsFile,
  tightenSecretsPermissions,
  writeSecret as writeSecretFile,
} from '@myco/config/secrets.js';
import {
  resolveHostsDir,
  resolveHostDir,
  resolveHostConfigPath,
  resolveMycoHome,
  resolveTeamsHome,
} from '@myco/grove/paths.js';
import { findRegisteredProjectById } from '@myco/grove/registry-resolve.js';
import {
  atomicWriteFileSync,
  durableRemovePathSync,
  reconcileDurableRemovalTombstonesSync,
  syncDirectoryForDurability,
} from '@myco/utils/atomic-write.js';
import { withFileLockSync } from '@myco/utils/lifecycle-lock.js';
import { physicalPathLockIdentities } from '@myco/utils/physical-path-identity.js';
import {
  nativePerUserLockNamespace,
  type PerUserLockNamespace,
} from '@myco/utils/per-user-lock-namespace.js';
import {
  assertHostOperationLease,
  type HostOperationLease,
} from './operation-lock.js';

const HOST_REGISTRY_LOCK_DIR_MODE = 0o700;
const HOST_REGISTRY_LOCK_RETRIES = 8;
const HOST_REGISTRY_LOCK_NAMESPACE = 'hosts-registry';
const HOST_ENROLLMENT_CLAIM_FILENAME = 'enrollment-claim.json';
const HOST_ENROLLMENT_INTENT_FILENAME = 'enrollment-intent.json';
const HOST_BEARERS_DIRNAME = 'bearers';
const HOST_GENERATIONS_DIRNAME = 'host-generations';
const HOST_ENROLLMENT_CLAIM_MODE = 0o600;
const HOST_PRIVATE_DIR_MODE = 0o700;
const HOST_ENROLLMENT_STATE_MODE = 0o600;
const HOST_ENROLLMENT_SCHEMA_VERSION = 1;

export interface AttachRef {
  grove_id: string;
  project_id: string;
  /**
   * Member-local checkout root for this project — machine-local data recorded
   * in the machine-global registry, mirroring `RegisteredProject.root`. Set at
   * attach time so member-side config resolution (`handleAttachedConfigRequest`)
   * can find the vault dir when a request omits `x-myco-project-root` (the
   * browser Settings UI sends only grove/project ids), since an attached project
   * has no local Grove registry row to resolve the path from. Optional: records
   * created before this field simply lack it.
   */
  root?: string;
  /**
   * The member's own LOCAL Grove chosen, at attach time, as this project's
   * display home (E-4 local-view requirement, decision-ef693c71) — an
   * EXPLICIT member choice, never inferred from request context: the attach
   * handler never reads request context, and an attached project never had a
   * local Grove registry row to infer one from (the never-materialize
   * invariant forbids minting one just to answer this). Resolved at attach
   * time by `attachCommand` (`host/attach-command.ts`), which validates an
   * explicit value or defaults to the machine's current default Grove via a
   * pure read.
   *
   * DISPLAY-ONLY: never consulted for capability config, capture routing, or
   * any other tenancy decision — those stay keyed on `grove_id` (the host's
   * served Grove). Optional: absent on refs recorded before this field
   * existed, or possibly dangling if the chosen Grove is later deleted;
   * `resolveAttachRefHomeGroveId` (`grove/registry.ts`) is the read-time
   * fallback for both cases.
   */
  local_grove_id?: string;
}

export interface HostRecord {
  host_id: string;
  label: string;
  /**
   * The host's public HTTPS origin — its Tailscale Funnel URL, e.g.
   * `https://box.tailnet.ts.net:8443`. The ONE dial input: there is no overlay
   * to resolve an address against and no second route to the host, so a record
   * whose URL has gone stale is not degraded, it is unusable, and every surface
   * that renders a host says "re-join required" rather than "unknown".
   *
   * Optional in the TYPE only so a record written before this field existed
   * still parses into something the UI can explain; nothing writes it absent.
   * Validated by {@link isValidHostUrl} at every write.
   */
  host_url?: string;
  protocol_version: number;
  /**
   * The host's self-reported served Grove (enrollment protocol v2,
   * server-mode design spec §2), learned at join time
   * (`host/member-overlay.ts` `joinHost` step 7) and consulted by
   * `attachCommand` as the ONE source of the Grove a new attach ref uses —
   * the member never types a grove id. Absent when the host predates
   * served-grove designation (its enrollment response carried no
   * `served_grove_id` field at all) or when a join has not yet happened
   * over the current protocol.
   */
  served_grove_id?: string | null;
  created_at: string;
  projects: AttachRef[];
  /** Atomic membership commit pointer. Both generation fields are present together. */
  enrollment_generation?: number;
  /** Generation of the bearer file this record must be paired with. */
  bearer_generation?: number;
}

export type EnrollmentHostRecord = Omit<HostRecord, 'projects'>;

/**
 * One membership-commit attempt: the generation a join will commit under, and
 * the tokens proving this attempt is the one that reserved it.
 *
 * This used to also carry a loopback CONNECT-proxy port, because a member ran a
 * tailscaled per host and each needed a distinct local port. It reserves only a
 * GENERATION now — the atomic-commit half of the same mechanism, which the
 * bearer files are keyed by and which is what makes a re-join replace a
 * membership rather than half-overwrite one.
 */
export interface HostEnrollmentReservation {
  hostId: string;
  claimId: string;
  generation: number;
  baseGeneration: number | null;
  enrollmentNonce: string;
  phase: HostEnrollmentPhase;
  /** True when reservation recovery found this generation already committed. */
  recoveredCommit: boolean;
}

interface HostEnrollmentClaim {
  host_id: string;
  claim_id: string;
  generation: number;
  base_generation: number | null;
  enrollment_nonce: string;
}

/**
 * Where a join attempt got to, so a crash mid-enrollment resumes or tears down
 * deterministically rather than leaving a half-membership.
 *
 * The overlay-era phases (`service_preparing`, `service_ready`,
 * `overlay_joining`, `overlay_joined`) tracked provisioning and starting this
 * host's own userspace tailscaled and bringing its node onto the tailnet. A
 * member runs no process for a host now, so those states have nothing to
 * describe: what remains is reserving a generation, being mid-enrollment, and
 * holding a credential not yet committed.
 */
export type HostEnrollmentPhase =
  | 'reserved'
  | 'enrolling'
  | 'credential_staged'
  | 'teardown_pending';

interface HostGenerationLedger {
  schema_version: 1;
  host_id: string;
  last_allocated_generation: number;
  retired_through_generation: number;
}

interface HostEnrollmentIntent {
  schema_version: 1;
  host_id: string;
  generation: number;
  /** null=new membership, 0=legacy committed membership, positive=generation base. */
  base_generation: number | null;
  enrollment_nonce: string;
  claim_id: string;
  phase: HostEnrollmentPhase;
  created_at: string;
  updated_at: string;
}

export interface HostMembershipSnapshot {
  record: HostRecord;
  bearer: string;
  secrets: Record<string, string>;
}

export class HostJoinStateCorruptError extends Error {
  readonly code = 'host_join_state_corrupt';

  constructor(readonly hostId: string, detail: string) {
    super(`host_join_state_corrupt: host ${hostId}: ${detail}`);
    this.name = 'HostJoinStateCorruptError';
  }
}

export interface EnrollmentMembershipResult {
  record: HostRecord;
  created: boolean;
}

function hostRegistryLockPath(
  identity: string,
  lockNamespace: PerUserLockNamespace,
): string {
  const key = createHash('sha256')
    .update(`${HOST_REGISTRY_LOCK_NAMESPACE}\0${identity}`)
    .digest('hex');
  return path.join(lockNamespace.resolve('host-membership'), `${key}.lock`);
}

function hostRegistryLockPaths(lockNamespace: PerUserLockNamespace): string[] {
  const lockDir = lockNamespace.resolve('host-membership');
  fs.mkdirSync(lockDir, { recursive: true, mode: HOST_REGISTRY_LOCK_DIR_MODE });
  try { fs.chmodSync(lockDir, HOST_REGISTRY_LOCK_DIR_MODE); } catch { /* platform ACLs apply */ }
  return physicalPathLockIdentities(resolveHostsDir())
    .map((identity) => hostRegistryLockPath(identity, lockNamespace))
    .sort();
}

function withHostRegistryTransaction<T>(
  lockNamespace: PerUserLockNamespace,
  fn: () => T,
): T {
  const RETRY = Symbol('retry-host-registry-locks');
  for (let attempt = 0; attempt < HOST_REGISTRY_LOCK_RETRIES; attempt += 1) {
    const locks = hostRegistryLockPaths(lockNamespace);
    const run = (index: number): T | typeof RETRY => {
      if (index < locks.length) {
        return withFileLockSync(locks[index]!, () => run(index + 1));
      }
      const freshLocks = hostRegistryLockPaths(lockNamespace);
      if (freshLocks.length !== locks.length
        || freshLocks.some((lock, index) => lock !== locks[index])) return RETRY;
      return fn();
    };
    const result = run(0);
    if (result !== RETRY) return result;
  }
  throw new Error('Host registry identity did not stabilize while acquiring locks');
}

function isHostRecordShape(value: unknown): value is HostRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  const enrollmentGeneration = record.enrollment_generation;
  const bearerGeneration = record.bearer_generation;
  const generationsValid = enrollmentGeneration === undefined && bearerGeneration === undefined
    || Number.isSafeInteger(enrollmentGeneration)
      && Number(enrollmentGeneration) > 0
      && enrollmentGeneration === bearerGeneration;
  // `host_url` is checked for SHAPE when present but is not required here: a
  // record whose URL is missing or malformed must still LOAD, so the Team page
  // and `myco doctor` can say "re-join required" about it. Dropping it at parse
  // time would make an unusable host indistinguishable from one that was never
  // joined — the failure would be invisible instead of explained.
  return typeof record.host_id === 'string'
    && record.host_id.length > 0
    && typeof record.label === 'string'
    && (record.host_url === undefined || typeof record.host_url === 'string')
    && Number.isSafeInteger(record.protocol_version)
    && typeof record.created_at === 'string'
    && Array.isArray(record.projects)
    && generationsValid;
}

function generationLedgerDir(): string {
  return path.join(resolveTeamsHome(), HOST_GENERATIONS_DIRNAME);
}

function generationLedgerPath(hostId: string): string {
  return path.join(generationLedgerDir(), `${hostId}.json`);
}

function hostEnrollmentIntentPath(hostId: string): string {
  return path.join(resolveHostDir(hostId), HOST_ENROLLMENT_INTENT_FILENAME);
}

function hostBearerDir(hostId: string): string {
  return path.join(resolveHostDir(hostId), HOST_BEARERS_DIRNAME);
}

function hostBearerPath(hostId: string, generation: number): string {
  return path.join(hostBearerDir(hostId), `${generation}.env`);
}

function ensurePrivateDirectoryDurable(directory: string): void {
  let created = false;
  try {
    const stat = fs.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Refusing non-directory enrollment state path: ${directory}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    fs.mkdirSync(directory, { recursive: true, mode: HOST_PRIVATE_DIR_MODE });
    created = true;
  }
  try { fs.chmodSync(directory, HOST_PRIVATE_DIR_MODE); } catch { /* platform ACLs apply */ }
  if (created) syncDirectoryForDurability(path.dirname(directory));
}

function assertPrivateRegularFile(filePath: string, hostId: string): void {
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new HostJoinStateCorruptError(hostId, `${filePath} is not a regular file`);
  }
  if (process.platform !== 'win32' && (stat.mode & 0o777) !== HOST_ENROLLMENT_STATE_MODE) {
    throw new HostJoinStateCorruptError(hostId, `${filePath} is not owner-only`);
  }
}

function readPrivateJsonFileUnlocked(
  filePath: string,
  hostId: string,
): unknown | null {
  try {
    assertPrivateRegularFile(filePath, hostId);
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if (error instanceof HostJoinStateCorruptError) throw error;
    throw new HostJoinStateCorruptError(hostId, `cannot read ${path.basename(filePath)}`);
  }
}

function parseGenerationLedger(
  value: unknown,
  hostId: string,
): HostGenerationLedger {
  if (!value || typeof value !== 'object') {
    throw new HostJoinStateCorruptError(hostId, 'generation ledger is not an object');
  }
  const ledger = value as Record<string, unknown>;
  if (ledger.schema_version !== HOST_ENROLLMENT_SCHEMA_VERSION
    || ledger.host_id !== hostId
    || !Number.isSafeInteger(ledger.last_allocated_generation)
    || Number(ledger.last_allocated_generation) < 0
    || !Number.isSafeInteger(ledger.retired_through_generation)
    || Number(ledger.retired_through_generation) < 0
    || Number(ledger.retired_through_generation) > Number(ledger.last_allocated_generation)) {
    throw new HostJoinStateCorruptError(hostId, 'generation ledger has an invalid shape');
  }
  return ledger as unknown as HostGenerationLedger;
}

function readGenerationLedgerUnlocked(hostId: string): HostGenerationLedger | null {
  const parsed = readPrivateJsonFileUnlocked(generationLedgerPath(hostId), hostId);
  return parsed === null ? null : parseGenerationLedger(parsed, hostId);
}

function writeGenerationLedgerUnlocked(ledger: HostGenerationLedger): void {
  ensurePrivateDirectoryDurable(generationLedgerDir());
  atomicWriteFileSync(
    generationLedgerPath(ledger.host_id),
    JSON.stringify(ledger, null, 2),
    { mode: HOST_ENROLLMENT_STATE_MODE, durable: true },
  );
}

function readHostRecordUnlocked(hostId: string): HostRecord | null {
  let parsed: unknown;
  try {
    const configPath = resolveHostConfigPath(hostId);
    const stat = fs.lstatSync(configPath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new HostJoinStateCorruptError(hostId, 'host.json is not a regular file');
    }
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if (error instanceof HostJoinStateCorruptError) throw error;
    throw new HostJoinStateCorruptError(hostId, 'host.json is missing or malformed');
  }
  if (!isHostRecordShape(parsed) || parsed.host_id !== hostId) {
    throw new HostJoinStateCorruptError(hostId, 'host.json has an invalid shape');
  }
  return parsed;
}

function readGenerationBearerUnlocked(hostId: string, generation: number): string {
  const bearerPath = hostBearerPath(hostId, generation);
  try {
    assertPrivateRegularFile(bearerPath, hostId);
    const secrets = readExactSecretsFile(bearerPath);
    const bearer = secrets[HOST_BEARER_SECRET];
    assertValidSecretEntry(HOST_BEARER_SECRET, bearer);
    if (!bearer) throw new Error('missing bearer');
    return bearer;
  } catch (error) {
    if (error instanceof HostJoinStateCorruptError) throw error;
    throw new HostJoinStateCorruptError(
      hostId,
      `bearer generation ${generation} is missing or malformed`,
    );
  }
}

function readLegacyHostBearerUnlocked(hostId: string): string {
  try {
    const bearer = readSecretsFile(resolveHostDir(hostId))[HOST_BEARER_SECRET];
    assertValidSecretEntry(HOST_BEARER_SECRET, bearer);
    if (!bearer) throw new Error('missing bearer');
    return bearer;
  } catch {
    throw new HostJoinStateCorruptError(
      hostId,
      'legacy secrets.env bearer is missing or malformed',
    );
  }
}

function publishLegacyHostBearerUnlocked(
  hostId: string,
  bearer: string,
  lockNamespace: PerUserLockNamespace,
): void {
  writeSecretFile(resolveHostDir(hostId), HOST_BEARER_SECRET, bearer, lockNamespace);
  if (readLegacyHostBearerUnlocked(hostId) !== bearer) {
    throw new HostJoinStateCorruptError(hostId, 'legacy secrets.env bearer did not verify');
  }
}

function repairLegacyHostBearerFromRecordUnlocked(
  record: HostRecord,
  lockNamespace: PerUserLockNamespace,
): void {
  const generation = record.bearer_generation;
  if (generation === undefined) {
    throw new HostJoinStateCorruptError(
      record.host_id,
      'committed enrollment has no bearer generation',
    );
  }
  const bearer = readGenerationBearerUnlocked(record.host_id, generation);
  publishLegacyHostBearerUnlocked(record.host_id, bearer, lockNamespace);
}

function readHostMembershipSnapshotUnlocked(hostId: string): HostMembershipSnapshot | null {
  const record = readHostRecordUnlocked(hostId);
  if (!record) return null;
  const enrollmentGeneration = record.enrollment_generation;
  const bearerGeneration = record.bearer_generation;
  let legacySecrets: Record<string, string>;
  try {
    legacySecrets = readSecretsFile(resolveHostDir(hostId));
  } catch {
    throw new HostJoinStateCorruptError(hostId, 'legacy secrets.env is malformed');
  }
  if (enrollmentGeneration === undefined && bearerGeneration === undefined) {
    const legacyLedger = readGenerationLedgerUnlocked(hostId);
    if (legacyLedger && legacyLedger.retired_through_generation > 0) return null;
    return {
      record,
      bearer: legacySecrets[HOST_BEARER_SECRET] ?? '',
      secrets: legacySecrets,
    };
  }
  if (enrollmentGeneration === undefined
    || bearerGeneration === undefined
    || enrollmentGeneration !== bearerGeneration) {
    throw new HostJoinStateCorruptError(hostId, 'host pointer generations do not match');
  }
  const ledger = readGenerationLedgerUnlocked(hostId);
  if (!ledger || enrollmentGeneration > ledger.last_allocated_generation) {
    throw new HostJoinStateCorruptError(hostId, 'host pointer is outside its generation ledger');
  }
  if (enrollmentGeneration <= ledger.retired_through_generation) return null;
  const bearer = readGenerationBearerUnlocked(hostId, bearerGeneration);
  return {
    record,
    bearer,
    secrets: { ...legacySecrets, [HOST_BEARER_SECRET]: bearer },
  };
}

function readHostRegistryUnlocked(): HostRecord[] {
  return readHostMembershipSnapshotsUnlocked().map((snapshot) => snapshot.record);
}

function readHostDirectoryEntriesUnlocked(
  errorMode: 'empty' | 'strict',
): fs.Dirent[] {
  const hostsDir = resolveHostsDir();
  try {
    return fs.readdirSync(hostsDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || errorMode === 'empty') {
      return [];
    }
    throw error;
  }
}

function readHostMembershipSnapshotsFromEntriesUnlocked(
  entries: fs.Dirent[],
): HostMembershipSnapshot[] {
  const results: HostMembershipSnapshot[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.myco-remove-')) continue;
    const snapshot = readHostMembershipSnapshotUnlocked(entry.name);
    if (snapshot) results.push(snapshot);
  }
  return results;
}

function readHostMembershipSnapshotsUnlocked(): HostMembershipSnapshot[] {
  return readHostMembershipSnapshotsFromEntriesUnlocked(
    readHostDirectoryEntriesUnlocked('empty'),
  );
}

function readHostMembershipSnapshotsStrictUnlocked(): HostMembershipSnapshot[] {
  return readHostMembershipSnapshotsFromEntriesUnlocked(
    readHostDirectoryEntriesUnlocked('strict'),
  );
}

/** Read every committed, non-retired host record through one registry snapshot. */
export function readHostRegistry(
  lockNamespace: PerUserLockNamespace = nativePerUserLockNamespace,
): HostRecord[] {
  return withHostRegistryTransaction(lockNamespace, readHostRegistryUnlocked);
}

export function readHostMembershipSnapshots(
  lockNamespace: PerUserLockNamespace = nativePerUserLockNamespace,
): HostMembershipSnapshot[] {
  return withHostRegistryTransaction(lockNamespace, readHostMembershipSnapshotsUnlocked);
}

/** Reconcile every committed generation bearer into the rollback-readable store. */
export function reconcileHostRollbackBearers(
  lockNamespace: PerUserLockNamespace = nativePerUserLockNamespace,
): number {
  return withHostRegistryTransaction(lockNamespace, () => {
    reconcileDurableRemovalTombstonesSync(resolveHostsDir());
    let repaired = 0;
    for (const snapshot of readHostMembershipSnapshotsStrictUnlocked()) {
      if (snapshot.record.bearer_generation === undefined) continue;
      const hostDir = resolveHostDir(snapshot.record.host_id);
      try {
        tightenSecretsPermissions(hostDir, lockNamespace);
      } catch {
        throw new HostJoinStateCorruptError(
          snapshot.record.host_id,
          'legacy secrets.env is unsafe or malformed',
        );
      }
      let legacyBearer: string | undefined;
      try {
        legacyBearer = readSecretsFile(hostDir)[HOST_BEARER_SECRET];
      } catch {
        throw new HostJoinStateCorruptError(
          snapshot.record.host_id,
          'legacy secrets.env is malformed',
        );
      }
      if (legacyBearer === snapshot.bearer) continue;
      publishLegacyHostBearerUnlocked(
        snapshot.record.host_id,
        snapshot.bearer,
        lockNamespace,
      );
      repaired += 1;
    }
    return repaired;
  });
}

/** Read a single committed, non-retired host record by id. */
export function getHost(
  hostId: string,
  lockNamespace: PerUserLockNamespace = nativePerUserLockNamespace,
): HostRecord | null {
  return withHostRegistryTransaction(
    lockNamespace,
    () => readHostMembershipSnapshotUnlocked(hostId)?.record ?? null,
  );
}

/** Read a record and the bearer selected by its atomic generation pointer. */
export function getHostMembershipSnapshot(
  hostId: string,
  lockNamespace: PerUserLockNamespace = nativePerUserLockNamespace,
): HostMembershipSnapshot | null {
  return withHostRegistryTransaction(
    lockNamespace,
    () => readHostMembershipSnapshotUnlocked(hostId),
  );
}

function writeHostRecordUnlocked(record: HostRecord): void {
  const hostDir = resolveHostDir(record.host_id);
  ensurePrivateDirectoryDurable(resolveHostsDir());
  ensurePrivateDirectoryDurable(hostDir);
  atomicWriteFileSync(
    resolveHostConfigPath(record.host_id),
    JSON.stringify(record, null, 2),
    { durable: true },
  );
}

function hostEnrollmentClaimPath(hostId: string): string {
  return path.join(resolveHostDir(hostId), HOST_ENROLLMENT_CLAIM_FILENAME);
}

function parseHostEnrollmentClaim(value: unknown, hostId: string): HostEnrollmentClaim {
  if (!value || typeof value !== 'object') {
    throw new Error(`Invalid enrollment claim for host ${hostId}: expected an object.`);
  }
  const claim = value as Record<string, unknown>;
  const baseGeneration = claim.base_generation;
  if (claim.host_id !== hostId
    || typeof claim.claim_id !== 'string'
    || claim.claim_id.length === 0
    || !Number.isSafeInteger(claim.generation)
    || Number(claim.generation) <= 0
    || !(baseGeneration === null
      || Number.isSafeInteger(baseGeneration) && Number(baseGeneration) >= 0)
    || typeof claim.enrollment_nonce !== 'string'
    || !/^[a-f0-9]{32,}$/.test(claim.enrollment_nonce)) {
    throw new HostJoinStateCorruptError(hostId, 'invalid enrollment claim');
  }
  return claim as unknown as HostEnrollmentClaim;
}

function readHostEnrollmentClaimUnlocked(hostId: string): HostEnrollmentClaim | null {
  const parsed = readPrivateJsonFileUnlocked(hostEnrollmentClaimPath(hostId), hostId);
  return parsed === null ? null : parseHostEnrollmentClaim(parsed, hostId);
}

function writeHostEnrollmentClaimUnlocked(claim: HostEnrollmentClaim): void {
  ensurePrivateDirectoryDurable(resolveHostsDir());
  ensurePrivateDirectoryDurable(resolveHostDir(claim.host_id));
  atomicWriteFileSync(
    hostEnrollmentClaimPath(claim.host_id),
    JSON.stringify(claim, null, 2),
    { mode: HOST_ENROLLMENT_CLAIM_MODE, durable: true },
  );
}

function removeHostDirIfEmptyUnlocked(hostId: string): void {
  const hostDir = resolveHostDir(hostId);
  try {
    if (fs.readdirSync(hostDir).length === 0) fs.rmdirSync(hostDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

const ENROLLMENT_PHASE_ORDER: Readonly<Record<Exclude<HostEnrollmentPhase, 'teardown_pending'>, number>> = {
  reserved: 0,
  enrolling: 1,
  credential_staged: 2,
};

function parseHostEnrollmentIntent(value: unknown, hostId: string): HostEnrollmentIntent {
  if (!value || typeof value !== 'object') {
    throw new HostJoinStateCorruptError(hostId, 'enrollment intent is not an object');
  }
  const intent = value as Record<string, unknown>;
  const phase = intent.phase;
  const baseGeneration = intent.base_generation;
  if (intent.schema_version !== HOST_ENROLLMENT_SCHEMA_VERSION
    || intent.host_id !== hostId
    || !Number.isSafeInteger(intent.generation)
    || Number(intent.generation) <= 0
    || !(baseGeneration === null
      || Number.isSafeInteger(baseGeneration) && Number(baseGeneration) >= 0)
    || typeof intent.enrollment_nonce !== 'string'
    || !/^[a-f0-9]{32,}$/.test(intent.enrollment_nonce)
    || typeof intent.claim_id !== 'string'
    || intent.claim_id.length === 0
    || typeof phase !== 'string'
    || !(phase === 'teardown_pending' || Object.hasOwn(ENROLLMENT_PHASE_ORDER, phase))
    || typeof intent.created_at !== 'string'
    || typeof intent.updated_at !== 'string') {
    throw new HostJoinStateCorruptError(hostId, 'enrollment intent has an invalid shape');
  }
  return intent as unknown as HostEnrollmentIntent;
}

function readHostEnrollmentIntentUnlocked(hostId: string): HostEnrollmentIntent | null {
  const parsed = readPrivateJsonFileUnlocked(hostEnrollmentIntentPath(hostId), hostId);
  return parsed === null ? null : parseHostEnrollmentIntent(parsed, hostId);
}

function writeHostEnrollmentIntentUnlocked(intent: HostEnrollmentIntent): void {
  ensurePrivateDirectoryDurable(resolveHostsDir());
  ensurePrivateDirectoryDurable(resolveHostDir(intent.host_id));
  atomicWriteFileSync(
    hostEnrollmentIntentPath(intent.host_id),
    JSON.stringify(intent, null, 2),
    { mode: HOST_ENROLLMENT_STATE_MODE, durable: true },
  );
}

function reservationFromIntent(
  intent: HostEnrollmentIntent,
  recoveredCommit = false,
): HostEnrollmentReservation {
  return {
    hostId: intent.host_id,
    claimId: intent.claim_id,
    generation: intent.generation,
    baseGeneration: intent.base_generation,
    enrollmentNonce: intent.enrollment_nonce,
    phase: intent.phase,
    recoveredCommit,
  };
}

function assertReservationMatchesIntent(
  reservation: HostEnrollmentReservation,
  intent: HostEnrollmentIntent | null,
): asserts intent is HostEnrollmentIntent {
  if (!intent
    || intent.host_id !== reservation.hostId
    || intent.generation !== reservation.generation
    || intent.claim_id !== reservation.claimId
    || intent.enrollment_nonce !== reservation.enrollmentNonce
    || intent.base_generation !== reservation.baseGeneration) {
    throw new HostJoinStateCorruptError(
      reservation.hostId,
      'enrollment reservation no longer matches its durable intent',
    );
  }
}

function assertClaimMatchesIntent(
  claim: HostEnrollmentClaim | null,
  intent: HostEnrollmentIntent,
): asserts claim is HostEnrollmentClaim {
  if (!claim
    || claim.host_id !== intent.host_id
    || claim.generation !== intent.generation
    || claim.claim_id !== intent.claim_id
    || claim.base_generation !== intent.base_generation
    || claim.enrollment_nonce !== intent.enrollment_nonce) {
    throw new HostJoinStateCorruptError(
      intent.host_id,
      'enrollment intent no longer matches its durable claim',
    );
  }
}

/**
 * Reserve the generation a join attempt will commit under.
 *
 * A retry adopts the exact durable generation and claim token until the
 * enrollment is committed or retired — which is what makes a re-join replace a
 * membership atomically instead of interleaving a new bearer with an old
 * record. The generation fence (ledger `last_allocated` /
 * `retired_through`) is the ordering authority; the claim and intent are the
 * two durable witnesses that let a crashed attempt be told apart from a
 * committed one.
 */
export function reserveHostEnrollment(
  hostId: string,
  lockNamespace: PerUserLockNamespace = nativePerUserLockNamespace,
): HostEnrollmentReservation {
  return withHostRegistryTransaction(lockNamespace, () => {
    reconcileDurableRemovalTombstonesSync(resolveHostsDir());
    reconcileDurableRemovalTombstonesSync(generationLedgerDir());
    const existingSnapshot = readHostMembershipSnapshotUnlocked(hostId);
    const existing = existingSnapshot?.record ?? null;
    let ledger = readGenerationLedgerUnlocked(hostId);
    const currentIntent = readHostEnrollmentIntentUnlocked(hostId);
    const currentClaim = readHostEnrollmentClaimUnlocked(hostId);
    const committedGeneration = existing?.enrollment_generation ?? (existing ? 0 : null);

    if (currentIntent) {
      if (!ledger
        || currentIntent.generation > ledger.last_allocated_generation
        || currentIntent.generation <= ledger.retired_through_generation) {
        throw new HostJoinStateCorruptError(hostId, 'enrollment intent is outside its generation fence');
      }
      if (currentIntent.generation === existing?.enrollment_generation) {
        assertClaimMatchesIntent(currentClaim, currentIntent);
        repairLegacyHostBearerFromRecordUnlocked(existing, lockNamespace);
        const recovery = reservationFromIntent(currentIntent, true);
        durableRemovePathSync(hostEnrollmentIntentPath(hostId));
        durableRemovePathSync(hostEnrollmentClaimPath(hostId));
        return recovery;
      } else {
        assertClaimMatchesIntent(currentClaim, currentIntent);
        if (currentIntent.base_generation !== committedGeneration) {
          throw new HostJoinStateCorruptError(hostId, 'enrollment intent base is not the committed generation');
        }
        return reservationFromIntent(currentIntent);
      }
    }

    if (currentClaim) {
      if (!ledger
        || currentClaim.generation > ledger.last_allocated_generation
        || currentClaim.generation <= ledger.retired_through_generation) {
        throw new HostJoinStateCorruptError(hostId, 'orphan enrollment claim is outside its generation fence');
      }
      if (currentClaim.generation === existing?.enrollment_generation) {
        if (!existingSnapshot?.bearer) {
          throw new HostJoinStateCorruptError(hostId, 'committed claim has no matching bearer');
        }
        repairLegacyHostBearerFromRecordUnlocked(existing, lockNamespace);
        const recovery: HostEnrollmentReservation = {
          hostId,
          claimId: currentClaim.claim_id,
          generation: currentClaim.generation,
          baseGeneration: currentClaim.base_generation,
          enrollmentNonce: currentClaim.enrollment_nonce,
          phase: 'credential_staged',
          recoveredCommit: true,
        };
        durableRemovePathSync(hostEnrollmentClaimPath(hostId));
        return recovery;
      }
      durableRemovePathSync(hostEnrollmentClaimPath(hostId));
    }

    const generation = (ledger?.last_allocated_generation ?? 0) + 1;
    ledger = {
      schema_version: HOST_ENROLLMENT_SCHEMA_VERSION,
      host_id: hostId,
      last_allocated_generation: generation,
      retired_through_generation: ledger?.retired_through_generation ?? 0,
    };
    writeGenerationLedgerUnlocked(ledger);

    const enrollmentNonce = randomBytes(16).toString('hex');
    const claim: HostEnrollmentClaim = {
      host_id: hostId,
      claim_id: randomUUID(),
      generation,
      base_generation: committedGeneration,
      enrollment_nonce: enrollmentNonce,
    };
    writeHostEnrollmentClaimUnlocked(claim);
    const now = new Date().toISOString();
    const intent: HostEnrollmentIntent = {
      schema_version: HOST_ENROLLMENT_SCHEMA_VERSION,
      host_id: hostId,
      generation,
      base_generation: committedGeneration,
      enrollment_nonce: enrollmentNonce,
      claim_id: claim.claim_id,
      phase: 'reserved',
      created_at: now,
      updated_at: now,
    };
    writeHostEnrollmentIntentUnlocked(intent);
    return reservationFromIntent(intent);
  });
}

/**
 * Release only the exact active claim represented by `reservation`.
 * Committed reservations and stale attempt tokens are no-ops.
 */
export function releaseHostEnrollment(
  reservation: HostEnrollmentReservation,
  lockNamespace: PerUserLockNamespace = nativePerUserLockNamespace,
): void {
  withHostRegistryTransaction(lockNamespace, () => {
    const intent = readHostEnrollmentIntentUnlocked(reservation.hostId);
    if (!intent
      || intent.generation !== reservation.generation
      || intent.claim_id !== reservation.claimId
      || intent.enrollment_nonce !== reservation.enrollmentNonce
      || intent.base_generation !== reservation.baseGeneration) return;
    if (intent.phase !== 'reserved') {
      throw new HostJoinStateCorruptError(
        reservation.hostId,
        `cannot release an enrollment in phase ${intent.phase} without verified teardown`,
      );
    }
    const claim = readHostEnrollmentClaimUnlocked(reservation.hostId);
    if (!claim
      || claim.generation !== reservation.generation
      || claim.claim_id !== reservation.claimId
      || claim.base_generation !== reservation.baseGeneration
      || claim.enrollment_nonce !== reservation.enrollmentNonce) return;
    durableRemovePathSync(hostEnrollmentIntentPath(reservation.hostId));
    durableRemovePathSync(hostEnrollmentClaimPath(reservation.hostId));
    removeHostDirIfEmptyUnlocked(reservation.hostId);
  });
}

export function advanceHostEnrollmentPhase(
  reservation: HostEnrollmentReservation,
  phase: Exclude<HostEnrollmentPhase, 'teardown_pending'>,
  lockNamespace: PerUserLockNamespace = nativePerUserLockNamespace,
): HostEnrollmentReservation {
  return withHostRegistryTransaction(lockNamespace, () => {
    const intent = readHostEnrollmentIntentUnlocked(reservation.hostId);
    assertReservationMatchesIntent(reservation, intent);
    const claim = readHostEnrollmentClaimUnlocked(reservation.hostId);
    assertClaimMatchesIntent(claim, intent);
    const ledger = readGenerationLedgerUnlocked(reservation.hostId);
    if (!ledger
      || intent.generation > ledger.last_allocated_generation
      || intent.generation <= ledger.retired_through_generation) {
      throw new HostJoinStateCorruptError(reservation.hostId, 'intent is outside its generation fence');
    }
    const currentOrder = intent.phase === 'teardown_pending'
      ? Number.POSITIVE_INFINITY
      : ENROLLMENT_PHASE_ORDER[intent.phase];
    const requestedOrder = ENROLLMENT_PHASE_ORDER[phase];
    if (requestedOrder < currentOrder) return reservationFromIntent(intent);
    const updated: HostEnrollmentIntent = {
      ...intent,
      phase,
      updated_at: new Date().toISOString(),
    };
    writeHostEnrollmentIntentUnlocked(updated);
    return reservationFromIntent(updated);
  });
}

export function markHostEnrollmentTeardownPending(
  reservation: HostEnrollmentReservation,
  lockNamespace: PerUserLockNamespace = nativePerUserLockNamespace,
): void {
  withHostRegistryTransaction(lockNamespace, () => {
    const intent = readHostEnrollmentIntentUnlocked(reservation.hostId);
    assertReservationMatchesIntent(reservation, intent);
    writeHostEnrollmentIntentUnlocked({
      ...intent,
      phase: 'teardown_pending',
      updated_at: new Date().toISOString(),
    });
  });
}

/**
 * Discard a failed join's reservation.
 *
 * Eligibility used to also require that this attempt OWNED the service it
 * provisioned — automatic cleanup could not be allowed to remove state some
 * earlier, still-live tailscaled depended on. There is no service, so what
 * remains is the part that was never about services: never discard an attempt
 * that has already staged a credential (it may be committed), and never
 * discard one layered over an existing membership (`base_generation !== null`)
 * — that is a re-join, and tearing it down silently would take the previous
 * membership with it.
 */
export function abandonHostEnrollment(
  reservation: HostEnrollmentReservation,
  lockNamespace: PerUserLockNamespace = nativePerUserLockNamespace,
): void {
  withHostRegistryTransaction(lockNamespace, () => {
    const intent = readHostEnrollmentIntentUnlocked(reservation.hostId);
    assertReservationMatchesIntent(reservation, intent);
    const claim = readHostEnrollmentClaimUnlocked(reservation.hostId);
    assertClaimMatchesIntent(claim, intent);
    if (intent.phase === 'credential_staged'
      || intent.phase === 'teardown_pending'
      || intent.base_generation !== null) {
      throw new HostJoinStateCorruptError(
        reservation.hostId,
        'enrollment state is not eligible for automatic teardown cleanup',
      );
    }
    durableRemovePathSync(hostEnrollmentIntentPath(reservation.hostId));
    durableRemovePathSync(hostEnrollmentClaimPath(reservation.hostId));
    removeHostDirIfEmptyUnlocked(reservation.hostId);
  });
}

function persistEnrollmentMembershipUnlocked(
  enrollment: EnrollmentHostRecord,
  bearer: string,
  reservation: HostEnrollmentReservation,
  lockNamespace: PerUserLockNamespace,
): EnrollmentMembershipResult {
  if (reservation.hostId !== enrollment.host_id) {
    throw new Error(
      `Enrollment reservation for host ${reservation.hostId} cannot enroll host ${enrollment.host_id}.`,
    );
  }
  // A host with no dial address is not a degraded membership, it is an
  // unusable one: every drain, probe, and proxy call downstream treats a
  // record as a live target. Refuse at the commit rather than write a
  // membership that can only fail later, opaquely.
  if (!isValidHostUrl(enrollment.host_url)) {
    throw new HostJoinStateCorruptError(
      enrollment.host_id,
      `enrollment carries no usable host_url (${JSON.stringify(enrollment.host_url ?? null)})`,
    );
  }
  assertValidSecretEntry(HOST_BEARER_SECRET, bearer);
  if (!bearer) {
    throw new HostJoinStateCorruptError(enrollment.host_id, 'enrollment bearer is empty');
  }
  const intent = readHostEnrollmentIntentUnlocked(enrollment.host_id);
  assertReservationMatchesIntent(reservation, intent);
  const claim = readHostEnrollmentClaimUnlocked(enrollment.host_id);
  assertClaimMatchesIntent(claim, intent);
  const ledger = readGenerationLedgerUnlocked(enrollment.host_id);
  if (!ledger
    || intent.generation > ledger.last_allocated_generation
    || intent.generation <= ledger.retired_through_generation) {
    throw new HostJoinStateCorruptError(enrollment.host_id, 'enrollment generation is fenced');
  }
  const existingSnapshot = readHostMembershipSnapshotUnlocked(enrollment.host_id);
  const existing = existingSnapshot?.record ?? null;
  const committedGeneration = existing?.enrollment_generation ?? (existing ? 0 : null);
  if (intent.base_generation !== committedGeneration) {
    throw new HostJoinStateCorruptError(
      enrollment.host_id,
      'enrollment base no longer matches the committed generation',
    );
  }
  const phaseOrder = intent.phase === 'teardown_pending'
    ? -1
    : ENROLLMENT_PHASE_ORDER[intent.phase];
  if (phaseOrder < ENROLLMENT_PHASE_ORDER.enrolling) {
    throw new HostJoinStateCorruptError(
      enrollment.host_id,
      `cannot stage credentials from enrollment phase ${intent.phase}`,
    );
  }

  ensurePrivateDirectoryDurable(hostBearerDir(enrollment.host_id));
  atomicWriteFileSync(
    hostBearerPath(enrollment.host_id, intent.generation),
    `${HOST_BEARER_SECRET}=${bearer}\n`,
    { mode: HOST_ENROLLMENT_STATE_MODE, durable: true },
  );
  const stagedIntent: HostEnrollmentIntent = {
    ...intent,
    phase: 'credential_staged',
    updated_at: new Date().toISOString(),
  };
  writeHostEnrollmentIntentUnlocked(stagedIntent);
  publishLegacyHostBearerUnlocked(enrollment.host_id, bearer, lockNamespace);

  const servedGroveId = Object.hasOwn(enrollment, 'served_grove_id')
    ? enrollment.served_grove_id
    : existing?.served_grove_id;
  const record: HostRecord = {
    ...enrollment,
    ...(servedGroveId !== undefined ? { served_grove_id: servedGroveId } : {}),
    created_at: existing?.created_at ?? enrollment.created_at,
    projects: existing?.projects ?? [],
    enrollment_generation: intent.generation,
    bearer_generation: intent.generation,
  };
  writeHostRecordUnlocked(record);

  const committed = readHostMembershipSnapshotUnlocked(record.host_id);
  if (!committed
    || committed.record.enrollment_generation !== intent.generation
    || committed.bearer !== bearer
    || readLegacyHostBearerUnlocked(record.host_id) !== bearer) {
    throw new HostJoinStateCorruptError(record.host_id, 'published enrollment did not verify');
  }
  durableRemovePathSync(hostEnrollmentIntentPath(record.host_id));
  durableRemovePathSync(hostEnrollmentClaimPath(record.host_id));
  return { record, created: existing === null };
}

/**
 * Persist enrollment metadata and bearer as one registry transaction.
 * Existing attachments and creation time are merged from a fresh in-lock read.
 */
export function persistEnrollmentMembership(
  enrollment: EnrollmentHostRecord,
  bearer: string,
  reservation: HostEnrollmentReservation,
  lockNamespace: PerUserLockNamespace = nativePerUserLockNamespace,
): EnrollmentMembershipResult {
  return withHostRegistryTransaction(
    lockNamespace,
    () => persistEnrollmentMembershipUnlocked(enrollment, bearer, reservation, lockNamespace),
  );
}

export interface HostLeaveInspection {
  record: HostRecord | null;
  statePresent: boolean;
  corrupt: boolean;
}

export function inspectHostMembershipForLeave(
  hostId: string,
  lease: HostOperationLease,
  lockNamespace: PerUserLockNamespace = nativePerUserLockNamespace,
): HostLeaveInspection {
  assertHostOperationLease(lease, hostId, 'leave');
  return withHostRegistryTransaction(lockNamespace, () => {
    reconcileDurableRemovalTombstonesSync(resolveHostsDir());
    let record: HostRecord | null = null;
    let corrupt = false;
    try {
      record = readHostMembershipSnapshotUnlocked(hostId)?.record ?? null;
      if (!record && fs.existsSync(resolveHostConfigPath(hostId))) {
        record = readHostRecordUnlocked(hostId);
      }
    } catch (error) {
      if (!(error instanceof HostJoinStateCorruptError)) throw error;
      corrupt = true;
      try {
        record = readHostRecordUnlocked(hostId);
      } catch {
        record = null;
      }
    }
    // The claim is read only to surface corruption — a leave never needs its
    // contents, and a member whose claim will not parse must still be able to
    // leave.
    try {
      readHostEnrollmentClaimUnlocked(hostId);
    } catch (error) {
      if (!(error instanceof HostJoinStateCorruptError)) throw error;
      corrupt = true;
    }
    const ledgerPath = generationLedgerPath(hostId);
    let ledger: HostGenerationLedger | null = null;
    try {
      ledger = readGenerationLedgerUnlocked(hostId);
    } catch (error) {
      if (!(error instanceof HostJoinStateCorruptError)) throw error;
      corrupt = true;
    }
    const hostDir = resolveHostDir(hostId);
    return {
      record,
      statePresent: fs.existsSync(hostDir)
        || fs.existsSync(ledgerPath) && ledger === null
        || ledger !== null
          && ledger.retired_through_generation < ledger.last_allocated_generation,
      corrupt,
    };
  });
}

export function retireHostMembership(
  hostId: string,
  lease: HostOperationLease,
  lockNamespace: PerUserLockNamespace = nativePerUserLockNamespace,
): void {
  assertHostOperationLease(lease, hostId, 'leave');
  withHostRegistryTransaction(lockNamespace, () => {
    let record: HostRecord | null = null;
    try { record = readHostRecordUnlocked(hostId); } catch (error) {
      if (!(error instanceof HostJoinStateCorruptError)) throw error;
    }
    // The claim is still read: its generation feeds the ledger high-water below,
    // which is the atomic bearer-commit mechanism and outlives the overlay.
    //
    // What is gone is the proxy-port identity this used to derive and refuse on.
    // That guard proved the member's tailscaled had released its CONNECT-proxy
    // port before the reservation was retired; with no tailscaled and no port it
    // only refused a leave whose record and claim were both missing — so a member
    // with corrupt state could never leave, for no remaining reason.
    let claim: HostEnrollmentClaim | null = null;
    try { claim = readHostEnrollmentClaimUnlocked(hostId); } catch (error) {
      if (!(error instanceof HostJoinStateCorruptError)) throw error;
    }
    let ledger: HostGenerationLedger | null = null;
    try {
      ledger = readGenerationLedgerUnlocked(hostId);
    } catch (error) {
      if (!(error instanceof HostJoinStateCorruptError)) throw error;
    }
    const durableLedger = ledger
      ?? {
        schema_version: HOST_ENROLLMENT_SCHEMA_VERSION,
        host_id: hostId,
        last_allocated_generation: record?.enrollment_generation ?? 0,
        retired_through_generation: 0,
      };
    const lastAllocated = Math.max(
      1,
      durableLedger.last_allocated_generation,
      record?.enrollment_generation ?? (record ? 1 : 0),
      claim?.generation ?? 0,
    );
    writeGenerationLedgerUnlocked({
      ...durableLedger,
      last_allocated_generation: lastAllocated,
      retired_through_generation: lastAllocated,
    });
    durableRemovePathSync(resolveHostDir(hostId));
  });
}

/**
 * Thrown by `attachProject` when `ref.project_id` is already attached to a
 * DIFFERENT host. Without this guard, `resolveAttach`'s reverse lookup over
 * `readHostRegistry()` (filesystem `readdirSync` order, not guaranteed)
 * would silently return whichever host happened to iterate first — the same
 * kind of ambiguity a `project_in_other_team` guard prevents for team
 * membership. A future daemon transport (attach command, Task 1.2+) should
 * map this to a 409 `project_attached_to_other_host`.
 */
export class ProjectAttachedToOtherHostError extends Error {
  constructor(
    readonly projectId: string,
    readonly attemptedHostId: string,
    readonly existingHostId: string,
  ) {
    super(
      `Project ${projectId} is already attached to host ${existingHostId}; `
      + `cannot attach it to host ${attemptedHostId} as well (a project may be attached to only one host).`,
    );
    this.name = 'ProjectAttachedToOtherHostError';
  }
}

/**
 * Thrown by `attachProject` when `ref.project_id` still has a LOCAL Grove
 * registry row. Attaching a project whose Grove state lives locally would
 * leave a stale row the member daemon's scope iteration keeps running
 * intelligence against (the never-materialize invariant's leak shape). The
 * guard makes the local→attached transition structurally refuse until the
 * caller deregisters/migrates the project off its local Grove first — the
 * forcing function the future attach flow must honor.
 */
export class ProjectRegisteredLocallyError extends Error {
  constructor(
    readonly projectId: string,
    readonly groveId: string,
  ) {
    super(
      `Project ${projectId} still has a local Grove registry row in Grove ${groveId}; `
      + 'deregister or migrate it off the local Grove before attaching it to a host '
      + '(an attached project must have no local Grove state).',
    );
    this.name = 'ProjectRegisteredLocallyError';
  }
}

/**
 * Attach a project to a host. Idempotent re-attach to this same host
 * backfills `ref.root` and `ref.local_grove_id` (see below) rather than a
 * bare no-op. Throws if the host is unknown, if the project still has a
 * LOCAL Grove registry row (see {@link ProjectRegisteredLocallyError}), or if
 * the project is already attached to a different host (see
 * {@link ProjectAttachedToOtherHostError}).
 */
export function attachProject(
  hostId: string,
  ref: AttachRef,
  mycoHome = resolveMycoHome(),
  lockNamespace: PerUserLockNamespace = nativePerUserLockNamespace,
): void {
  withHostRegistryTransaction(
    lockNamespace,
    () => attachProjectUnlocked(hostId, ref, mycoHome),
  );
}

function attachProjectUnlocked(
  hostId: string,
  ref: AttachRef,
  mycoHome: string,
): void {
  const record = readHostMembershipSnapshotUnlocked(hostId)?.record ?? null;
  if (!record) throw new Error(`Unknown host: ${hostId}`);

  const existingIdx = record.projects.findIndex((p) => p.project_id === ref.project_id);
  if (existingIdx !== -1) {
    // Already attached to THIS host — converges as a no-op EXCEPT for two
    // backfill-only fields. `root`: records created before it was added to
    // `AttachRef` (or whose checkout has since moved) sit forever without it
    // unless a re-attach backfills/refreshes it — and
    // `member-project-context.ts`'s root-mismatch reconciliation silently
    // skips any ref with no `root` (`attach.ref.root && …`), so a stuck
    // record never gets validated against the caller's `project_root`. Root
    // genuinely changes (a checkout moves), so it REFRESHES on every
    // differing value, not just when absent.
    //
    // `local_grove_id` backfills the same way for a legacy ref (recorded
    // before the field existed) but, unlike `root`, never REFRESHES an
    // already-present value — it is an explicit member choice "captured at
    // attach time" (decision-ef693c71), so a later re-attach (e.g. an
    // idempotent CLI re-run, which never passes an explicit value and would
    // otherwise re-resolve to whatever the machine's default happens to be
    // NOW) must not silently downgrade a choice already on record. Changing
    // an existing `local_grove_id` is a distinct, not-yet-built operation,
    // not a side effect of re-attach.
    //
    // `grove_id` is deliberately NOT refreshed here at all — `attachCommand`
    // treats a Grove change on re-attach as requiring an explicit detach
    // first, and this function must not silently move which Grove serves
    // the project.
    const existingRef = record.projects[existingIdx];
    const patch: Partial<AttachRef> = {};
    if (ref.root && existingRef.root !== ref.root) patch.root = ref.root;
    if (ref.local_grove_id && existingRef.local_grove_id === undefined) {
      patch.local_grove_id = ref.local_grove_id;
    }
    if (Object.keys(patch).length > 0) {
      const projects = [...record.projects];
      projects[existingIdx] = { ...existingRef, ...patch };
      writeHostRecordUnlocked({ ...record, projects });
    }
    return;
  }

  // Never-materialize invariant, enforced at the point of attach: refuse to
  // create an attach record while local Grove state exists for the project.
  const local = findRegisteredProjectById(ref.project_id, mycoHome);
  if (local) throw new ProjectRegisteredLocallyError(ref.project_id, local.grove.id);

  const existing = resolveAttachUnlocked(ref.project_id);
  if (existing && existing.host.host_id !== hostId) {
    throw new ProjectAttachedToOtherHostError(ref.project_id, hostId, existing.host.host_id);
  }

  writeHostRecordUnlocked({ ...record, projects: [...record.projects, ref] });
}

/**
 * Monotonic protocol-version refresh: when a live probe observes a host running
 * a HIGHER protocol version than the recorded one (the host upgraded since join),
 * persist it so the residency gates stop refusing a host that is actually
 * current (D-F-5: hosts update first, then members work — without this the
 * recorded version stays at the join-time value forever and every member
 * dead-ends). NEVER downgrades on a probe: a transient lower reading (a
 * mid-restart, a stale cache) must not roll the recorded version back and strand
 * the member — a real downgrade stays the skew classifier's surface, not a
 * silent write. Returns the effective (post-write) recorded version.
 */
export function recordHostProtocolVersion(
  hostId: string,
  observedVersion: number,
  lockNamespace: PerUserLockNamespace = nativePerUserLockNamespace,
): number {
  return withHostRegistryTransaction(
    lockNamespace,
    () => recordHostProtocolVersionUnlocked(hostId, observedVersion),
  );
}

export function isValidObservedHostProtocolVersion(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function recordHostProtocolVersionUnlocked(hostId: string, observedVersion: number): number {
  if (!isValidObservedHostProtocolVersion(observedVersion)) {
    throw new RangeError('Observed host protocol version must be a positive safe integer.');
  }
  const record = readHostMembershipSnapshotUnlocked(hostId)?.record ?? null;
  if (!record) return observedVersion;
  if (observedVersion <= record.protocol_version) {
    return record.protocol_version;
  }
  writeHostRecordUnlocked({ ...record, protocol_version: observedVersion });
  return observedVersion;
}

/** Detach a project from a host. No-op if the host, or the attach ref, doesn't exist. */
export function detachProject(
  hostId: string,
  projectId: string,
  lockNamespace: PerUserLockNamespace = nativePerUserLockNamespace,
): void {
  withHostRegistryTransaction(
    lockNamespace,
    () => detachProjectUnlocked(hostId, projectId),
  );
}

function detachProjectUnlocked(hostId: string, projectId: string): void {
  const record = readHostMembershipSnapshotUnlocked(hostId)?.record ?? null;
  if (!record) return;
  writeHostRecordUnlocked({
    ...record,
    projects: record.projects.filter((p) => p.project_id !== projectId),
  });
}

/**
 * Reverse lookup: which host (if any) serves `projectId`, and the attach
 * ref that ties them together. The chokepoint every routing decision calls
 * (member-side `classifyRoute`, client-side `ensureProjectRegistered`) —
 * a pure disk read across every host record, no daemon, no DB.
 */
export function resolveAttach(
  projectId: string,
  lockNamespace: PerUserLockNamespace = nativePerUserLockNamespace,
): { host: HostRecord; ref: AttachRef } | null {
  return withHostRegistryTransaction(lockNamespace, () => resolveAttachUnlocked(projectId));
}

export function resolveAttachMembership(
  projectId: string,
  lockNamespace: PerUserLockNamespace = nativePerUserLockNamespace,
): { host: HostRecord; ref: AttachRef; bearer: string; secrets: Record<string, string> } | null {
  return withHostRegistryTransaction(lockNamespace, () => {
    for (const snapshot of readHostMembershipSnapshotsUnlocked()) {
      const ref = snapshot.record.projects.find((project) => project.project_id === projectId);
      if (ref) {
        return {
          host: snapshot.record,
          ref,
          bearer: snapshot.bearer,
          secrets: snapshot.secrets,
        };
      }
    }
    return null;
  });
}

function resolveAttachUnlocked(projectId: string): { host: HostRecord; ref: AttachRef } | null {
  for (const record of readHostRegistryUnlocked()) {
    const ref = record.projects.find((p) => p.project_id === projectId);
    if (ref) return { host: record, ref };
  }
  return null;
}

/**
 * The set of Grove ids that are attach targets (hosted Groves) across every
 * host record. A member daemon consults this to keep attached Groves out of
 * its local scope iteration — defense-in-depth for the never-materialize
 * invariant: attached Groves have no local Grove dir and never appear in
 * `listGroves`, but if local state ever leaked for one, its id lands here so
 * the housekeeping/scheduler fan-out structurally skips it.
 */
export function attachTargetGroveIds(
  lockNamespace: PerUserLockNamespace = nativePerUserLockNamespace,
): Set<string> {
  return withHostRegistryTransaction(lockNamespace, () => {
    const ids = new Set<string>();
    for (const record of readHostRegistryUnlocked()) {
      for (const ref of record.projects) ids.add(ref.grove_id);
    }
    return ids;
  });
}

/**
 * The set of project ids that are attached to some host. A member daemon
 * consults this to skip attached projects in per-project scope iteration
 * regardless of which local Grove their (stale) registry row sits in — the
 * grove-level {@link attachTargetGroveIds} skip only covers rows in the
 * hosted Grove, not the leak shape where a local→attached project's row
 * lingers in the local default Grove.
 */
export function attachTargetProjectIds(
  lockNamespace: PerUserLockNamespace = nativePerUserLockNamespace,
): Set<string> {
  return withHostRegistryTransaction(lockNamespace, () => {
    const ids = new Set<string>();
    for (const record of readHostRegistryUnlocked()) {
      for (const ref of record.projects) ids.add(ref.project_id);
    }
    return ids;
  });
}

/** Read all secrets with the bearer selected by the committed generation pointer. */
export function readHostSecrets(
  hostId: string,
  lockNamespace: PerUserLockNamespace = nativePerUserLockNamespace,
): Record<string, string> {
  return withHostRegistryTransaction(
    lockNamespace,
    () => readHostMembershipSnapshotUnlocked(hostId)?.secrets ?? {},
  );
}

/** Write a host-scoped secret. Committed generation bearers are enrollment-owned. */
export function writeHostSecret(
  hostId: string,
  key: string,
  value: string,
  lockNamespace: PerUserLockNamespace = nativePerUserLockNamespace,
): void {
  withHostRegistryTransaction(lockNamespace, () => {
    const record = readHostRecordUnlocked(hostId);
    if (key === HOST_BEARER_SECRET && record?.bearer_generation !== undefined) {
      throw new Error(
        `Committed enrollment bearer for host ${hostId} can only be changed through enrollment.`,
      );
    }
    writeSecretFile(resolveHostDir(hostId), key, value, lockNamespace);
  });
}

export function createHostRegistryOperations(lockNamespace: PerUserLockNamespace) {
  return Object.freeze({
    readHostRegistry: () => readHostRegistry(lockNamespace),
    readHostMembershipSnapshots: () => readHostMembershipSnapshots(lockNamespace),
    reconcileHostRollbackBearers: () => reconcileHostRollbackBearers(lockNamespace),
    getHost: (hostId: string) => getHost(hostId, lockNamespace),
    getHostMembershipSnapshot: (hostId: string) =>
      getHostMembershipSnapshot(hostId, lockNamespace),
    reserveHostEnrollment: (hostId: string) =>
      reserveHostEnrollment(hostId, lockNamespace),
    releaseHostEnrollment: (reservation: HostEnrollmentReservation) =>
      releaseHostEnrollment(reservation, lockNamespace),
    advanceHostEnrollmentPhase: (
      reservation: HostEnrollmentReservation,
      phase: Exclude<HostEnrollmentPhase, 'teardown_pending'>,
    ) => advanceHostEnrollmentPhase(reservation, phase, lockNamespace),
    markHostEnrollmentTeardownPending: (reservation: HostEnrollmentReservation) =>
      markHostEnrollmentTeardownPending(reservation, lockNamespace),
    abandonHostEnrollment: (
      reservation: HostEnrollmentReservation,
    ) => abandonHostEnrollment(reservation, lockNamespace),
    persistEnrollmentMembership: (
      enrollment: EnrollmentHostRecord,
      bearer: string,
      reservation: HostEnrollmentReservation,
    ) => persistEnrollmentMembership(enrollment, bearer, reservation, lockNamespace),
    inspectHostMembershipForLeave: (
      hostId: string,
      lease: HostOperationLease,
    ) => inspectHostMembershipForLeave(hostId, lease, lockNamespace),
    retireHostMembership: (
      hostId: string,
      lease: HostOperationLease,
    ) => retireHostMembership(hostId, lease, lockNamespace),
    attachProject: (
      hostId: string,
      ref: AttachRef,
      mycoHome = resolveMycoHome(),
    ) => attachProject(hostId, ref, mycoHome, lockNamespace),
    recordHostProtocolVersion: (hostId: string, observedVersion: number) =>
      recordHostProtocolVersion(hostId, observedVersion, lockNamespace),
    detachProject: (hostId: string, projectId: string) =>
      detachProject(hostId, projectId, lockNamespace),
    resolveAttach: (projectId: string) => resolveAttach(projectId, lockNamespace),
    resolveAttachMembership: (projectId: string) =>
      resolveAttachMembership(projectId, lockNamespace),
    attachTargetGroveIds: () => attachTargetGroveIds(lockNamespace),
    attachTargetProjectIds: () => attachTargetProjectIds(lockNamespace),
    readHostSecrets: (hostId: string) => readHostSecrets(hostId, lockNamespace),
    writeHostSecret: (hostId: string, key: string, value: string) =>
      writeHostSecret(hostId, key, value, lockNamespace),
  });
}

export const hostRegistry = {
  readHostRegistry,
  readHostMembershipSnapshots,
  reconcileHostRollbackBearers,
  getHost,
  getHostMembershipSnapshot,
  reserveHostEnrollment,
  releaseHostEnrollment,
  advanceHostEnrollmentPhase,
  markHostEnrollmentTeardownPending,
  abandonHostEnrollment,
  persistEnrollmentMembership,
  inspectHostMembershipForLeave,
  retireHostMembership,
  attachProject,
  detachProject,
  resolveAttach,
  resolveAttachMembership,
  attachTargetGroveIds,
  attachTargetProjectIds,
  readHostSecrets,
  writeHostSecret,
};
