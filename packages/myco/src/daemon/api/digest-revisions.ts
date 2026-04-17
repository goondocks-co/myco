/**
 * Digest revision API handlers — list the revision log for a given
 * (agent, tier) digest, and roll live content back to a prior revision.
 *
 * Operators use these endpoints when an agent run produced a bad digest
 * and they want to revert without losing audit history (the rollback
 * itself appends a new revision, preserving the pre-rollback state).
 */

import { z } from 'zod';
import {
  listDigestRevisions,
  rollbackDigestExtract,
} from '@myco/db/queries/digest-extracts.js';
import { LOG_KINDS } from '@myco/constants/log-kinds.js';
import type { RouteRequest, RouteResponse } from '../router.js';
import type { DaemonLogger } from '../logger.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_AGENT_ID = 'myco-agent';
const DEFAULT_LIMIT = 50;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const RestoreBody = z.object({
  /** If supplied, recorded on the new revision row as the run that triggered the restore. */
  runId: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DigestRevisionDeps {
  vaultDir: string;
  logger: DaemonLogger;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createDigestRevisionHandlers(deps: DigestRevisionDeps) {
  const { logger } = deps;

  /**
   * GET /api/digest/revisions?agentId=&tier=&limit=
   *
   * `agentId` defaults to 'myco-agent' so casual operators don't have to
   * thread it through. `tier` is required (the revision log is scoped per
   * (agent, tier)); passing a non-numeric value returns 400.
   */
  async function handleList(req: RouteRequest): Promise<RouteResponse> {
    const agentId = req.query.agentId || DEFAULT_AGENT_ID;
    const tierRaw = req.query.tier;
    if (!tierRaw) {
      return { status: 400, body: { error: 'tier is required' } };
    }
    const tier = Number(tierRaw);
    if (!Number.isFinite(tier)) {
      return { status: 400, body: { error: `tier must be numeric, got ${tierRaw}` } };
    }
    const limit = req.query.limit ? Number(req.query.limit) : DEFAULT_LIMIT;

    const revisions = listDigestRevisions({ agentId, tier, limit });
    return { body: { revisions, count: revisions.length } };
  }

  /**
   * POST /api/digest/revisions/:id/restore — restore the revision
   * identified by the URL param into the live digest_extracts row. The
   * revision history remains append-only: the pre-rollback content is
   * preserved as a fresh revision.
   */
  async function handleRestore(req: RouteRequest): Promise<RouteResponse> {
    const revisionId = Number(req.params.id);
    if (!Number.isFinite(revisionId)) {
      return { status: 400, body: { error: 'Invalid revision id' } };
    }

    const parsed = RestoreBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return {
        status: 400,
        body: { error: 'Invalid request body', details: parsed.error.flatten() },
      };
    }

    const result = rollbackDigestExtract({
      revisionId,
      runId: parsed.data.runId ?? null,
    });
    if (!result) {
      return { status: 404, body: { error: 'Revision not found' } };
    }

    // Structured log so operators can trace rollbacks in audit dashboards.
    // The "operator" bucket is a fallback for manual daemon-API-driven
    // rollbacks that don't carry an originating run.
    logger.info(LOG_KINDS.AGENT_RUN, 'Digest revision restored', {
      revisionId,
      newRevisionId: result.newRevisionId,
      agentId: result.row.agent_id,
      tier: result.row.tier,
      triggeredBy: parsed.data.runId ?? 'operator',
    });

    return {
      body: {
        ok: true,
        restored: revisionId,
        newRevisionId: result.newRevisionId,
      },
    };
  }

  return { handleList, handleRestore };
}
