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
import { createHash } from 'node:crypto';

import { HOST_BEARER_SECRET } from '@myco/constants.js';
import {
  readSecrets as readSecretsFile,
  writeSecret as writeSecretFile,
} from '@myco/config/secrets.js';
import {
  resolveHostsDir,
  resolveHostDir,
  resolveHostConfigPath,
  resolveMycoHome,
} from '@myco/grove/paths.js';
import { findRegisteredProjectById } from '@myco/grove/registry-resolve.js';
import { atomicWriteFileSync } from '@myco/utils/atomic-write.js';
import { withFileLockSync } from '@myco/utils/lifecycle-lock.js';
import { physicalPathLockIdentities } from '@myco/utils/physical-path-identity.js';
import { resolvePerUserLocksDir } from '@myco/utils/user-lock-root.js';

const HOST_REGISTRY_LOCK_DIR_MODE = 0o700;
const HOST_REGISTRY_LOCK_RETRIES = 8;
const HOST_REGISTRY_LOCK_NAMESPACE = 'hosts-registry';

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
  overlay_address: string;
  proxy_port?: number;
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
  served_grove_id?: string;
  created_at: string;
  projects: AttachRef[];
}

export type EnrollmentHostRecord = Omit<HostRecord, 'projects'>;

export interface EnrollmentMembershipResult {
  record: HostRecord;
  created: boolean;
}

interface HostRecordSnapshot {
  hostId: string;
  bytes: Buffer | null;
}

function hostRegistryLockPath(identity: string): string {
  const key = createHash('sha256')
    .update(`${HOST_REGISTRY_LOCK_NAMESPACE}\0${identity}`)
    .digest('hex');
  return path.join(resolvePerUserLocksDir(), 'host-membership', `${key}.lock`);
}

function hostRegistryLockPaths(): string[] {
  const lockDir = path.join(resolvePerUserLocksDir(), 'host-membership');
  fs.mkdirSync(lockDir, { recursive: true, mode: HOST_REGISTRY_LOCK_DIR_MODE });
  try { fs.chmodSync(lockDir, HOST_REGISTRY_LOCK_DIR_MODE); } catch { /* platform ACLs apply */ }
  return physicalPathLockIdentities(resolveHostsDir()).map(hostRegistryLockPath).sort();
}

function withHostRegistryTransaction<T>(fn: () => T): T {
  const RETRY = Symbol('retry-host-registry-locks');
  for (let attempt = 0; attempt < HOST_REGISTRY_LOCK_RETRIES; attempt += 1) {
    const locks = hostRegistryLockPaths();
    const run = (index: number): T | typeof RETRY => {
      if (index < locks.length) {
        return withFileLockSync(locks[index]!, () => run(index + 1));
      }
      const freshLocks = hostRegistryLockPaths();
      if (freshLocks.length !== locks.length
        || freshLocks.some((lock, index) => lock !== locks[index])) return RETRY;
      return fn();
    };
    const result = run(0);
    if (result !== RETRY) return result;
  }
  throw new Error('Host registry identity did not stabilize while acquiring locks');
}

/**
 * True when `value` has the minimum shape every reader below relies on
 * (`host_id` as a string, `projects` as an array) — the two fields
 * `resolveAttach`'s reverse lookup and every route-classification consumer
 * dereference unconditionally. A record that parses as valid JSON but fails
 * this check (hand-edited, truncated, or written by an incompatible future
 * version) is treated the same as unparseable JSON: skipped, not thrown,
 * since a single corrupt host.json must never 500 every consumer (groves
 * merge, status, health, hint) that reads across every host record.
 */
function isHostRecordShape(value: unknown): value is HostRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.host_id === 'string' && Array.isArray(record.projects);
}

/** Read every host record from the machine-global registry. Missing/unparseable files, and records that parse but fail the minimum HostRecord shape, are skipped, not thrown. */
export function readHostRegistry(): HostRecord[] {
  const hostsDir = resolveHostsDir();
  if (!fs.existsSync(hostsDir)) return [];
  const results: HostRecord[] = [];
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(hostsDir, { withFileTypes: true }); } catch { return []; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const configPath = path.join(hostsDir, entry.name, 'host.json');
    let parsed: unknown;
    try { parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8')); }
    catch { continue; /* missing/unparseable — skip */ }
    if (!isHostRecordShape(parsed)) continue; // valid JSON, wrong shape — skip
    results.push(parsed);
  }
  return results;
}

/** Read a single host record by id, or null if it doesn't exist / fails to parse. */
export function getHost(hostId: string): HostRecord | null {
  try { return JSON.parse(fs.readFileSync(resolveHostConfigPath(hostId), 'utf-8')) as HostRecord; }
  catch { return null; }
}

function writeHostRecordUnlocked(record: HostRecord): void {
  const hostDir = resolveHostDir(record.host_id);
  fs.mkdirSync(hostDir, { recursive: true });
  const configPath = resolveHostConfigPath(record.host_id);
  const tmpPath = configPath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(record, null, 2), 'utf-8');
  fs.renameSync(tmpPath, configPath);
}

/** Create or overwrite a host record. Atomic temp+rename write, same as `team/registry.ts` `save`. */
export function upsertHost(record: HostRecord): void {
  withHostRegistryTransaction(() => writeHostRecordUnlocked(record));
}

