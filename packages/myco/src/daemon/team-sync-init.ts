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
} from '@myco/db/queries/team-outbox.js';
import {
  SYNC_PROTOCOL_VERSION,
  TEAM_API_KEY_SECRET,
  epochSeconds,
} from '@myco/constants.js';
import { LOG_KINDS } from '@myco/constants/log-kinds.js';
import type { MycoRequestContext } from '@myco/tools/request-context.js';

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
  requestContext?: MycoRequestContext;
}

export interface TeamSyncResult {
  getTeamClient: (requestContext?: MycoRequestContext) => TeamSyncClient | null;
  setTeamClient: (client: TeamSyncClient | null, requestContext?: MycoRequestContext) => void;
  reconcileClient: (requestContext?: MycoRequestContext) => Promise<void>;
  flushPending: (requestContext?: MycoRequestContext) => Promise<TeamFlushResult>;
  registerFlushJob: (powerManager: PowerManager) => void;
}

export interface TeamFlushResult {
  handedOff: number;
  rejected: number;
  batches: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

export function initTeamSync(deps: TeamSyncDeps): TeamSyncResult {
  const { machineId, logger, vaultDir, serverVersion, requestContext: defaultRequestContext } = deps;
  const teamClients = new Map<string, TeamSyncClient>();
  const clientSignatures = new Map<string, string>();

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
    registerFlushJob: (powerManager) => {
      // Registered unconditionally; team.enabled is checked at run time so
      // Settings toggles take effect without a daemon restart.
      powerManager.register({
        name: 'team-sync-flush',
        runIn: ['active', 'idle', 'sleep'],
        preventsDeepSleep: () => loadTeamConnectionConfig(vaultDir, defaultRequestContext).enabled && countPending() > 0,
        fn: async () => { await flushPending(defaultRequestContext); },
      });
    },
  };
}

function teamConnectionKey(vaultDir: string, requestContext?: MycoRequestContext): string {
  return requestContext?.groveId ? `grove:${requestContext.groveId}` : `legacy-project:${vaultDir}`;
}
