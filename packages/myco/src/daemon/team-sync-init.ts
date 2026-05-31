/**
 * Team sync initialization.
 *
 * Extracted from main.ts — creates the TeamSyncClient from saved config,
 * registers the node, backfills unsynced records, and exposes the outbox
 * flush power job.
 *
 * ## team_members trust model (audited 2026-05-17, Bucket H.6)
 *
 * The local SQLite `team_members` table is SELF-ONLY: the only write path
 * on the daemon side is `upsertSelfMember(machineId, ...)` in
 * `db/queries/team-members.ts`, called from `reconcileSelfMember` below.
 * That call hard-codes `id = machineId = user = machine_id`, so a row in
 * the local table is by construction a self-record (or a row legacy users
 * inserted by hand pre-team-sync, which is treated as opaque).
 *
 * Peers never INSERT into this table on our local DB. The outbound flow
 * pushes the self row to the cloud Worker via `enqueueOutbox`; the Worker
 * stores per-machine rows in its own D1 instance for cross-machine
 * directory queries. Inbound from the Worker is read-only — the
 * `/api/team/members` daemon endpoint (`api/team-members.ts`) selects
 * locally; cross-team listing happens via search APIs that return data
 * shaped from D1, never INSERTing into the local SQLite.
 *
 * The reviewer's concern — "a peer-claimed row whose machine_id doesn't
 * match the sender" — would only apply if we accepted peer rows into the
 * local table. We don't. If a future change introduces an inbound
 * write path (e.g. team-roster sync), the validator MUST live there at
 * the write site (reject rows where `payload.machine_id !== sender.machine_id`,
 * reject rows where `payload.id !== payload.machine_id`, etc.) and this
 * docblock MUST be updated to point at it.
 */

import type { DaemonLogger } from './logger.js';
import type { MycoConfig } from '@myco/config/schema.js';
import type { PowerManager } from './power.js';
import { TeamSyncClient, type VersionCompat } from './team-sync.js';
import {
  listPending,
  markSent,
  markSourceRowsSynced,
  pruneOld,
  backfillUnsynced,
  backfillAllForRebuild,
  discardRows,
  countPending,
  countPendingByTable,
  purgePendingOutbox,
} from '@myco/db/queries/team-outbox.js';
import { upsertSelfMember } from '@myco/db/queries/team-members.js';
import { setTeamSyncEnabled } from '@myco/db/queries/team-sync-state.js';
import {
  SYNC_PROTOCOL_VERSION,
  TEAM_API_KEY_SECRET,
  TEAM_MCP_TOKEN_SECRET,
  epochSeconds,
} from '@myco/constants.js';
import { LOG_KINDS } from '@myco/constants/log-kinds.js';
import type { MycoRequestContext } from '@myco/tools/request-context.js';
import type { GroveRuntimeCache } from './grove-runtime-cache.js';
import { forEachGrove } from './scope-iteration.js';
import { withDatabase, getDatabase } from '@myco/db/client.js';
import { teamRegistry } from '@myco/team/registry.js';
import type { OutboxRow } from '@myco/db/queries/team-outbox.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TeamSyncDeps {
  // Holder so the flush job and client reconciliation both read the current
  // value of team settings and can hot-reload team sync without a daemon
  // restart.
  liveConfig: { current: MycoConfig };
  machineId: string;
  logger: DaemonLogger;
  vaultDir: string;
  serverVersion: string;
  /** The current daemon's service dir; passed through to `forEachGrove` to enforce the served-by boundary. */
  daemonStateDir: string;
  requestContext?: MycoRequestContext;
}

export interface TeamSyncResult {
  getTeamClient: (requestContext?: MycoRequestContext) => TeamSyncClient | null;
  /** Resolve (and cache) a client directly by team_id, bypassing project context. */
  getTeamClientById: (teamId: string) => TeamSyncClient | null;
  reconcileClient: (requestContext?: MycoRequestContext) => Promise<void>;
  flushPending: (requestContext?: MycoRequestContext) => Promise<TeamFlushResult>;
  /**
   * One-way repair: truncate THIS machine's cloud mirror, then re-push every
   * local row. Replaces the retired /verify drift reconciler.
   */
  rebuildFromLocal: (requestContext?: MycoRequestContext) => Promise<TeamFlushResult>;
  /**
   * Run flushPending across every registered Grove. Each Grove's outbox
   * lives in its own SQLite DB, so this fans out via `forEachGrove` and
   * scopes `getDatabase()` to the per-Grove handle inside each iteration.
   * Errors are isolated per Grove. Returns the aggregate per-Grove summary.
   */
  flushAllGroves: (cache: GroveRuntimeCache) => Promise<TeamFlushAggregate>;
  /**
   * Reconcile team_sync_state.enabled for every registered Grove at boot.
   * At boot only the boot Grove's flag is set (via reconcileClient()). Non-boot
   * Groves' flags stay at their persisted default until their first flush tick —
   * a window where deletes on those Groves are not journaled. This fans out the
   * flag write (no push, no client) so all Groves start the session in lockstep.
   */
  reconcileAllGroveFlags: (cache: GroveRuntimeCache) => Promise<void>;
  registerFlushJob: (powerManager: PowerManager, cache: GroveRuntimeCache) => void;
}

