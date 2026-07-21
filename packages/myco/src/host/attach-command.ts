/**
 * `myco attach <project> --host <hostId>` / `myco detach <project>` — the
 * operator surface that records (and clears) a project's residency mapping in
 * the machine-global attach registry.
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
 * makes the attach mapping and the routing key the same value end-to-end.
 *
 * `grove_id` (server-mode design spec §2): a host serves exactly ONE designated
 * Grove, self-reported at enrollment and persisted on the joined `HostRecord`
 * (`served_grove_id`, `host/member-overlay.ts` `joinHost` step 8). There is no
 * operator-typed `--grove` flag anymore — the member never types a grove id; a
 * host that predates served-grove designation (its enrollment carried no
 * `served_grove_id`) refuses attach with the stable `host_predates_served_grove`
 * membership code (`membership-error.ts`) rather than falling back to an
 * unverifiable flag.
 *
 * `local_grove_id` (E-4 local-view requirement, decision-ef693c71) is a SEPARATE
 * Grove concept from `grove_id` above: the member's own LOCAL Grove the attached
 * project displays under, not the host's served Grove. An explicit member choice,
 * resolved (and validated, or defaulted via a pure read) once here at attach time
 * — see `resolveLocalGroveId`.
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
import { loadGroveRecord, resolveDefaultGrove } from '../grove/registry.js';
import { teamHostHintFromManifest } from './hint.js';
import { codedMembershipError } from './membership-error.js';
import {
  attachProject,
  detachProject,
  getHost,
  ProjectAttachedToOtherHostError,
  ProjectRegisteredLocallyError,
  resolveAttach,
  type AttachRef,
  type HostRecord,
} from './registry.js';
import { residencyTransitionInFlight } from './residency-journal.js';

export interface AttachOptions {
  /** The `<project>` positional — a path to the local checkout (default cwd). */
  projectPath?: string;
  /** The joined host that will serve this project. Falls back to the manifest's
   *  Team Host affiliation hint (`grove.remote.remote_id`) when omitted. */
  hostId?: string;
  /** Override the project id (default: the checkout's `.myco/project.toml`
   *  `project.id`, the same value the routing chokepoint keys on). */
  projectId?: string;
  /** The member's own LOCAL Grove to display this project under (E-4
   *  local-view requirement, decision-ef693c71) — an explicit member choice,
   *  never inferred. Omitted: defaults to the machine's current default
   *  Grove via a pure read (never `ensureDefaultGrove`). No CLI flag
   *  surfaces this in v1 — only the daemon API attach body
   *  (`daemon/api/host-membership.ts`) accepts it; a CLI-originated attach
   *  always omits it and gets the same default. */
  localGroveId?: string;
  /** MYCO_HOME override (tests). Threaded to the never-materialize local-row check. */
  mycoHome?: string;
  /**
   * DAEMON-ONLY injection (Phase F): run the residency transition when the
   * project still has local Grove data, instead of refusing. The daemon attach
   * handler (`daemon/api/host-membership.ts`) wires this to the DB-backed
   * transition (`host/residency-transition.ts`); a CLI/in-process caller that
   * omits it gets the coded `project_registered_locally` refusal, since it has
   * no daemon-owned DB to move the rows with.
   */
  beginResidency?: BeginResidencyAttach;
}

/**
 * Everything the residency transition needs to begin, handed over when a
 * with-history attach is detected. `host` carries the resolved
 * `served_grove_id` (the divert target); `sourceGroveId` is the local Grove the
 * project is moving off.
 */
export interface ResidencyAttachContext {
  hostId: string;
  host: HostRecord;
  projectId: string;
  sourceGroveId: string;
  root: string;
  localGroveId?: string;
  mycoHome: string;
}

export type BeginResidencyAttach = (ctx: ResidencyAttachContext) => AttachResult;

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

/** Resolve+validate the LOCAL Grove `local_grove_id` should record (E-4
 *  local-view requirement). An explicit id must name an existing local
 *  Grove or attach refuses with the coded `unknown_local_grove` membership
 *  error, before anything is written. Omitted: resolves the machine's
 *  current default Grove via a PURE read (`resolveDefaultGrove` — never
 *  `ensureDefaultGrove`), so calling this never has a side effect on the
 *  local Grove registry. In the (bootstrap-only) case where the machine has
 *  no default Grove yet, this does NOT fail the attach — it returns
 *  `undefined`, leaving `local_grove_id` unset exactly like a legacy ref;
 *  `resolveAttachRefHomeGroveId` (`grove/registry.ts`) re-resolves it at
 *  read time once a default Grove exists. */
