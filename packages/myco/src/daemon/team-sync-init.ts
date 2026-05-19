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
  discardRows,
  countPending,
  countPendingByTable,
  purgePendingOutbox,
  resetSyncedAtForIds,
  forceEnqueueRows,
  enqueueOutbox,
  TEAM_SYNC_BACKFILL_TABLES,
} from '@myco/db/queries/team-outbox.js';
import { upsertSelfMember } from '@myco/db/queries/team-members.js';
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
   * Walk every synced table, ask the worker which locally-marked-synced
   * rows actually exist in D1, clear `synced_at` on the missing ones, and
   * trigger a backfill so they get re-enqueued. Heals the "synced_at set
   * locally but row never reached D1" drift class produced by DLQ'd
   * messages.
   */
  reconcileD1Drift: (requestContext?: MycoRequestContext) => Promise<D1DriftReport>;
  /**
   * Run flushPending across every registered Grove. Each Grove's outbox
   * lives in its own SQLite DB, so this fans out via `forEachGrove` and
   * scopes `getDatabase()` to the per-Grove handle inside each iteration.
   * Errors are isolated per Grove. Returns the aggregate per-Grove summary.
   */
  flushAllGroves: (cache: GroveRuntimeCache) => Promise<TeamFlushAggregate>;
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

/** Per-table drift detail returned by `reconcileD1Drift`. */
export interface D1DriftTableReport {
  table: string;
  /** Local rows that were checked via `/verify` (had `synced_at IS NOT NULL`). */
  checked: number;
  /** Of those, how many D1 reports as missing. */
  missing: number;
  /** Drift-path rows: `synced_at` cleared + outbox row force-enqueued. */
  reset: number;
  /**
   * Pre-drift rescue path: rows with `synced_at IS NULL` AND no pending
   * outbox entry (stranded by a prior reset whose follow-up backfill
   * skipped them). Counted separately from `reset` so the UI can show the
   * two healing paths distinctly.
   */
  stranded_enqueued: number;
  /**
   * Populated when one or more verify chunks failed (e.g. worker missing the
   * `/verify` endpoint, or a transient HTTP error). Operators need to know
   * that `missing=0` for this table reflects "verify never completed", not
   * "everything is clean."
   */
  verify_error?: string;
}

export interface D1DriftReport {
  tables: D1DriftTableReport[];
  /** Total rows re-enqueued by the post-reset `backfillUnsynced` pass. */
  reenqueued: number;
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
    if (!loadTeamConnectionConfig(vaultDir, requestContext).enabled) return result;
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

