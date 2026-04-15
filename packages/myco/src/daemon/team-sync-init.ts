/**
 * Team sync initialization.
 *
 * Extracted from main.ts — creates the TeamSyncClient from saved config,
 * registers the node, backfills unsynced records, and exposes the outbox
 * flush power job.
 */

import type { DaemonLogger } from './logger.js';
import type { MycoConfig } from '@myco/config/schema.js';
import type { PowerManager } from './power.js';
import { TeamSyncClient } from './team-sync.js';
import { readSecrets } from '@myco/config/secrets.js';
import {
  listPending,
  markSent,
  markSourceRowsSynced,
  pruneOld,
  backfillUnsynced,
  incrementRetryCount,
  countPending,
} from '@myco/db/queries/team-outbox.js';
import {
  SYNC_PROTOCOL_VERSION,
  TEAM_API_KEY_SECRET,
  epochSeconds,
} from '@myco/constants.js';
import { LOG_KINDS } from '@myco/constants/log-kinds.js';

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
}

export interface TeamSyncResult {
  getTeamClient: () => TeamSyncClient | null;
  setTeamClient: (client: TeamSyncClient | null) => void;
  reconcileClient: () => Promise<void>;
  registerFlushJob: (powerManager: PowerManager) => void;
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

export function initTeamSync(deps: TeamSyncDeps): TeamSyncResult {
  const { liveConfig, machineId, logger, vaultDir, serverVersion } = deps;
  let teamClient: TeamSyncClient | null = null;
  let clientSignature: string | null = null;

  async function reconcileClient(): Promise<void> {
    const config = liveConfig.current;
    const workerUrl = config.team.worker_url?.trim() || null;
    const apiKey = readSecrets(vaultDir)[TEAM_API_KEY_SECRET]?.trim() || null;
    const nextSignature = config.team.enabled && workerUrl && apiKey
      ? `${workerUrl}\n${apiKey}`
      : null;

    if (!nextSignature) {
      if (teamClient) {
        logger.info(LOG_KINDS.TEAM_SYNC_START, 'Team sync client cleared', {
          enabled: config.team.enabled,
          has_worker_url: Boolean(workerUrl),
          has_api_key: Boolean(apiKey),
        });
      }
      teamClient = null;
      clientSignature = null;
      return;
    }

    if (teamClient && clientSignature === nextSignature) return;

    const activeWorkerUrl = workerUrl!;
    const activeApiKey = apiKey!;
    teamClient = new TeamSyncClient({
      workerUrl: activeWorkerUrl,
      apiKey: activeApiKey,
      machineId,
      syncProtocolVersion: SYNC_PROTOCOL_VERSION,
    });
    clientSignature = nextSignature;

    logger.info(LOG_KINDS.TEAM_SYNC_START, 'Team sync client initialized', { worker_url: activeWorkerUrl });

    try {
      await teamClient.connect({
        machine_id: machineId,
        version: serverVersion,
      });
      logger.info(LOG_KINDS.TEAM_SYNC_START, 'Node registered with team worker');
    } catch (err) {
      logger.warn(LOG_KINDS.TEAM_SYNC_ERROR, 'Node registration failed (will retry on next flush)', {
        error: (err as Error).message,
      });
    }

    try {
      const backfilled = backfillUnsynced(machineId);
      if (backfilled > 0) {
        logger.info(LOG_KINDS.TEAM_SYNC_START, `Backfilled ${backfilled} unsynced records into outbox`);
      }
    } catch (err) {
      logger.error(LOG_KINDS.TEAM_SYNC_ERROR, 'Backfill failed', { error: (err as Error).message });
    }
  }

  return {
    getTeamClient: () => teamClient,
    setTeamClient: (client) => { teamClient = client; },
    reconcileClient,
    registerFlushJob: (powerManager) => {
      // Always register the flush job; gate at run time so toggling
      // team.enabled in Settings takes effect without a daemon restart.
      const logDeadLettered = (ids: number[]) => {
        if (ids.length > 0) {
          logger.error(LOG_KINDS.TEAM_SYNC_DEAD_LETTER, `Dead-lettered ${ids.length} records after max retries`, { ids });
        }
      };

      powerManager.register({
        name: 'team-sync-flush',
        runIn: ['active', 'idle', 'sleep'],
        preventsDeepSleep: () => liveConfig.current.team.enabled && countPending() > 0,
        fn: async () => {
          if (!liveConfig.current.team.enabled) return;
          const client = teamClient;
          if (!client) return;

          const pending = listPending();
          if (pending.length === 0) return;

          try {
            logger.info(LOG_KINDS.TEAM_SYNC_START, 'Flushing outbox', { count: pending.length });
            const result = await client.pushBatch(pending);
            const now = epochSeconds();

            // Mark successfully synced records as sent
            const failedIds = new Set(result.errors.map((e) => e.id));
            const sentRecords = pending.filter((r) => !failedIds.has(String(r.row_id)));
            const sentIds = sentRecords.map((r) => r.id);
            if (sentIds.length > 0) {
              markSent(sentIds, now);
              markSourceRowsSynced(sentRecords, now);
            }

            // Increment retry count on per-record failures
            if (result.errors.length > 0) {
              const failedOutboxIds = pending
                .filter((r) => failedIds.has(String(r.row_id)))
                .map((r) => r.id);
              const deadLettered = incrementRetryCount(failedOutboxIds, now);

              logger.warn(LOG_KINDS.TEAM_SYNC_RETRY, `Retrying ${failedOutboxIds.length} records`, {
                errors: result.errors.slice(0, 5),
              });

              logDeadLettered(deadLettered);
            }

            pruneOld();
            logger.info(LOG_KINDS.TEAM_SYNC_COMPLETE, 'Outbox flush complete', {
              synced: result.synced, skipped: result.skipped, errors: result.errors.length, total: pending.length,
            });
          } catch (err) {
            // Batch-level failure: increment retry count on all records
            try {
              const now = epochSeconds();
              const allIds = pending.map((r) => r.id);
              const deadLettered = incrementRetryCount(allIds, now);

              logger.warn(LOG_KINDS.TEAM_SYNC_RETRY, `Batch failed, retrying ${allIds.length} records`, {
                error: (err as Error).message,
              });

              logDeadLettered(deadLettered);
            } catch { /* best-effort retry tracking */ }
            logger.error(LOG_KINDS.TEAM_SYNC_ERROR, 'Outbox flush failed', { error: (err as Error).message });
          }
        },
      });
    },
  };
}
