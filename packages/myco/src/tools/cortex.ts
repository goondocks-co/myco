/**
 * myco_cortex — retrieve Cortex project intelligence.
 */

import { parseCanopyRecordId } from '@myco/canopy/hydrate.js';
import type { DaemonClient } from '@myco/hooks/client.js';
import { handleCanopyEntryGet } from '@myco/daemon/api/canopy-read.js';
import { handleCanopyMap, type CanopyMapResult } from './canopy-map.js';
import type { ToolFailure } from './error.js';

export type CortexFailure = ToolFailure;

const DEFAULT_CONTEXT_TIER = 5000;
const NO_DIGEST_MESSAGE = 'Digest context is not yet available. The first digest cycle has not completed.';

export interface CortexInput {
  op?: 'digest' | 'instructions' | 'canopy_map' | 'canopy_entry';
  tier?: number;
  id?: string;
  project_id?: string;
  path?: string;
}

export interface CortexDigestResult {
  content: string;
  tier: number;
  fallback: boolean;
  generated_at?: number;
}

export interface CortexCanopyArgs {
  projectId: string;
  machineId: string;
}

export async function handleCortexDigest(
  input: CortexInput,
  client: DaemonClient,
): Promise<CortexDigestResult> {
  const requestedTier = input.tier ?? DEFAULT_CONTEXT_TIER;

  const result = await client.get('/api/digest');
  if (!result.ok || !result.data?.tiers) {
    return {
      content: NO_DIGEST_MESSAGE,
      tier: requestedTier,
      fallback: false,
    };
  }

  const tiers = result.data.tiers as Array<{ tier: number; content: string; generated_at: number }>;
  const exact = tiers.find((t) => t.tier === requestedTier);
  if (exact) {
    return {
      content: exact.content,
      tier: exact.tier,
      fallback: false,
      generated_at: exact.generated_at,
    };
  }

  if (tiers.length > 0) {
    const sorted = [...tiers].sort(
      (a, b) => Math.abs(a.tier - requestedTier) - Math.abs(b.tier - requestedTier),
    );
    const nearest = sorted[0];
    return {
      content: nearest.content,
      tier: nearest.tier,
      fallback: true,
      generated_at: nearest.generated_at,
    };
  }

  return {
    content: NO_DIGEST_MESSAGE,
    tier: requestedTier,
    fallback: false,
  };
}

export async function handleCortexInstructions(client: DaemonClient): Promise<unknown | CortexFailure> {
  const result = await client.get('/api/cortex/instructions');
  if (!result.ok || !result.data) return { ok: false, error: 'Cortex instructions not available' };
  return result.data;
}

export async function handleCortexCanopyMap(args: CortexCanopyArgs): Promise<CanopyMapResult> {
  return handleCanopyMap(args);
}

export async function handleCortexCanopyEntry(input: CortexInput): Promise<unknown | CortexFailure> {
  const resolved = resolveCanopyEntry(input);
  if (!resolved) {
    return { ok: false, error: 'id or project_id plus path is required for op: canopy_entry' };
  }

  try {
    return await handleCanopyEntryGet({
      project_id: resolved.projectId,
      path: resolved.path,
    });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Canopy entry not found' };
  }
}

function resolveCanopyEntry(input: CortexInput): { projectId: string; path: string } | null {
  if (input.project_id && input.path) {
    return { projectId: input.project_id, path: input.path };
  }
  if (!input.id) return null;
  return parseCanopyRecordId(input.id);
}
