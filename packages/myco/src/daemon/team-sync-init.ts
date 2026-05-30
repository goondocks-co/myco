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
import { TeamSyncClient } from './team-sync.js';
import {
  loadTeamConnectionConfig,
  readTeamConnectionSecrets,
} from '@myco/grove/team-connection.js';
import {
  listPending,
  markSent,
  markSourceRowsSynced,
  pruneOld,
  backfillUnsynced,
  backfillAll,
  backfillAllForRebuild,
  discardRows,
  countPending,
  countPendingByTable,
  purgePendingOutbox,
  enqueueOutbox,
} from '@myco/db/queries/team-outbox.js';
import { upsertSelfMember } from '@myco/db/queries/team-members.js';
import { setTeamSyncEnabled } from '@myco/db/queries/team-sync-state.js';
import {
  SYNC_PROTOCOL_VERSION,
  TEAM_API_KEY_SECRET,
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
  setTeamClient: (client: TeamSyncClient | null, requestContext?: MycoRequestContext) => void;
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
// Initialization
// ---------------------------------------------------------------------------

export function initTeamSync(deps: TeamSyncDeps): TeamSyncResult {
  const { machineId, logger, vaultDir, serverVersion, daemonStateDir, requestContext: defaultRequestContext } = deps;
  const teamClients = new Map<string, TeamSyncClient>();
  const clientSignatures = new Map<string, string>();

  // Per-team client cache (registry-driven routing). flushPending routes each
  // outbox row to its owning team's worker, so clients are keyed by team_id —
  // independent of the per-Grove `teamClients` map above (which rebuildFromLocal
  // and get/setTeamClient still use for the operator rebuild path). Rebuilt when
  // the team's worker_url or API key changes, mirroring `clientSignatures`.
  const teamRouteClients = new Map<string, TeamSyncClient>();
  const teamRouteSignatures = new Map<string, string>();

  /**
   * Lazily build (and cache) the TeamSyncClient for a given team_id from the
   * team registry. Returns null when the team is unknown, has no worker_url,
   * or has no API key — callers must treat null as "skip this team this tick"
   * (leave its rows pending for retry), never as "drop the rows".
   */
  function getOrBuildTeamClient(teamId: string): TeamSyncClient | null {
    const team = teamRegistry.get(teamId);
    if (!team?.worker_url) return null;
    const key = teamRegistry.readSecrets(teamId)[TEAM_API_KEY_SECRET];
    if (!key) return null;

    const signature = `${team.worker_url}|${key.slice(0, 8)}`;
    const existing = teamRouteClients.get(teamId);
    if (existing && teamRouteSignatures.get(teamId) === signature) {
      return existing;
    }

    const client = new TeamSyncClient({
      workerUrl: team.worker_url,
      apiKey: key,
      machineId,
      syncProtocolVersion: SYNC_PROTOCOL_VERSION,
    });
    teamRouteClients.set(teamId, client);
    teamRouteSignatures.set(teamId, signature);
    return client;
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
      let row: ReturnType<typeof upsertSelfMember>['row'] | null = null;
      getDatabase().transaction(() => {
        const result = upsertSelfMember(machineId, joinedIso);
        inserted = result.inserted;
        row = result.row;
        if (inserted && row) {
          enqueueOutbox({
            table_name: 'team_members',
            row_id: row.id,
            operation: 'upsert',
            payload: JSON.stringify(row),
            machine_id: machineId,
            created_at: nowSec,
          });
        }
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
   *     team_members)                                  this Grove participates in.
   *
   * A fanned-out row is only `markSent` once ALL its target teams accept it;
   * if any target's client is unbuilt/failed this tick the row stays pending
   * for the next tick. Per-team batches whose client can't be built are left
   * pending too (team unreachable/unconfigured) — never dropped.
   */
  async function flushPending(requestContext = defaultRequestContext): Promise<TeamFlushResult> {
    const result: TeamFlushResult = { handedOff: 0, rejected: 0, batches: 0 };

    const groveId = requestContext?.groveId ?? null;
    const teams = teamRegistry.list();
    const participates = teams.some((t) => t.projects.some((p) => p.grove_id === groveId));
    // The registry is now the write-path gate: keep delete triggers + syncRow
    // in lockstep with whether this Grove feeds any team, every tick.
    setTeamSyncEnabled(participates);
    if (!participates) return result;

    const map = teamRegistry.membershipByProject();
    const participatingTeamIds = [
      ...new Set(
        teams
          .filter((t) => t.projects.some((p) => p.grove_id === groveId))
          .map((t) => t.team_id),
      ),
    ];

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
        if (row.project_id != null && !map.has(row.project_id)) {
          dropIds.push(row.id);
          continue;
        }
        if (row.project_id != null) {
          pushToTeam(map.get(row.project_id)!, row);
        } else {
          // Machine-scoped row: fan out a copy into every participating team.
          fanOutTargetsRemaining.set(row.id, participatingTeamIds.length);
          for (const teamId of participatingTeamIds) {
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

        try {
          logger.info(LOG_KINDS.TEAM_SYNC_START, 'Flushing outbox', { team_id: teamId, count: rows.length });
          const enqueueResult = await client.enqueueBatch(rows);

          const rejectedIds = new Set(enqueueResult.rejected.map((e) => e.id));
          const rejectedOutboxIds: number[] = [];
          const handedOff: OutboxRow[] = [];
          for (const row of rows) {
            if (rejectedIds.has(String(row.row_id))) {
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

    return result;
  }

  async function rebuildFromLocal(requestContext = defaultRequestContext): Promise<TeamFlushResult> {
    const empty: TeamFlushResult = { handedOff: 0, rejected: 0, batches: 0 };
    if (!loadTeamConnectionConfig(vaultDir, requestContext).enabled) return empty;
    const client = teamClients.get(teamConnectionKey(vaultDir, requestContext)) ?? null;
    if (!client) return empty;
    try {
      await client.rebuild();                             // truncate this machine's cloud rows (D1 + Vectorize)
      const enqueued = backfillAllForRebuild(machineId);  // re-enqueue every local row including skill_usage
      logger.info(LOG_KINDS.TEAM_SYNC_START, 'Rebuild from local: re-enqueued rows', { enqueued });
      return await flushPending(requestContext);  // push them
    } catch (err) {
      logger.error(LOG_KINDS.TEAM_SYNC_ERROR, 'Rebuild from local failed', { error: (err as Error).message });
      return { ...empty, error: (err as Error).message };
    }
  }

  async function reconcileClient(requestContext = defaultRequestContext): Promise<void> {
    const key = teamConnectionKey(vaultDir, requestContext);
    const teamConfig = loadTeamConnectionConfig(vaultDir, requestContext);
    setTeamSyncEnabled(teamConfig.enabled);
    const workerUrl = teamConfig.worker_url?.trim() || null;
    const apiKey = readTeamConnectionSecrets(vaultDir, requestContext)[TEAM_API_KEY_SECRET]?.trim() || null;
    const nextSignature = teamConfig.enabled && workerUrl && apiKey
      ? `${workerUrl}\n${apiKey}`
      : null;

    if (!nextSignature) {
      const teamClient = teamClients.get(key);
      if (teamClient) {
        logger.info(LOG_KINDS.TEAM_SYNC_START, 'Team sync client cleared', {
          enabled: teamConfig.enabled,
          has_worker_url: Boolean(workerUrl),
          has_api_key: Boolean(apiKey),
        });
      }
      teamClients.delete(key);
      clientSignatures.delete(key);

      // Legacy-state cleanup: if team sync is disabled but the outbox still
      // carries pending rows (from a previous sync-enabled period that was
      // later turned off), drop them. Without this sweep, `countPending()`
      // keeps reporting stale rows that will never drain — which the Team
      // page UI then surfaces as "N pending failures" against a sync that
      // isn't running. Source records are untouched; re-enabling team sync
      // re-enqueues from current state via `handleBackfill`.
      try {
        // One scan, not two: derive the total from the per-table breakdown
        // so we don't COUNT(*) the same predicate twice.
        const byTable = countPendingByTable();
        const total = Object.values(byTable).reduce((sum, n) => sum + n, 0);
        if (total > 0) {
          const purged = purgePendingOutbox();
          logger.info(LOG_KINDS.TEAM_SYNC_START, 'Purged stale outbox rows for disabled-sync Grove', {
            grove_key: key,
            purged,
            by_table: byTable,
          });
        }
      } catch (err) {
        logger.warn(LOG_KINDS.TEAM_SYNC_ERROR, 'Stale outbox sweep failed', {
          grove_key: key,
          error: (err as Error).message,
        });
      }
      return;
    }

    const teamClient = teamClients.get(key);
    const clientSignature = clientSignatures.get(key) ?? null;
    if (teamClient && clientSignature === nextSignature) {
      await flushPending(requestContext);
      return;
    }

    const activeWorkerUrl = workerUrl!;
    const activeApiKey = apiKey!;
    const nextClient = new TeamSyncClient({
      workerUrl: activeWorkerUrl,
      apiKey: activeApiKey,
      machineId,
      syncProtocolVersion: SYNC_PROTOCOL_VERSION,
    });
    teamClients.set(key, nextClient);
    clientSignatures.set(key, nextSignature);

    logger.info(LOG_KINDS.TEAM_SYNC_START, 'Team sync client initialized', { worker_url: activeWorkerUrl });

    try {
      await nextClient.connect({
        machine_id: machineId,
        version: serverVersion,
      });
      logger.info(LOG_KINDS.TEAM_SYNC_START, 'Node registered with team worker');
    } catch (err) {
      logger.warn(LOG_KINDS.TEAM_SYNC_ERROR, 'Node registration failed (will retry on next flush)', {
        error: (err as Error).message,
      });
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
   * Synthesize a Grove-scoped request context for the team-sync flush
   * fan-out. Team-sync only consumes `groveId` off the context (see
   * `loadTeamConnectionConfig`, `readTeamConnectionSecrets`,
   * `teamConnectionKey`); the other branded fields are filled with safe
   * stubs so the type is satisfied without minting a fake `GroveProjectId`
   * via `assertGroveProjectId`. This stub MUST NOT leak outside the
   * team-sync flush path.
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
          const ctx = groveSyncContext(grove.id, databasePath, groveHome);
          const enabled = loadTeamConnectionConfig(groveHome, ctx).enabled;
          setTeamSyncEnabled(enabled);
        });
      },
      { daemonStateDir, jobName: 'team-sync-flag-reconcile', parallel: true },
    );
  }

  return {
    getTeamClient: (requestContext = defaultRequestContext) => teamClients.get(teamConnectionKey(vaultDir, requestContext)) ?? null,
    setTeamClient: (client, requestContext = defaultRequestContext) => {
      const key = teamConnectionKey(vaultDir, requestContext);
      if (!client) {
        teamClients.delete(key);
        clientSignatures.delete(key);
        return;
      }
      teamClients.set(key, client);
      clientSignatures.delete(key);
    },
    reconcileClient,
    flushPending,
    rebuildFromLocal,
    flushAllGroves,
    reconcileAllGroveFlags,
    registerFlushJob: (powerManager, cache) => {
      // Registered unconditionally; team.enabled is checked at run time so
      // Settings toggles take effect without a daemon restart. The job
      // fans out across every registered Grove so non-boot Groves' outboxes
      // drain on the same cadence as the boot Grove (release-blocker fix
      // for the global daemon — see plan 4ab20d9762619a6e #A1).
      let running = false;
      powerManager.register({
        name: 'team-sync-flush',
        runIn: ['active', 'idle', 'sleep'],
        preventsDeepSleep: () => {
          // Best-effort: the boot/legacy outbox guarded the deep-sleep
          // gate previously. With multi-Grove fan-out we'd need to scope
          // countPending() per Grove; keep the cheap boot-context probe
          // and rely on the regular tick to drain non-boot Groves.
          return loadTeamConnectionConfig(vaultDir, defaultRequestContext).enabled && countPending() > 0;
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

function teamConnectionKey(vaultDir: string, requestContext?: MycoRequestContext): string {
  return requestContext?.groveId ? `grove:${requestContext.groveId}` : `legacy-project:${vaultDir}`;
}