function snapshotHostRecordUnlocked(hostId: string): HostRecordSnapshot {
  try {
    return { hostId, bytes: fs.readFileSync(resolveHostConfigPath(hostId)) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { hostId, bytes: null };
    throw error;
  }
}

function restoreHostRecordUnlocked(snapshot: HostRecordSnapshot): void {
  const configPath = resolveHostConfigPath(snapshot.hostId);
  if (snapshot.bytes === null) {
    fs.rmSync(configPath, { force: true });
    return;
  }
  fs.mkdirSync(resolveHostDir(snapshot.hostId), { recursive: true });
  atomicWriteFileSync(configPath, snapshot.bytes);
}

function persistEnrollmentMembershipUnlocked(
  enrollment: EnrollmentHostRecord,
  bearer: string,
): EnrollmentMembershipResult {
  const previousRecord = snapshotHostRecordUnlocked(enrollment.host_id);
  const existing = getHost(enrollment.host_id);
  const record: HostRecord = {
    ...enrollment,
    served_grove_id: enrollment.served_grove_id ?? existing?.served_grove_id,
    created_at: existing?.created_at ?? enrollment.created_at,
    projects: existing?.projects ?? [],
  };
  try {
    writeHostRecordUnlocked(record);
    writeSecretFile(resolveHostDir(record.host_id), HOST_BEARER_SECRET, bearer);
  } catch (writeError) {
    try {
      restoreHostRecordUnlocked(previousRecord);
    } catch (rollbackError) {
      throw new AggregateError(
        [writeError, rollbackError],
        `Could not restore host record ${record.host_id} after bearer persistence failed.`,
      );
    }
    throw writeError;
  }
  return { record, created: existing === null };
}

/**
 * Persist enrollment metadata and bearer as one registry transaction.
 * Existing attachments and creation time are merged from a fresh in-lock read.
 */
export function persistEnrollmentMembership(
  enrollment: EnrollmentHostRecord,
  bearer: string,
): EnrollmentMembershipResult {
  return withHostRegistryTransaction(
    () => persistEnrollmentMembershipUnlocked(enrollment, bearer),
  );
}

/** Remove a host record, its attach refs, and its secrets.env (bearer). */
export function removeHost(hostId: string): void {
  withHostRegistryTransaction(
    () => fs.rmSync(resolveHostDir(hostId), { recursive: true, force: true }),
  );
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
): void {
  withHostRegistryTransaction(() => attachProjectUnlocked(hostId, ref, mycoHome));
}

function attachProjectUnlocked(
  hostId: string,
  ref: AttachRef,
  mycoHome: string,
): void {
  const record = getHost(hostId);
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
export function recordHostProtocolVersion(hostId: string, observedVersion: number): number {
  return withHostRegistryTransaction(
    () => recordHostProtocolVersionUnlocked(hostId, observedVersion),
  );
}

function recordHostProtocolVersionUnlocked(hostId: string, observedVersion: number): number {
  const record = getHost(hostId);
  if (!record) return observedVersion;
  if (!Number.isFinite(observedVersion) || observedVersion <= record.protocol_version) {
    return record.protocol_version;
  }
  writeHostRecordUnlocked({ ...record, protocol_version: observedVersion });
  return observedVersion;
}

/** Detach a project from a host. No-op if the host, or the attach ref, doesn't exist. */
export function detachProject(hostId: string, projectId: string): void {
  withHostRegistryTransaction(() => detachProjectUnlocked(hostId, projectId));
}

function detachProjectUnlocked(hostId: string, projectId: string): void {
  const record = getHost(hostId);
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
export function resolveAttach(projectId: string): { host: HostRecord; ref: AttachRef } | null {
  return resolveAttachUnlocked(projectId);
}

function resolveAttachUnlocked(projectId: string): { host: HostRecord; ref: AttachRef } | null {
  for (const record of readHostRegistry()) {
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
export function attachTargetGroveIds(): Set<string> {
  const ids = new Set<string>();
  for (const record of readHostRegistry()) {
    for (const ref of record.projects) ids.add(ref.grove_id);
  }
  return ids;
}

/**
 * The set of project ids that are attached to some host. A member daemon
 * consults this to skip attached projects in per-project scope iteration
 * regardless of which local Grove their (stale) registry row sits in — the
 * grove-level {@link attachTargetGroveIds} skip only covers rows in the
 * hosted Grove, not the leak shape where a local→attached project's row
 * lingers in the local default Grove.
 */
export function attachTargetProjectIds(): Set<string> {
  const ids = new Set<string>();
  for (const record of readHostRegistry()) {
    for (const ref of record.projects) ids.add(ref.project_id);
  }
  return ids;
}

/** Read all secrets (including the host bearer) for a host from its secrets.env. */
export function readHostSecrets(hostId: string): Record<string, string> {
  return readSecretsFile(resolveHostDir(hostId));
}

/** Write a host-scoped secret (e.g. the host bearer, `HOST_BEARER_SECRET`) to secrets.env. Never written to host.json. */
export function writeHostSecret(hostId: string, key: string, value: string): void {
  withHostRegistryTransaction(
    () => writeSecretFile(resolveHostDir(hostId), key, value),
  );
}

export const hostRegistry = {
  readHostRegistry,
  getHost,
  upsertHost,
  persistEnrollmentMembership,
  removeHost,
  attachProject,
  detachProject,
  resolveAttach,
  attachTargetGroveIds,
  attachTargetProjectIds,
  readHostSecrets,
  writeHostSecret,
};
