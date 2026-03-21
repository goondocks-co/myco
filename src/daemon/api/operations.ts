/**
 * API handlers for long-running vault operations: curate, rebuild, digest.
 *
 * Each handler follows the thin-handler pattern: validate input, create a
 * progress token, fire-and-forget the operation with progress updates,
 * return the token immediately. Callers poll GET /api/progress/:token.
 *
 * Curate in dry-run mode is an exception: it runs synchronously and returns
 * results inline (no progress token).
 */

import { z } from 'zod';
import type { RouteResponse } from '../router.js';
import type { ProgressTracker } from './progress.js';
import type { MycoIndex } from '../../index/sqlite.js';
import type { VectorIndex } from '../../index/vectors.js';
import type { MycoConfig } from '../../config/schema.js';
import type { LlmProvider, EmbeddingProvider } from '../../intelligence/llm.js';
import { runRebuild, runDigest, runReprocess } from '../../services/vault-ops.js';
import type { CurationDeps, CurationResult, ReprocessOptions } from '../../services/vault-ops.js';

/** Percentage representing full completion. */
const PROGRESS_COMPLETE = 100;

// --- Shared deps interface ---

export interface OperationHandlerDeps {
  vaultDir: string;
  config: MycoConfig;
  index: MycoIndex;
  vectorIndex: VectorIndex | null;
  llmProvider: LlmProvider;
  embeddingProvider: EmbeddingProvider;
  progressTracker: ProgressTracker;
  log: (level: string, message: string, data?: Record<string, unknown>) => void;
}

// --- Request body schemas ---

const CurateBody = z.object({
  dry_run: z.boolean().optional(),
}).optional();

const DigestBody = z.object({
  tier: z.number().int().positive().optional(),
  full: z.boolean().optional(),
}).optional();

const ReprocessBody = z.object({
  session: z.string().optional(),
  date: z.string().optional(),
  failed: z.boolean().optional(),
  index_only: z.boolean().optional(),
}).optional();

// --- Rebuild ---

export async function handleRebuild(deps: OperationHandlerDeps): Promise<RouteResponse> {
  const { token, isNew } = deps.progressTracker.create('rebuild');

  if (!isNew) {
    return { body: { token, status: 'already_running' } };
  }

  // Fire-and-forget
  runRebuild(
    {
      vaultDir: deps.vaultDir,
      config: deps.config,
      index: deps.index,
      vectorIndex: deps.vectorIndex ?? undefined,
      log: deps.log,
    },
    deps.embeddingProvider,
    (done, total) => {
      const percent = total > 0 ? Math.round((done / total) * PROGRESS_COMPLETE) : 0;
      deps.progressTracker.update(token, {
        percent,
        message: `Embedded ${done}/${total} notes`,
      });
    },
  ).then((result) => {
    deps.progressTracker.update(token, {
      status: 'completed',
      percent: PROGRESS_COMPLETE,
      message: `FTS: ${result.ftsCount}, embedded: ${result.embeddedCount}, failed: ${result.failedCount}, skipped: ${result.skippedCount}`,
    });
    deps.log('info', 'Rebuild completed via API', {
      fts: result.ftsCount,
      embedded: result.embeddedCount,
      failed: result.failedCount,
    });
  }).catch((err) => {
    deps.progressTracker.update(token, {
      status: 'failed',
      message: (err as Error).message,
    });
    deps.log('warn', 'Rebuild failed via API', { error: (err as Error).message });
  });

  return { body: { token } };
}

// --- Digest ---

export async function handleDigest(
  deps: OperationHandlerDeps,
  body: unknown,
): Promise<RouteResponse> {
  const parsed = DigestBody.safeParse(body);
  if (!parsed.success) {
    return { status: 400, body: { error: 'validation_failed', issues: parsed.error.issues } };
  }

  if (!deps.config.digest.enabled) {
    return { status: 400, body: { error: 'digest_disabled', message: 'Digest is not enabled in myco.yaml' } };
  }

  const options = parsed.data;
  const { token, isNew } = deps.progressTracker.create('digest');

  if (!isNew) {
    return { body: { token, status: 'already_running' } };
  }

  // Resolve digest LLM provider: use digest-specific config if set, otherwise fall back to main
  // The daemon already has the main llmProvider; digest may use a different model.
  // For API-triggered digests, we use the daemon's main llmProvider. The daemon's
  // main.ts can pass a separate digestLlmProvider if needed.

  // Fire-and-forget
  runDigest(
    {
      vaultDir: deps.vaultDir,
      config: deps.config,
      index: deps.index,
      vectorIndex: deps.vectorIndex ?? undefined,
      log: deps.log,
    },
    deps.llmProvider,
    options ?? undefined,
  ).then((result) => {
    if (result) {
      deps.progressTracker.update(token, {
        status: 'completed',
        percent: PROGRESS_COMPLETE,
        message: `Tiers: [${result.tiersGenerated.join(', ')}], substrate: ${Object.values(result.substrate).flat().length} notes, ${(result.durationMs / 1000).toFixed(1)}s`,
      });
      deps.log('info', 'Digest completed via API', {
        tiers: result.tiersGenerated,
        duration: result.durationMs,
      });
    } else {
      deps.progressTracker.update(token, {
        status: 'completed',
        percent: PROGRESS_COMPLETE,
        message: 'No substrate found — nothing to digest',
      });
    }
  }).catch((err) => {
    deps.progressTracker.update(token, {
      status: 'failed',
      message: (err as Error).message,
    });
    deps.log('warn', 'Digest failed via API', { error: (err as Error).message });
  });

  return { body: { token } };
}

