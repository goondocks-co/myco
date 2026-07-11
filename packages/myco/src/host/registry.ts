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

import {
  readSecrets as readSecretsFile,
  writeSecret as writeSecretFile,
} from '../config/secrets.js';
import {
  resolveHostsDir,
  resolveHostDir,
  resolveHostConfigPath,
  resolveMycoHome,
} from '../grove/paths.js';
import { findRegisteredProjectById } from '../grove/registry-resolve.js';

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
}

export interface HostRecord {
  host_id: string;
  label: string;
  overlay_address: string;
  proxy_port?: number;
  protocol_version: number;
  created_at: string;
  projects: AttachRef[];
}

/** Read every host record from the machine-global registry. Missing/unparseable files are skipped, not thrown. */
export function readHostRegistry(): HostRecord[] {
  const hostsDir = resolveHostsDir();
  if (!fs.existsSync(hostsDir)) return [];
  const results: HostRecord[] = [];
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(hostsDir, { withFileTypes: true }); } catch { return []; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const configPath = path.join(hostsDir, entry.name, 'host.json');
    try { results.push(JSON.parse(fs.readFileSync(configPath, 'utf-8')) as HostRecord); }
    catch { /* missing/unparseable — skip */ }
  }
  return results;
}

/** Read a single host record by id, or null if it doesn't exist / fails to parse. */
export function getHost(hostId: string): HostRecord | null {
  try { return JSON.parse(fs.readFileSync(resolveHostConfigPath(hostId), 'utf-8')) as HostRecord; }
  catch { return null; }
}

/** Create or overwrite a host record. Atomic temp+rename write, same as `team/registry.ts` `save`. */
export function upsertHost(record: HostRecord): void {
  const hostDir = resolveHostDir(record.host_id);
  fs.mkdirSync(hostDir, { recursive: true });
  const configPath = resolveHostConfigPath(record.host_id);
  const tmpPath = configPath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(record, null, 2), 'utf-8');
  fs.renameSync(tmpPath, configPath);
}

/** Remove a host record, its attach refs, and its secrets.env (bearer). */
export function removeHost(hostId: string): void {
  fs.rmSync(resolveHostDir(hostId), { recursive: true, force: true });
}

/**
 * Thrown by `attachProject` when `ref.project_id` is already attached to a
 * DIFFERENT host. Without this guard, `resolveAttach`'s reverse lookup over
 * `readHostRegistry()` (filesystem `readdirSync` order, not guaranteed)
 * would silently return whichever host happened to iterate first — the
 * same ambiguity `daemon/api/team-selection.ts`'s `project_in_other_team`
 * guard prevents for team membership. A future daemon transport (attach
 * command, Task 1.2+) should map this to a 409 `project_attached_to_other_host`.
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
 * backfills `ref.root` (see below) rather than a bare no-op. Throws if the
 * host is unknown, if the project still has a LOCAL Grove registry row (see
 * {@link ProjectRegisteredLocallyError}), or if the project is already
 * attached to a different host (see {@link ProjectAttachedToOtherHostError}).
 */
export function attachProject(
  hostId: string,
  ref: AttachRef,
  mycoHome = resolveMycoHome(),
): void {
  const record = getHost(hostId);
  if (!record) throw new Error(`Unknown host: ${hostId}`);

  const existingIdx = record.projects.findIndex((p) => p.project_id === ref.project_id);
  if (existingIdx !== -1) {
    // Already attached to THIS host — converges as a no-op EXCEPT for
    // `root`. Records created before `root` was added to `AttachRef` (or
    // whose checkout has since moved) sit forever without it unless a
    // re-attach backfills it — and `member-project-context.ts`'s
    // root-mismatch reconciliation silently skips any ref with no `root`
    // (`attach.ref.root && …`), so a stuck record never gets validated
    // against the caller's `project_root`. `grove_id` is deliberately NOT
    // refreshed here — `attachCommand` treats a Grove change on re-attach
    // as requiring an explicit detach first, and this function must not
    // silently move which Grove serves the project.
    const existingRef = record.projects[existingIdx];
    if (existingRef.root !== ref.root) {
      const projects = [...record.projects];
      projects[existingIdx] = { ...existingRef, root: ref.root };
      upsertHost({ ...record, projects });
    }
    return;
  }

  // Never-materialize invariant, enforced at the point of attach: refuse to
  // create an attach record while local Grove state exists for the project.
  const local = findRegisteredProjectById(ref.project_id, mycoHome);
  if (local) throw new ProjectRegisteredLocallyError(ref.project_id, local.grove.id);

  const existing = resolveAttach(ref.project_id);
  if (existing && existing.host.host_id !== hostId) {
    throw new ProjectAttachedToOtherHostError(ref.project_id, hostId, existing.host.host_id);
  }

  upsertHost({ ...record, projects: [...record.projects, ref] });
}

/** Detach a project from a host. No-op if the host, or the attach ref, doesn't exist. */
export function detachProject(hostId: string, projectId: string): void {
  const record = getHost(hostId);
  if (!record) return;
  upsertHost({ ...record, projects: record.projects.filter((p) => p.project_id !== projectId) });
}

/**
 * Reverse lookup: which host (if any) serves `projectId`, and the attach
 * ref that ties them together. The chokepoint every routing decision calls
 * (member-side `classifyRoute`, client-side `ensureProjectRegistered`) —
 * a pure disk read across every host record, no daemon, no DB.
 */
export function resolveAttach(projectId: string): { host: HostRecord; ref: AttachRef } | null {
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
  writeSecretFile(resolveHostDir(hostId), key, value);
}

export const hostRegistry = {
  readHostRegistry,
  getHost,
  upsertHost,
  removeHost,
  attachProject,
  detachProject,
  resolveAttach,
  attachTargetGroveIds,
  attachTargetProjectIds,
  readHostSecrets,
  writeHostSecret,
};
