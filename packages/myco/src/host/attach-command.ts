/**
 * `myco attach <project> --host <hostId> --grove <groveId>` /
 * `myco detach <project>` — the operator surface that records (and clears) a
 * project's residency mapping in the machine-global attach registry.
 *
 * This is the A1 ship-path unblocker: `attachProject`/`detachProject`
 * (`host/registry.ts`) were reachable only from tests, so no project could
 * actually be attached to a host. This module is the missing caller. It is
 * attach-GOING-FORWARD only — it records the mapping so future requests route
 * to the host; it does NOT migrate existing local Grove data into the team
 * (that bidirectional `machine_id` outbox migration is task A2). A project that
 * still holds local Grove state is refused here (surfaced as "migration needed"),
 * never worked around — the never-materialize invariant stays intact.
 *
 * Identity resolution is grounded in what the routing chokepoint actually keys
 * on. `resolveInboundProjectId` (`grove/request-context.ts`) resolves a request's
 * project id from the committed `.myco/project.toml` `project.id`, and
 * `classifyRoute` feeds THAT id to `resolveAttach`. So the AttachRef's
 * `project_id` is read from the same manifest: recording the manifest id is what
 * makes the attach mapping and the routing key the same value end-to-end. The
 * `grove_id` (the host's Grove that serves the project) has no local source — the
 * affiliation hint carries only the host_id and a HostRecord stores no Grove
 * list — so it is a required flag the operator supplies from the host side.
 *
 * Pure orchestration over the registry's disk reads/writes; no daemon, no DB.
 */
import path from 'node:path';

import { loadProjectManifest } from '../config/project-manifest.js';
import { createFsDrainStore } from '../capture/transcript-drain.js';
import { createFsReplayStore } from '../capture/event-replay-drain.js';
import { createFsPlanDrainStore } from '../capture/plan-drain.js';
import { isGroveEraId } from '../grove/ids.js';
import { resolveMycoHome, resolveProjectVaultDir } from '../grove/paths.js';
import { teamHostHintFromManifest } from './hint.js';
import {
  attachProject,
  detachProject,
  getHost,
  ProjectAttachedToOtherHostError,
  ProjectRegisteredLocallyError,
  resolveAttach,
  type AttachRef,
} from './registry.js';

export interface AttachOptions {
  /** The `<project>` positional — a path to the local checkout (default cwd). */
  projectPath?: string;
  /** The joined host that will serve this project. Falls back to the manifest's
   *  Team Host affiliation hint (`grove.remote.remote_id`) when omitted. */
  hostId?: string;
  /** The host's Grove id that will serve this project. Required — no local source. */
  groveId?: string;
  /** Override the project id (default: the checkout's `.myco/project.toml`
   *  `project.id`, the same value the routing chokepoint keys on). */
  projectId?: string;
  /** MYCO_HOME override (tests). Threaded to the never-materialize local-row check. */
  mycoHome?: string;
}

export interface AttachResult {
  projectId: string;
  groveId: string;
  hostId: string;
  hostLabel: string;
  root: string;
  /** True when the project was already attached to this same host — the attach
   *  converged as a no-op (idempotent re-attach) rather than recording anew. */
  alreadyAttached: boolean;
  notes: string[];
}

export interface DetachOptions {
  projectPath?: string;
  projectId?: string;
}

export interface DetachResult {
  projectId: string;
  /** The host the project was detached from, or null when it was not attached
   *  (a clean no-op). */
  detachedFromHostId: string | null;
}

/** Resolve the routing project id for a checkout: the explicit override, else the
 *  committed manifest's `project.id`. Must be a well-formed `proj_<32hex>` — the
 *  same id the routing chokepoint keys `resolveAttach` on — or a clear error. */
function resolveProjectId(root: string, override: string | undefined): string {
  if (override) {
    if (!isGroveEraId(override, 'project')) {
      throw new Error(`--project-id must be a Grove project id (proj_<32 hex chars>), got ${JSON.stringify(override)}.`);
    }
    return override;
  }
  const manifest = loadProjectManifest(resolveProjectVaultDir(root));
  const manifestId = manifest?.project.id;
  if (manifestId && isGroveEraId(manifestId, 'project')) return manifestId;
  throw new Error(
    `Could not determine the project id for ${root}. Run this from a checkout with a committed `
    + '.myco/project.toml (its project.id is the routing key), or pass --project-id <proj_...>.',
  );
}

/**
 * Record a project's residency mapping: attach `(project → host, grove)` in the
 * machine-global registry so future requests route to the host. Idempotent — a
 * re-attach to the same host converges as a no-op. Attach-going-forward only:
 * a project that still has local Grove data is refused (migration is A2), and a
 * project already attached to a different host is refused.
 */