function resolveLocalGroveId(explicit: string | undefined, mycoHome: string): string | undefined {
  if (explicit) {
    const grove = loadGroveRecord(explicit, mycoHome);
    if (!grove) {
      throw codedMembershipError(
        'unknown_local_grove',
        `Unknown local Grove ${explicit} — this machine has no Grove with that id. Pass an existing local `
        + 'Grove id, or omit local_grove_id to use the machine\'s default Grove.',
      );
    }
    return grove.id;
  }
  return resolveDefaultGrove(mycoHome)?.id;
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

  // A live residency journal means a transition is already underway for this
  // project (attach or detach). Starting a second one would race the first; the
  // running transition (or a `residency abort`) is how it resolves.
  if (residencyTransitionInFlight(projectId)) {
    throw codedMembershipError(
      'residency_transition_in_flight',
      `Cannot attach ${projectId}: a residency transition is already in flight for it. Let it finish (or `
      + 'abort it) before attaching again.',
    );
  }

  const manifest = loadProjectManifest(resolveProjectVaultDir(root));
  const hostId = options.hostId?.trim() || teamHostHintFromManifest(manifest)?.host_id;
  if (!hostId) {
    throw new Error(
      'attach requires --host <hostId> (or a committed project.toml Team Host hint). '
      + 'It names the joined host that will serve this project.',
    );
  }

  const host = getHost(hostId);
  if (!host) {
    throw codedMembershipError(
      'not_joined',
      `Unknown host ${hostId} — this machine has no host record for it. Join it first with `
      + `\`myco join ${hostId}\`, then attach.`,
    );
  }

  // The Grove comes from the host's own self-report (`served_grove_id`,
  // learned at join) — never a typed flag. A host that predates served-grove
  // designation carries no value here; attach has nothing to source a Grove
  // from and refuses rather than guessing.
  const groveId = host.served_grove_id;
  if (!groveId) {
    throw codedMembershipError(
      'host_predates_served_grove',
      `Host ${hostId} predates served-grove designation; update the host (run \`myco update\` on that `
      + 'machine, then re-enable Team Host serving) and re-join with '
      + `\`myco join ${hostId}\`, then retry attach.`,
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

  const localGroveId = resolveLocalGroveId(options.localGroveId, mycoHome);
  const ref: AttachRef = { grove_id: groveId, project_id: projectId, root, local_grove_id: localGroveId };
  try {
    attachProject(hostId, ref, mycoHome);
  } catch (err) {
    // With-history attach (Phase F, D-F-1): a project that still holds local
    // Grove data is no longer refused — the daemon runs the residency
    // transition (backup, then move) instead. Only the daemon injects
    // `beginResidency`; without it (a CLI/in-process caller with no DB) the
    // mapped refusal stands.
    if (err instanceof ProjectRegisteredLocallyError && options.beginResidency) {
      return options.beginResidency({
        hostId,
        host,
        projectId: err.projectId,
        sourceGroveId: err.groveId,
        root,
        localGroveId,
        mycoHome,
      });
    }
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

  // A live residency journal means a transition is already underway (attach or
  // detach); refuse rather than race it.
  if (residencyTransitionInFlight(projectId)) {
    throw codedMembershipError(
      'residency_transition_in_flight',
      `Cannot detach ${projectId}: a residency transition is already in flight for it. Let it finish (or `
      + 'abort it) before detaching.',
    );
  }

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
 *  pass anything else through unchanged. Each mapped error carries a stable
 *  `membershipCode` (see `membership-error.ts`) so the daemon API can put a
 *  machine-readable code on the wire while the message stays CLI-voiced —
 *  the Team page maps the code to its own outcome copy instead of rendering
 *  "run `myco detach`" prose in a browser that has a Detach button. */
function mapAttachError(err: unknown, hostId: string): Error {
  if (err instanceof ProjectRegisteredLocallyError) {
    return codedMembershipError(
      'project_registered_locally',
      `Cannot attach ${err.projectId}: it still has local Grove data (Grove ${err.groveId}). Moving existing `
      + 'local history onto a team host runs as a residency transition, which the daemon performs — attach '
      + 'through the running daemon (the Team page, or `myco attach` with the daemon up) rather than in a '
      + 'context with no daemon-owned database.',
    );
  }
  if (err instanceof ProjectAttachedToOtherHostError) {
    return codedMembershipError(
      'project_attached_to_other_host',
      `Cannot attach ${err.projectId} to host ${err.attemptedHostId}: it is already attached to host `
      + `${err.existingHostId} (a project may be attached to only one host). Run \`myco detach\` for this `
      + 'project first if you mean to move it.',
    );
  }
  if (err instanceof Error && err.message.startsWith('Unknown host')) {
    return codedMembershipError(
      'not_joined',
      `Unknown host ${hostId} — this machine has no host record for it. Join it first with `
      + `\`myco join ${hostId}\`, then attach.`,
    );
  }
  return err instanceof Error ? err : new Error(String(err));
}
