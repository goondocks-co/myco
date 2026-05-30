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

  async function flushPending(requestContext = defaultRequestContext): Promise<TeamFlushResult> {
    const result: TeamFlushResult = { handedOff: 0, rejected: 0, batches: 0 };
    const enabled = loadTeamConnectionConfig(vaultDir, requestContext).enabled;
    // Keep the write-path gate (delete triggers + syncRow) in lockstep with
    // this Grove's config, every tick, for whichever Grove getDatabase() points at.
    setTeamSyncEnabled(enabled);
    if (!enabled) return result;
    const client = teamClients.get(teamConnectionKey(vaultDir, requestContext)) ?? null;
    if (!client) return result;

    while (true) {
      const pending = listPending();
      if (pending.length === 0) break;

      try {
        logger.info(LOG_KINDS.TEAM_SYNC_START, 'Flushing outbox', { count: pending.length });
        const enqueueResult = await client.enqueueBatch(pending);
        const now = epochSeconds();

        const rejectedIds = new Set(enqueueResult.rejected.map((e) => e.id));
        const rejectedOutboxIds: number[] = [];
        const handedOff: typeof pending = [];
        for (const row of pending) {
          if (rejectedIds.has(String(row.row_id))) {
            rejectedOutboxIds.push(row.id);
          } else {
            handedOff.push(row);
          }
        }

        if (rejectedOutboxIds.length > 0) {
          logger.warn(LOG_KINDS.TEAM_SYNC_REJECTED, `Discarding ${rejectedOutboxIds.length} rejected records`, {
            rejected: enqueueResult.rejected.slice(0, 5),
          });
          discardRows(rejectedOutboxIds);
        }

        if (handedOff.length > 0) {
          const handedOffIds = handedOff.map((r) => r.id);
          markSent(handedOffIds, now);
          markSourceRowsSynced(handedOff, now);
        }

        pruneOld();
        result.batches += 1;
        result.handedOff += handedOff.length;
        result.rejected += rejectedOutboxIds.length;
        logger.info(LOG_KINDS.TEAM_SYNC_COMPLETE, 'Outbox flush complete', {
          accepted: enqueueResult.accepted,
          rejected: enqueueResult.rejected.length,
          total: pending.length,
        });
      } catch (err) {
        result.error = (err as Error).message;
        logger.error(LOG_KINDS.TEAM_SYNC_ERROR, 'Outbox flush failed', { error: result.error });
        break;
      }
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
      { daemonStateDir, jobName: 'team-sync-flag-reconcile' },
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
