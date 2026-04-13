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
  config: MycoConfig;
  machineId: string;
  logger: DaemonLogger;
  vaultDir: string;
  serverVersion: string;
}

export interface TeamSyncResult {
  getTeamClient: () => TeamSyncClient | null;
  setTeamClient: (client: TeamSyncClient | null) => void;
  registerFlushJob: (powerManager: PowerManager) => void;
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

export function initTeamSync(deps: TeamSyncDeps): TeamSyncResult {
  const { config, machineId, logger, vaultDir, serverVersion } = deps;

  let teamClient: TeamSyncClient | null = null;

  // Initialize team client from saved config if team sync is enabled
  if (config.team.enabled && config.team.worker_url) {
    const secrets = readSecrets(vaultDir);
    const teamApiKey = secrets[TEAM_API_KEY_SECRET];
    if (teamApiKey) {
      teamClient = new TeamSyncClient({
        workerUrl: config.team.worker_url,
        apiKey: teamApiKey,
        machineId,
        syncProtocolVersion: SYNC_PROTOCOL_VERSION,
      });
      logger.info(LOG_KINDS.TEAM_SYNC_START, 'Team sync client initialized', { worker_url: config.team.worker_url });

      // Register this node with the team worker (fire-and-forget)
      teamClient.connect({
        machine_id: machineId,
        version: serverVersion,
      }).then(() => {
        logger.info(LOG_KINDS.TEAM_SYNC_START, 'Node registered with team worker');
      }).catch((err) => {
        logger.warn(LOG_KINDS.TEAM_SYNC_ERROR, 'Node registration failed (will retry on next flush)', { error: (err as Error).message });
      });

      // Backfill unsynced records into outbox (fire-and-forget — can be large)
      setTimeout(() => {
        try {
          const backfilled = backfillUnsynced(machineId);
          if (backfilled > 0) {
            logger.info(LOG_KINDS.TEAM_SYNC_START, `Backfilled ${backfilled} unsynced records into outbox`);
          }
        } catch (err) {
          logger.error(LOG_KINDS.TEAM_SYNC_ERROR, 'Backfill failed', { error: (err as Error).message });
        }
      }, 0);
    }
  }

  return {
    getTeamClient: () => teamClient,
    setTeamClient: (client) => { teamClient = client; },
    registerFlushJob: (powerManager) => {
      if (!config.team.enabled) return;

      const logDeadLettered = (ids: number[]) => {
        if (ids.length > 0) {
          logger.error(LOG_KINDS.TEAM_SYNC_DEAD_LETTER, `Dead-lettered ${ids.length} records after max retries`, { ids });
        }
      };

      powerManager.register({
        name: 'team-sync-flush',
        runIn: ['active', 'idle', 'sleep'],
        preventsDeepSleep: () => countPending() > 0,
        fn: async () => {
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