// --- Curate ---

/**
 * Run curation. The curate logic is complex and tightly coupled to LLM providers.
 * Rather than fully extracting it, we accept a `runCuration` callback that the
 * daemon's main.ts wires up with its live instances.
 */
export async function handleCurate(
  deps: OperationHandlerDeps,
  body: unknown,
  runCuration: (curationDeps: CurationDeps, dryRun: boolean) => Promise<CurationResult>,
): Promise<RouteResponse> {
  const parsed = CurateBody.safeParse(body);
  if (!parsed.success) {
    return { status: 400, body: { error: 'validation_failed', issues: parsed.error.issues } };
  }

  const isDryRun = parsed.data?.dry_run ?? false;

  if (!deps.vectorIndex) {
    return { status: 400, body: { error: 'vector_index_unavailable', message: 'Curate requires a working embedding provider' } };
  }

  const curationDeps: CurationDeps = {
    vaultDir: deps.vaultDir,
    config: deps.config,
    index: deps.index,
    vectorIndex: deps.vectorIndex,
    llmProvider: deps.llmProvider,
    embeddingProvider: deps.embeddingProvider,
    log: deps.log,
  };

  // Dry run: synchronous response with results
  if (isDryRun) {
    try {
      const result = await runCuration(curationDeps, true);
      return { body: { dry_run: true, ...result } };
    } catch (err) {
      return { status: 500, body: { error: 'curation_failed', message: (err as Error).message } };
    }
  }

  // Full run: async with progress token
  const { token, isNew } = deps.progressTracker.create('curate');

  if (!isNew) {
    return { body: { token, status: 'already_running' } };
  }

  runCuration(curationDeps, false)
    .then((result) => {
      deps.progressTracker.update(token, {
        status: 'completed',
        percent: PROGRESS_COMPLETE,
        message: `Scanned: ${result.scanned}, clusters: ${result.clustersEvaluated}, superseded: ${result.superseded}`,
      });
      deps.log('info', 'Curation completed via API', { ...result });
    })
    .catch((err) => {
      deps.progressTracker.update(token, {
        status: 'failed',
        message: (err as Error).message,
      });
      deps.log('warn', 'Curation failed via API', { error: (err as Error).message });
    });

  return { body: { token } };
}

// --- Reprocess ---

export async function handleReprocess(
  deps: OperationHandlerDeps,
  body: unknown,
): Promise<RouteResponse> {
  const parsed = ReprocessBody.safeParse(body);
  if (!parsed.success) {
    return { status: 400, body: { error: 'validation_failed', issues: parsed.error.issues } };
  }

  const options: ReprocessOptions = {
    session: parsed.data?.session,
    date: parsed.data?.date,
    failed: parsed.data?.failed,
    indexOnly: parsed.data?.index_only,
  };

  const { token, isNew } = deps.progressTracker.create('reprocess');

  if (!isNew) {
    return { body: { token, status: 'already_running' } };
  }

  runReprocess(
    {
      vaultDir: deps.vaultDir,
      config: deps.config,
      index: deps.index,
      vectorIndex: deps.vectorIndex ?? undefined,
      log: deps.log,
    },
    deps.llmProvider,
    deps.embeddingProvider,
    options,
    (phase, done, total) => {
      const percent = total > 0 ? Math.round((done / total) * PROGRESS_COMPLETE) : 0;
      deps.progressTracker.update(token, {
        percent,
        message: `${phase}: ${done}/${total}`,
      });
    },
  ).then((result) => {
    const message = result.sessionsProcessed === 0
      ? `No matching sessions found (${result.sessionsFound} checked)`
      : `${result.sessionsProcessed} sessions, ${result.observationsExtracted} observations, ${result.summariesRegenerated} summaries`;
    deps.progressTracker.update(token, {
      status: 'completed',
      percent: PROGRESS_COMPLETE,
      message,
    });
    deps.log('info', 'Reprocess completed via API', { ...result });
  }).catch((err) => {
    deps.progressTracker.update(token, {
      status: 'failed',
      message: (err as Error).message,
    });
    deps.log('warn', 'Reprocess failed via API', { error: (err as Error).message });
  });

  return { body: { token } };
}