export interface TeamFlushResult {
  handedOff: number;
  rejected: number;
  batches: number;
  error?: string;
}

export interface TeamFlushAggregate {
  groves: number;
  flushed: number;
  rejected: number;
  batches: number;
  errors: number;
}

// ---------------------------------------------------------------------------
// Config-seed planner
// ---------------------------------------------------------------------------

/**
 * Decide which `/config` PUT bodies are needed to bring the worker's config
 * up to the worker-authoritative contract. Each entry is a separate PUT so a
 * missing `team_id` never clobbers an already-set `team_name`.
 */
export function planConfigSeed(
  existing: Record<string, unknown> | null | undefined,
  desired: { teamId: string; teamName: string; createdBy: string; createdAt: string },
): Record<string, string>[] {
  const has = (k: string) => {
    const v = existing?.[k];
    return typeof v === 'string' && v.trim().length > 0;
  };
  const puts: Record<string, string>[] = [];
  if (!has('team_id')) puts.push({ team_id: desired.teamId });
  if (!has('team_name')) {
    puts.push({
      team_name: desired.teamName,
      embedding_model: '@cf/baai/bge-m3',
      embedding_dimensions: '1024',
      created_at: desired.createdAt,
      created_by: desired.createdBy,
    });
  }
  return puts;
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

export function initTeamSync(deps: TeamSyncDeps): TeamSyncResult {
  const { machineId, logger, daemonStateDir, requestContext: defaultRequestContext } = deps;

  /**
   * The team registry — not the legacy grove-config `enabled` flag — is the
   * push-side participation gate: a Grove syncs iff ≥1 of its projects is a
   * member of some team. Used by the write-path gate (setTeamSyncEnabled), the
   * stale-outbox purge, and the deep-sleep predicate so they all agree with the
   * registry-driven drain (flushPending). The grove-config flag is now only the
   * read/rebuild client's concern.
   */
  function groveParticipates(groveId: string | null): boolean {
    return participatingTeamIds(groveId).length > 0;
  }

  function participatingTeamIds(groveId: string | null): string[] {
    if (!groveId) return [];
    return [
      ...new Set(
        teamRegistry
          .list()
          .filter((t) => t.projects.some((p) => p.grove_id === groveId))
          .map((t) => t.team_id),
      ),
    ];
  }

  function teamIdsForRebuild(requestContext?: MycoRequestContext): string[] {
    const projectId = requestContext?.projectId;
    if (projectId) {
      const teamId = teamRegistry.membershipByProject().get(projectId);
      if (teamId) return [teamId];
    }
    return participatingTeamIds(requestContext?.groveId ?? null);
  }

  // Per-team client cache (registry-driven routing). flushPending routes each
  // outbox row to its owning team's worker, so clients are keyed by team_id —
  // the registry is the only runtime source of Team connectivity. Rebuilt when
  // the team's worker_url or API key changes.
  const teamRouteClients = new Map<string, TeamSyncClient>();
  const teamRouteSignatures = new Map<string, string>();
  // Teams whose worker is fully provisioned this daemon lifetime (MCP token in
  // the registry + /config seeded). ensureTeamProvisioned short-circuits on a
  // hit so a large backfill doesn't re-GET /config on every flush tick. Only
  // set when BOTH halves succeed, so a transiently-unreachable worker retries.
  const provisionedTeams = new Set<string>();

  // Per-team version-compat cache (TTL-bounded). The drain gate probes the
  // worker's advertised bounds via health() before pushing; back-to-back flush
  // ticks during a large backfill must not re-probe every tick, so a successful
  // probe is cached for VERSION_CHECK_TTL_SEC. checkedAt is epoch SECONDS.
  const teamVersionCache = new Map<string, { status: VersionCompat; checkedAt: number }>();
  const VERSION_CHECK_TTL_SEC = 60;

  /**
   * Resolve a team's sync-protocol compatibility, caching the result for
   * VERSION_CHECK_TTL_SEC. A `health()` failure (worker unreachable) is treated
   * as transient → 'unknown', so the normal drain attempt still runs and the
   * usual unreachable-team handling (leave rows pending) applies. Only an
   * advertised hard incompatibility ('client_too_old' / 'worker_too_old')
   * blocks the drain.
   */
  async function teamVersionStatus(teamId: string, client: TeamSyncClient): Promise<VersionCompat> {
    const cached = teamVersionCache.get(teamId);
    const now = epochSeconds();
    if (cached && now - cached.checkedAt < VERSION_CHECK_TTL_SEC) return cached.status;
    let status: VersionCompat;
    try {
      await client.health();
      status = client.getVersionCompat();
    } catch {
      status = 'unknown';
    }
    teamVersionCache.set(teamId, { status, checkedAt: now });
    return status;
  }

  /**
   * Lazily build (and cache) the TeamSyncClient for a given team_id from the
   * team registry. Returns null when the team is unknown, has no worker_url,
   * or has no API key — callers must treat null as "skip this team this tick"
   * (leave its rows pending for retry), never as "drop the rows".
   */
  function getOrBuildTeamClient(teamId: string): TeamSyncClient | null {
    const team = teamRegistry.get(teamId);
    if (!team?.worker_url) return null;
    const secrets = teamRegistry.readSecrets(teamId);
    const key = secrets[TEAM_API_KEY_SECRET];
    if (!key) return null;
    const mcpToken = secrets[TEAM_MCP_TOKEN_SECRET] || undefined;

    // Include the MCP token in the signature so the cached client rebuilds
    // when ensureTeamProvisioned writes a freshly-rotated token to the
    // registry — without this the read path keeps a client with a stale
    // (null) token until the next worker_url/key change.
    const signature = `${team.worker_url}|${key.slice(0, 8)}|${mcpToken ? mcpToken.slice(0, 8) : ''}`;
    const existing = teamRouteClients.get(teamId);
    if (existing && teamRouteSignatures.get(teamId) === signature) {
      return existing;
    }

    const client = new TeamSyncClient({
      workerUrl: team.worker_url,
      apiKey: key,
      machineId,
      syncProtocolVersion: SYNC_PROTOCOL_VERSION,
      mcpToken,
    });
    teamRouteClients.set(teamId, client);
    teamRouteSignatures.set(teamId, signature);
    return client;
  }

  /**
   * Idempotently provision a team's worker on first successful reach:
   *   - Rotate + persist the Cloud MCP token into the registry if absent.
   *   - Seed `/config` (team_name + embedding model/dimensions) if unset.
   *
   * Runs at most once per team per daemon lifetime: a `provisionedTeams` guard
   * short-circuits subsequent calls so a large backfill doesn't re-GET /config
   * on every flush tick. Both halves are non-fatal — a briefly unreachable
   * worker leaves the team un-guarded so the next flush retries. Mirrors the
   * install-path PUT in myco-team/src/cli.ts.
   */
  async function ensureTeamProvisioned(teamId: string): Promise<void> {
    if (provisionedTeams.has(teamId)) return;
    const client = getOrBuildTeamClient(teamId);
    if (!client) return;

    // 1. MCP token — rotate + persist into the registry when missing.
    let tokenOk = false;
    try {
      const existingToken = teamRegistry.readSecrets(teamId)[TEAM_MCP_TOKEN_SECRET];
      if (!existingToken) {
        const token = await client.rotateMcpToken();
        teamRegistry.writeSecret(teamId, TEAM_MCP_TOKEN_SECRET, token);
        logger.info(LOG_KINDS.TEAM_SYNC_START, 'Provisioned team MCP token in registry', { team_id: teamId });
      }
      tokenOk = true;
    } catch (err) {
      logger.warn(LOG_KINDS.TEAM_SYNC_ERROR, 'Team MCP token provisioning failed (will retry next tick)', {
        team_id: teamId,
        error: (err as Error).message,
      });
    }

    // 2. /config — seed team_id + team_name/embedding when the worker lacks them.
    let configOk = false;
    try {
      const cfg = await client.getConfig().catch(() => null);
      const puts = planConfigSeed(cfg?.config, {
        teamId,
        teamName: teamRegistry.get(teamId)?.name ?? '',
        createdBy: machineId,
        createdAt: String(epochSeconds()),
      });
      for (const body of puts) {
        await client.putConfig(body);
      }
      if (puts.length > 0) {
        logger.info(LOG_KINDS.TEAM_SYNC_START, 'Seeded team /config on worker', { team_id: teamId, keys: puts.flatMap((p) => Object.keys(p)) });
      }
      configOk = true;
    } catch (err) {
      logger.warn(LOG_KINDS.TEAM_SYNC_ERROR, 'Team /config seed failed (will retry next tick)', {
        team_id: teamId,
        error: (err as Error).message,
      });
    }

    // Guard only when fully provisioned; a partial failure retries next flush.
    if (tokenOk && configOk) provisionedTeams.add(teamId);
  }

  function reconcileSelfMember(): void {
    try {
      const nowSec = epochSeconds();
      const joinedIso = new Date(nowSec * 1000).toISOString();
      // Wrap upsert + enqueue in a single SQLite transaction. Without
      // this, a crash (or enqueueOutbox throw) between INSERT OR IGNORE
      // returning changes=1 and the enqueue call would leave the
      // team_members row inserted but never queued — and because the
      // upsert is idempotent, every subsequent reconnect reports
      // inserted=false and skips the enqueue forever. The self member
      // would be permanently invisible to peers. Transaction rollback
      // restores the pre-insert state so the next call retries cleanly.
      let inserted = false;
      getDatabase().transaction(() => {
        const result = upsertSelfMember(machineId, joinedIso);
        inserted = result.inserted;
      })();
      if (inserted) {
        logger.info(LOG_KINDS.TEAM_SYNC_START, 'Self team_members row reconciled', {
          machine_id: machineId,
        });
      }
    } catch (err) {
      logger.warn(LOG_KINDS.TEAM_SYNC_ERROR, 'Self team_members reconcile failed', {
        error: (err as Error).message,
      });
    }
  }

  /**
   * Drain this Grove's outbox, routing each row to the worker of the team
   * that owns its project.
   *
   * The team registry — not the Grove config — is now the participation gate:
   * a Grove syncs iff at least one of its projects is a member of some team.
   * Each pending row carries `project_id` (set by `syncRow` / backfill):
   *
   *   - `project_id` is set but belongs to no team  → DROP (markSent so it
   *     clears; a future `add` + backfill re-syncs it). Must NOT sync.
   *   - `project_id` is set and belongs to a team   → route to that team.
   *   - `project_id` is null (machine-scoped, e.g.    → fan out to EVERY team
   *     team_members)                                  this machine has joined
   *                                                    (every registered team),
   *                                                    regardless of project
   *                                                    assignment; DROP if no
   *                                                    team is registered at all.
   *
   * A fanned-out row is only `markSent` once ALL its target teams accept it;
   * if any target's client is unbuilt/failed this tick the row stays pending
   * for the next tick. Per-team batches whose client can't be built are left
   * pending too (team unreachable/unconfigured) — never dropped.
   *
   * The drain only short-circuits when this machine has joined NO team at all
   * (`teamRegistry.list()` empty → nothing to sync anywhere). A machine that
   * has joined a team but assigned no project to this Grove still drains its
   * machine-scoped self row to that team's worker, so a just-joined teammate
   * appears in the Members roster before assigning any project.
   */
  async function flushPending(requestContext = defaultRequestContext): Promise<TeamFlushResult> {
    const result: TeamFlushResult = { handedOff: 0, rejected: 0, batches: 0 };

    const groveId = requestContext?.groveId ?? null;
    const teams = teamRegistry.list();
    const participates = groveParticipates(groveId);
    // The registry is now the write-path gate: keep delete triggers + syncRow
    // in lockstep with whether this Grove feeds any team via project membership,
    // every tick. (Machine-scoped self rows reach the outbox through
    // backfillUnsynced, which bypasses this flag, so a joined-no-project Grove
    // still queues its self row.)
    setTeamSyncEnabled(participates);
    // Short-circuit only when this machine has joined no team at all — there is
    // nowhere to route any row. With ≥1 registered team we must still drain
    // machine-scoped rows even if no project participates.
    if (teams.length === 0) return result;

    const map = teamRegistry.membershipByProject();
    // Machine-scoped (null project_id) rows fan out to every team this machine
    // has joined, not just the teams with a project assigned to this Grove.
    const machineScopedTargetTeamIds = teams.map((t) => t.team_id);

    // Teams whose batch handed off cleanly this flush. After the drain loop we
    // provision each exactly once (rotate + persist the MCP token, seed
    // /config) — the worker is provably reachable, and the checks inside
    // ensureTeamProvisioned make it cheap/no-op once already provisioned.
    const handedOffTeams = new Set<string>();

    while (true) {
      const pending = listPending();
      if (pending.length === 0) break;

      const now = epochSeconds();

      // Partition: rows whose project belongs to no team are dropped (cleared
      // so they don't pin the buffer forever); the rest are bucketed per team.
      const dropIds: number[] = [];
      const batches = new Map<string, OutboxRow[]>();
      // For fan-out (null project_id) rows, track how many teams must accept
      // before we markSent — keyed by outbox id.
      const fanOutTargetsRemaining = new Map<number, number>();

      const pushToTeam = (teamId: string, row: OutboxRow): void => {
        const list = batches.get(teamId);
        if (list) list.push(row);
        else batches.set(teamId, [row]);
      };

      for (const row of pending) {
        if (row.project_id != null) {
          // Project-scoped row: route to the team that owns the project, or
          // DROP if the project belongs to no registered team.
          if (!map.has(row.project_id)) {
            dropIds.push(row.id);
            continue;
          }
          pushToTeam(map.get(row.project_id)!, row);
        } else if (machineScopedTargetTeamIds.length === 0) {
          // Machine-scoped row with no team to route to. teams.length === 0 is
          // already handled by the early return above, so this is defensive —
          // DROP (markSent) so it doesn't pin the buffer forever.
          dropIds.push(row.id);
        } else {
          // Machine-scoped row: fan out a copy into every team this machine has
          // joined (every registered team), regardless of project assignment.
          fanOutTargetsRemaining.set(row.id, machineScopedTargetTeamIds.length);
          for (const teamId of machineScopedTargetTeamIds) {
            pushToTeam(teamId, row);
          }
        }
      }

      if (dropIds.length > 0) {
        // markSent (not discard): a future `add` + backfill re-syncs these if
        // the project later joins a team. Leaving them pending would pin the
        // buffer forever.
        markSent(dropIds, now);
      }

      // Track fan-out rows whose target teams all accepted this tick so we can
      // markSent them once (not once per team).
      const fanOutAccepted = new Set<number>();

      // Count of outbox rows that left the pending set this tick (dropped,
      // discarded, or handed off). A tick that clears zero rows means every
      // remaining row's target team is unbuildable/failed — break to avoid a
      // hot spin loop and retry next tick. A tick that clears ≥1 row strictly
      // shrinks the pending set, so the loop terminates.
      let clearedThisTick = dropIds.length;
      let tickError: string | undefined;

      for (const [teamId, rows] of batches) {
        const client = getOrBuildTeamClient(teamId);
        if (!client) {
          // Team unreachable/unconfigured: leave its rows pending for retry.
          // Fan-out rows targeting this team stay pending too — a partial
          // fan-out must never be marked sent.
          continue;
        }

        // Version-floor obedience: if the worker advertises bounds that make
        // this daemon's protocol incompatible, STOP draining to it. Doomed
        // pushes would just trigger the worker's 409 and churn forever. Leave
        // the rows pending (no markSent, no discard) so the team self-heals
        // the moment the daemon or worker updates. 'ok'/'unknown' fall through
        // to the normal enqueue ('unknown' = bounds unprobed → let the drain
        // attempt surface the real network/auth state).
        const compat = await teamVersionStatus(teamId, client);
        if (compat === 'client_too_old' || compat === 'worker_too_old') {
          logger.warn(
            LOG_KINDS.TEAM_SYNC_ERROR,
            'Skipping team drain — sync protocol incompatible (rows left pending for retry after update)',
            {
              team_id: teamId,
              compat,
              daemon_protocol: SYNC_PROTOCOL_VERSION,
              worker_protocol: client.getWorkerProtocolVersion(),
              worker_min_client: client.getWorkerMinClientVersion(),
            },
          );
          continue; // leave rows pending — NO churn, NO dead-letter; self-heals on update
        }

        try {
          logger.info(LOG_KINDS.TEAM_SYNC_START, 'Flushing outbox', { team_id: teamId, count: rows.length });
          const enqueueResult = await client.enqueueBatch(rows);

          const rejectedKeys = new Set(enqueueResult.rejected.map((e) => rejectionKey(e.table, e.id)));
          const rejectedOutboxIds: number[] = [];
          const handedOff: OutboxRow[] = [];
          for (const row of rows) {
            if (rejectedKeys.has(rejectionKey(row.table_name, row.row_id))) {
              rejectedOutboxIds.push(row.id);
            } else {
              handedOff.push(row);
            }
          }

          if (rejectedOutboxIds.length > 0) {
            logger.warn(LOG_KINDS.TEAM_SYNC_REJECTED, `Discarding ${rejectedOutboxIds.length} rejected records`, {
              team_id: teamId,
              rejected: enqueueResult.rejected.slice(0, 5),
            });
            discardRows(rejectedOutboxIds);
            result.rejected += rejectedOutboxIds.length;
            clearedThisTick += rejectedOutboxIds.length;
          }

          // Split accepted rows into single-team (markSent now) vs fan-out
          // (markSent only once every target team has accepted).
          const directHandedOff: OutboxRow[] = [];
          for (const row of handedOff) {
            if (fanOutTargetsRemaining.has(row.id)) {
              const remaining = (fanOutTargetsRemaining.get(row.id) ?? 0) - 1;
              fanOutTargetsRemaining.set(row.id, remaining);
              if (remaining <= 0) fanOutAccepted.add(row.id);
            } else {
              directHandedOff.push(row);
            }
          }

          if (directHandedOff.length > 0) {
            const handedOffIds = directHandedOff.map((r) => r.id);
            markSent(handedOffIds, now);
            markSourceRowsSynced(directHandedOff, now);
            result.handedOff += directHandedOff.length;
            clearedThisTick += directHandedOff.length;
          }

          result.batches += 1;
          handedOffTeams.add(teamId);
          logger.info(LOG_KINDS.TEAM_SYNC_COMPLETE, 'Outbox flush complete', {
            team_id: teamId,
            accepted: enqueueResult.accepted,
            rejected: enqueueResult.rejected.length,
            total: rows.length,
          });
        } catch (err) {
          tickError = (err as Error).message;
          logger.error(LOG_KINDS.TEAM_SYNC_ERROR, 'Outbox flush failed', { team_id: teamId, error: tickError });
          // A failed team leaves its rows pending. Fan-out rows that also
          // targeted this team must not be marked sent, so they are excluded
          // from fanOutAccepted by construction (their remaining count never
          // reached zero).
        }
      }

      // markSent fan-out rows that every target team accepted, exactly once.
      const fanOutIds = [...fanOutAccepted];
      if (fanOutIds.length > 0) {
        const fanOutRows = pending.filter((r) => fanOutAccepted.has(r.id));
        markSent(fanOutIds, now);
        markSourceRowsSynced(fanOutRows, now);
        result.handedOff += fanOutIds.length;
        clearedThisTick += fanOutIds.length;
      }

      pruneOld();

      if (tickError) {
        result.error = tickError;
        break;
      }

      // Nothing left the pending set this tick: every remaining row's target
      // team is unbuildable (or a fan-out row reached only some of its teams).
      // listPending() would return the same set forever — break and retry on
      // the next scheduled flush tick.
      if (clearedThisTick === 0) break;
    }

    // Provision every team we reached this flush: rotate + persist the MCP
    // token into the registry (so the read path / Team page can serve it) and
    // seed /config. Idempotent + cheap once provisioned, so it's safe to run
    // on every flush that handed off a batch.
    for (const teamId of handedOffTeams) {
      await ensureTeamProvisioned(teamId);
    }

    return result;
  }

  async function rebuildFromLocal(requestContext = defaultRequestContext): Promise<TeamFlushResult> {
    const empty: TeamFlushResult = { handedOff: 0, rejected: 0, batches: 0 };
    const teamIds = teamIdsForRebuild(requestContext);
    if (teamIds.length === 0) return { ...empty, error: 'team_not_configured' };

    const clients: Array<{ teamId: string; client: TeamSyncClient }> = [];
    for (const teamId of teamIds) {
      const client = getOrBuildTeamClient(teamId);
      if (!client) return { ...empty, error: `team_client_unavailable:${teamId}` };
      clients.push({ teamId, client });
    }

    const rebuildErrors: string[] = [];
    for (const { teamId, client } of clients) {
      try {
        await client.rebuild(); // truncate this machine's cloud rows (D1 + Vectorize)
      } catch (err) {
        const message = `${teamId}: ${(err as Error).message}`;
        rebuildErrors.push(message);
        logger.error(LOG_KINDS.TEAM_SYNC_ERROR, 'Rebuild from local truncate failed', {
          team_id: teamId,
          error: (err as Error).message,
        });
      }
    }

    try {
      const enqueued = backfillAllForRebuild(machineId);  // re-enqueue every local row including skill_usage
      logger.info(LOG_KINDS.TEAM_SYNC_START, 'Rebuild from local: re-enqueued rows', {
        enqueued,
        team_ids: teamIds,
      });
      const result = await flushPending(requestContext);  // push them
      if (rebuildErrors.length > 0 && !result.error) result.error = rebuildErrors.join('; ');
      return result;
    } catch (err) {
      logger.error(LOG_KINDS.TEAM_SYNC_ERROR, 'Rebuild from local failed', { error: (err as Error).message });
      const prefix = rebuildErrors.length > 0 ? `${rebuildErrors.join('; ')}; ` : '';
      return { ...empty, error: `${prefix}${(err as Error).message}` };
    }
  }

  async function reconcileClient(requestContext = defaultRequestContext): Promise<void> {
    const participates = groveParticipates(requestContext?.groveId ?? null);
    setTeamSyncEnabled(participates);

    // The participation gate (delete triggers / live syncRow) tracks project
    // membership, but the self-member re-push and drain are gated on the
    // machine having joined ANY team: a joined-no-project Grove must still
    // enqueue and drain its machine-scoped self row so the teammate appears in
    // the roster before assigning a project. Only when this machine has joined
    // no team at all do we treat the Grove as fully non-participating.
    const joinedAnyTeam = teamRegistry.list().length > 0;

    if (!joinedAnyTeam) {
      // If this machine is in no registry Team but the outbox still
      // carries pending rows (from a previous sync-enabled period that was
      // later turned off), drop them. Without this sweep, `countPending()`
      // keeps reporting stale rows that will never drain — which the Team
      // page UI then surfaces as "N pending failures" against a Grove that
      // is not in a Team. Source records are untouched; selecting a Team
      // re-enqueues from current state via `handleBackfill`.
      try {
        // One scan, not two: derive the total from the per-table breakdown
        // so we don't COUNT(*) the same predicate twice.
        const byTable = countPendingByTable();
        const total = Object.values(byTable).reduce((sum, n) => sum + n, 0);
        if (total > 0) {
          const purged = purgePendingOutbox();
          logger.info(LOG_KINDS.TEAM_SYNC_START, 'Purged stale outbox rows for non-participating Grove', {
            grove_id: requestContext?.groveId ?? null,
            purged,
            by_table: byTable,
          });
        }
      } catch (err) {
        logger.warn(LOG_KINDS.TEAM_SYNC_ERROR, 'Stale outbox sweep failed', {
          grove_id: requestContext?.groveId ?? null,
          error: (err as Error).message,
        });
      }
      return;
    }

    reconcileSelfMember();

    try {
      const backfilled = backfillUnsynced(machineId);
      if (backfilled > 0) {
        logger.info(LOG_KINDS.TEAM_SYNC_START, `Backfilled ${backfilled} unsynced records into outbox`);
      }
      await flushPending(requestContext);
    } catch (err) {
      logger.error(LOG_KINDS.TEAM_SYNC_ERROR, 'Backfill failed', { error: (err as Error).message });
    }
  }

  /**
   * Synthesize a Grove-scoped request context for the team-sync flush fan-out.
   * Team-sync only consumes `groveId` for Grove-level participation; the other
   * branded fields are filled with safe stubs so the type is satisfied without
   * minting a fake `GroveProjectId`. This stub MUST NOT leak outside the
   * Grove-level sync path.
   */
  function groveSyncContext(groveId: string, databasePath: string, projectVaultDir: string): MycoRequestContext {
    return {
      projectRoot: projectVaultDir,
      callerRoot: null,
      // Cast — never read by team-sync code paths. Documented above.
      projectId: '' as MycoRequestContext['projectId'],
      groveId,
      machineId,
      sessionId: null,
      projectVaultDir,
      databasePath,
      source: 'explicit',
    };
  }

  /**
   * Fan team-sync flush across every registered Grove. Each Grove has its
   * own SQLite DB (and therefore its own `team_outbox` table), so we open
   * each Grove's DB through the runtime cache and scope `getDatabase()`
   * via `withDatabase` for the duration of the per-Grove flush. Errors
   * are isolated per Grove via `forEachGrove`.
   */
  async function flushAllGroves(cache: GroveRuntimeCache): Promise<TeamFlushAggregate> {
    const aggregate: TeamFlushAggregate = { groves: 0, flushed: 0, rejected: 0, batches: 0, errors: 0 };
    await forEachGrove(
      cache,
      logger,
      async ({ grove, databasePath, db, groveHome }) => {
        // forEachGrove already ran withDatabase(db, ...) around this body,
        // so listPending/countPending in flushPending will read this
        // Grove's outbox. We re-pin via withDatabase to be explicit and
        // resilient to future refactors that lift this body out of the
        // forEachGrove scope.
        await withDatabase(db, async () => {
          aggregate.groves += 1;
          const ctx = groveSyncContext(grove.id, databasePath, groveHome);
          const result = await flushPending(ctx);
          aggregate.flushed += result.handedOff;
          aggregate.rejected += result.rejected;
          aggregate.batches += result.batches;
          if (result.error) aggregate.errors += 1;
        });
      },
      { daemonStateDir, jobName: 'team-sync-flush' },
    );

    // Teams are machine-level, so provision each participating team once per
    // daemon lifetime here — outside the per-Grove fan-out and independent of
    // pending data. This reaches already-synced teams (empty outbox, no batch
    // hands off) that the flush-end provisioning would otherwise never touch.
    // Guard-protected, so it's a cheap no-op on every tick after the first.
    for (const team of teamRegistry.list()) {
      if (team.projects.length > 0) await ensureTeamProvisioned(team.team_id);
    }

    return aggregate;
  }

  /**
   * Reconcile team_sync_state.enabled for every registered Grove without pushing.
   * Mirrors flushAllGroves's forEachGrove fan-out exactly (same groveSyncContext,
   * withDatabase, daemonStateDir, jobName pattern) but only writes the flag so
   * delete triggers on non-boot Groves are armed before the first flush tick.
   *
   * Runs on the boot critical path (awaited before server.start binds the port),
   * so the per-Grove flag writes fan out concurrently (`parallel: true`). Each
   * Grove is an independent SQLite DB and the write is a single idempotent flag
   * set, so there is no cross-Grove lock contention. forEachGrove isolates a
   * single Grove's failure (logged, not thrown) so one bad Grove neither aborts
   * the others nor blocks startup.
   */
  async function reconcileAllGroveFlags(cache: GroveRuntimeCache): Promise<void> {
    await forEachGrove(
      cache,
      logger,
      async ({ grove, databasePath, db, groveHome }) => {
        await withDatabase(db, async () => {
          setTeamSyncEnabled(groveParticipates(grove.id));
        });
      },
      { daemonStateDir, jobName: 'team-sync-flag-reconcile', parallel: true },
    );
  }

  /**
   * Resolve the team client for a read request. Registry-only: when the request
   * carries a projectId that belongs to a team (one-team-per-project), return
   * that team's per-team client. Contexts with no project / no team membership
   * are not connected.
   */
  function resolveReadClient(requestContext?: MycoRequestContext): TeamSyncClient | null {
    const projectId = requestContext?.projectId;
    if (projectId) {
      const teamId = teamRegistry.membershipByProject().get(projectId);
      if (teamId) {
        const client = getOrBuildTeamClient(teamId);
        if (client) return client;
      }
    }
    return null;
  }

  return {
    getTeamClient: (requestContext = defaultRequestContext) => resolveReadClient(requestContext),
    getTeamClientById: (teamId: string) => getOrBuildTeamClient(teamId),
    reconcileClient,
    flushPending,
    rebuildFromLocal,
    flushAllGroves,
    reconcileAllGroveFlags,
    registerFlushJob: (powerManager, cache) => {
      // Registered unconditionally; registry participation is checked at run
      // time so Team selection changes take effect without a daemon restart.
      // The job fans out across every registered Grove so non-boot Groves'
      // outboxes drain on the same cadence as the boot Grove.
      let running = false;
      powerManager.register({
        name: 'team-sync-flush',
        runIn: ['active', 'idle', 'sleep'],
        preventsDeepSleep: () => {
          // Best-effort: the boot/legacy outbox guarded the deep-sleep
          // gate previously. With multi-Grove fan-out we'd need to scope
          // countPending() per Grove; keep the cheap boot-context probe
          // and rely on the regular tick to drain non-boot Groves.
          return groveParticipates(defaultRequestContext?.groveId ?? null) && countPending() > 0;
        },
        fn: async () => {
          if (running) return;
          running = true;
          try {
            await flushAllGroves(cache);
          } finally {
            running = false;
          }
        },
      });
    },
  };
}

function rejectionKey(table: string, rowId: string | number): string {
  return `${table}\u0000${String(rowId)}`;
}