  /**
   * Detect and heal D1 drift for the active Grove.
   *
   * The `synced_at` stamp on local source rows is set on /enqueue
   * success — which only means the worker queued the message. If the
   * queue consumer dead-letters the message (column mismatch, DLQ
   * replay bug, constraint violation), local thinks the row is synced
   * but D1 never received it, and `backfillUnsynced` (which only scans
   * `synced_at IS NULL`) never gets a second chance.
   *
   * For each backfill-tracked table, this asks the worker which of the
   * local row IDs actually exist in D1 (`/verify`), then clears
   * `synced_at` on the missing ones so the next backfill+flush pass
   * re-enqueues them. The 500-id chunk size matches the worker-side
   * cap; tables with no marked-synced rows are skipped entirely.
   *
   * Returns a per-table report so the caller (HTTP endpoint, CLI, or
   * scheduled job) can log or display what was healed.
   */
  async function reconcileD1Drift(requestContext = defaultRequestContext): Promise<D1DriftReport> {
    const report: D1DriftReport = { tables: [], reenqueued: 0 };
    if (!loadTeamConnectionConfig(vaultDir, requestContext).enabled) return report;
    const client = teamClients.get(teamConnectionKey(vaultDir, requestContext)) ?? null;
    if (!client) return report;

    const VERIFY_CHUNK = 500;
    const db = getDatabase();
    let totalReset = 0;

    // Each table is fully independent — its verify chunks hit the worker
    // as standalone HTTP calls, and the local SELECT/UPDATE/INSERT touch
    // disjoint rows. Run the tables in parallel via Promise.all so 12
    // sequential roundtrips collapse to one wall-clock roundtrip.
    const tableReports = await Promise.all(TEAM_SYNC_BACKFILL_TABLES.map(async (table) => {
      const tableReport: D1DriftTableReport = {
        table, checked: 0, missing: 0, reset: 0, stranded_enqueued: 0,
      };

      // Rescue path: rows with `synced_at IS NULL` AND no pending outbox
      // entry — stranded by a prior reset whose follow-up backfill skipped
      // them (the NOT EXISTS guard matches any prior outbox row, including
      // long-since-sent ones). Without this they stay un-enqueued forever.
      try {
        const strandedRows = db.prepare(
          `SELECT id FROM ${table}
            WHERE machine_id = ? AND synced_at IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM team_outbox
                 WHERE table_name = ?
                   AND row_id = CAST(${table}.id AS TEXT)
                   AND sent_at IS NULL
              )`,
        ).all(machineId, table) as Array<{ id: string | number }>;
        if (strandedRows.length > 0) {
          const enqueued = forceEnqueueRows(table, strandedRows.map((r) => r.id));
          tableReport.stranded_enqueued = enqueued;
          report.reenqueued += enqueued;
          logger.info(LOG_KINDS.TEAM_SYNC_START, 'Drift reconcile: force-enqueued stranded rows', {
            table, stranded: strandedRows.length, enqueued,
          });
        }
      } catch (err) {
        logger.warn(LOG_KINDS.TEAM_SYNC_ERROR, 'Drift reconcile: stranded scan failed', {
          table, error: (err as Error).message,
        });
      }

      // Drift path: rows with `synced_at IS NOT NULL` — ask the worker
      // whether D1 actually has them, reset + re-enqueue any missing.
      let rows: Array<{ id: string | number }>;
      try {
        rows = db.prepare(
          `SELECT id FROM ${table} WHERE machine_id = ? AND synced_at IS NOT NULL`,
        ).all(machineId) as Array<{ id: string | number }>;
      } catch (err) {
        logger.warn(LOG_KINDS.TEAM_SYNC_ERROR, 'Drift reconcile: select failed', {
          table, error: (err as Error).message,
        });
        return tableReport;
      }
      tableReport.checked = rows.length;
      if (rows.length === 0) return tableReport;

      // The SELECT already returned ids with the correct type. Stringify
      // only at the worker-call boundary (verify expects string[]); the
      // local UPDATE/INSERT below reuses the typed array so we avoid the
      // string→number round-trip for INTEGER-id tables.
      const idsTyped: Array<string | number> = rows.map((r) => r.id);
      const missingIdSet = new Set<string>();
      let firstVerifyError: string | undefined;
      for (let offset = 0; offset < idsTyped.length; offset += VERIFY_CHUNK) {
        const slice = idsTyped.slice(offset, offset + VERIFY_CHUNK).map(String);
        try {
          const { missing } = await client.verify(table, slice);
          for (const id of missing) missingIdSet.add(id);
        } catch (err) {
          const message = (err as Error).message;
          if (!firstVerifyError) firstVerifyError = message;
          logger.warn(LOG_KINDS.TEAM_SYNC_ERROR, 'Drift reconcile: verify call failed', {
            table, chunk_size: slice.length, error: message,
          });
        }
      }
      tableReport.missing = missingIdSet.size;
      if (firstVerifyError) tableReport.verify_error = firstVerifyError;

      if (missingIdSet.size > 0) {
        // Filter the typed local ids by missing-set membership — that
        // keeps the original numeric/string type for the UPDATE+INSERT
        // and avoids a Number(id) round-trip for integer-id tables.
        const missingTyped = idsTyped.filter((id) => missingIdSet.has(String(id)));
        try {
          const reset = resetSyncedAtForIds(table, missingTyped);
          const enqueued = forceEnqueueRows(table, missingTyped);
          tableReport.reset = reset;
          totalReset += reset;
          report.reenqueued += enqueued;
          logger.info(LOG_KINDS.TEAM_SYNC_START, 'Drift reconcile: reset + force-enqueued missing rows', {
            table, checked: tableReport.checked, missing: tableReport.missing, reset, enqueued,
          });
        } catch (err) {
          logger.warn(LOG_KINDS.TEAM_SYNC_ERROR, 'Drift reconcile: reset/enqueue failed', {
            table, missing_count: missingIdSet.size, error: (err as Error).message,
          });
        }
      }
      return tableReport;
    }));
    report.tables.push(...tableReports);

    if (totalReset > 0 || report.reenqueued > 0) {
      try {
        // Kick a flush so the freshly force-enqueued rows leave the local
        // outbox promptly instead of waiting for the next scheduled drain.
        await flushPending(requestContext);
      } catch (err) {
        logger.warn(LOG_KINDS.TEAM_SYNC_ERROR, 'Drift reconcile: flush failed', {
          error: (err as Error).message,
        });
      }
    }

    return report;
  }

  async function reconcileClient(requestContext = defaultRequestContext): Promise<void> {
    const key = teamConnectionKey(vaultDir, requestContext);
    const teamConfig = loadTeamConnectionConfig(vaultDir, requestContext);
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
    reconcileD1Drift,
    flushAllGroves,
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