export function attachCommand(options: AttachOptions): AttachResult {
  const mycoHome = options.mycoHome ?? resolveMycoHome();
  const root = path.resolve(options.projectPath ?? '.');
  const projectId = resolveProjectId(root, options.projectId);

  const manifest = loadProjectManifest(resolveProjectVaultDir(root));
  const hostId = options.hostId?.trim() || teamHostHintFromManifest(manifest)?.host_id;
  if (!hostId) {
    throw new Error(
      'attach requires --host <hostId> (or a committed project.toml Team Host hint). '
      + 'It names the joined host that will serve this project.',
    );
  }
  const groveId = options.groveId?.trim();
  if (!groveId) {
    throw new Error(
      `attach requires --grove <groveId> — the id of the Grove on host ${hostId} that will serve this `
      + "project. The host's Grove id is not derivable locally; get it from the host operator or the "
      + "host's Groves page.",
    );
  }
  if (!isGroveEraId(groveId, 'grove')) {
    throw new Error(`--grove must be a Grove id (grove_<32 hex chars>), got ${JSON.stringify(groveId)}.`);
  }

  const host = getHost(hostId);
  if (!host) {
    throw new Error(
      `Unknown host ${hostId} — this machine has no host record for it. Join it first with `
      + `\`myco join ${hostId}\`, then attach.`,
    );
  }

  const notes: string[] = [];
  const existing = resolveAttach(projectId);
  const alreadyAttached = existing?.host.host_id === hostId;
  if (alreadyAttached && existing && existing.ref.grove_id !== groveId) {
    notes.push(
      `already attached to host ${hostId} under Grove ${existing.ref.grove_id}; keeping it `
      + `(re-attach converges — detach first to change the Grove to ${groveId}).`,
    );
  }

  const ref: AttachRef = { grove_id: groveId, project_id: projectId, root };
  try {
    attachProject(hostId, ref, mycoHome);
  } catch (err) {
    throw mapAttachError(err, hostId);
  }

  return {
    projectId,
    groveId: alreadyAttached && existing ? existing.ref.grove_id : groveId,
    hostId,
    hostLabel: host.label,
    root,
    alreadyAttached,
    notes,
  };
}

/**
 * Clear a project's residency mapping so future requests resolve local again.
 * Detach-only: it removes the mapping going forward and pulls back NO data
 * (the team → local re-materialization is A2). A no-op with a clear result when
 * the project is not attached anywhere.
 */
export function detachCommand(options: DetachOptions): DetachResult {
  const root = path.resolve(options.projectPath ?? '.');
  const projectId = resolveProjectId(root, options.projectId);

  const existing = resolveAttach(projectId);
  if (!existing) return { projectId, detachedFromHostId: null };

  detachProject(existing.host.host_id, projectId);
  // Purge-on-detach (capture-push §5.2, §5.5): drop this project's un-shipped
  // transcript-drain, plan-drain, AND live-event replay high-water entries for the
  // host it was attached to, so a re-attach starts clean and no stale entry holds
  // the machine awake via `hold.pending`. (The detached project's collector buffer
  // dir also stops being enumerated, since the drain reads the attach registry —
  // capture-push C5.)
  try {
    createFsDrainStore().purgeProject(existing.host.host_id, projectId);
    createFsPlanDrainStore().purgeProject(existing.host.host_id, projectId);
    createFsReplayStore().purgeProject(existing.host.host_id, projectId);
  } catch { /* best-effort machine-scoped cleanup — never block the detach */ }
  return { projectId, detachedFromHostId: existing.host.host_id };
}

/** Map the registry's typed attach refusals to actionable operator messages;
 *  pass anything else through unchanged. */
function mapAttachError(err: unknown, hostId: string): Error {
  if (err instanceof ProjectRegisteredLocallyError) {
    return new Error(
      `Cannot attach ${err.projectId}: it still has local Grove data (Grove ${err.groveId}). Adopting `
      + 'existing local history into a team host requires the residency-transition migration, which is '
      + 'not yet available (task A2). This command attaches a project going forward only — detach/migrate '
      + 'the project off its local Grove first.',
    );
  }
  if (err instanceof ProjectAttachedToOtherHostError) {
    return new Error(
      `Cannot attach ${err.projectId} to host ${err.attemptedHostId}: it is already attached to host `
      + `${err.existingHostId} (a project may be attached to only one host). Run \`myco detach\` for this `
      + 'project first if you mean to move it.',
    );
  }
  if (err instanceof Error && err.message.startsWith('Unknown host')) {
    return new Error(
      `Unknown host ${hostId} — this machine has no host record for it. Join it first with `
      + `\`myco join ${hostId}\`, then attach.`,
    );
  }
  return err instanceof Error ? err : new Error(String(err));
}
