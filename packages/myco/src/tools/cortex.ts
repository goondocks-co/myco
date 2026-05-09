/**
 * myco_cortex — retrieve Cortex project intelligence.
 */

import { parseCanopyRecordId } from '@myco/canopy/hydrate.js';
import type { DaemonClient } from '@myco/hooks/client.js';
import { handleCanopyEntryGet } from '@myco/daemon/api/canopy-read.js';
import { handleCanopyMap, type CanopyMapResult } from './canopy-map.js';
import { requestContextHeaders, type MycoRequestContext } from './request-context.js';
import { buildEndpoint } from './shared.js';
import type { ToolFailure } from './error.js';

export type CortexFailure = ToolFailure;

const DEFAULT_CONTEXT_TIER = 5000;
const NO_DIGEST_MESSAGE = 'Digest context is not yet available. The first digest cycle has not completed.';

export interface CortexInput {
  op?: 'digest' | 'instructions' | 'canopy_map' | 'canopy_entry' | 'notifications' | 'maintenance_summary' | 'projects_activity';
  tier?: number;
  id?: string;
  project_id?: string;
  path?: string;
  unread_only?: boolean;
  limit?: number;
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

interface ResolvedCanopyEntry {
  projectId: string;
  path: string;
}

export async function handleCortexDigest(
  input: CortexInput,
  client: DaemonClient,
  requestContext?: MycoRequestContext,
): Promise<CortexDigestResult> {
  const requestedTier = input.tier ?? DEFAULT_CONTEXT_TIER;

  const result = requestContext
    ? await client.get('/api/digest', { headers: requestContextHeaders(requestContext) })
    : await client.get('/api/digest');
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

export async function handleCortexInstructions(
  client: DaemonClient,
  requestContext?: MycoRequestContext,
): Promise<unknown | CortexFailure> {
  const result = requestContext
    ? await client.get('/api/cortex/instructions', { headers: requestContextHeaders(requestContext) })
    : await client.get('/api/cortex/instructions');
  if (!result.ok || !result.data) return { ok: false, error: 'Cortex instructions not available' };
  return result.data;
}

export async function handleCortexCanopyMap(args: CortexCanopyArgs): Promise<CanopyMapResult> {
  return handleCanopyMap(args);
}

export async function handleCortexCanopyEntry(
  input: CortexInput,
  requestContext?: MycoRequestContext,
): Promise<unknown | CortexFailure> {
  const resolved = resolveCanopyEntry(input, requestContext);
  if (!resolved) {
    return { ok: false, error: 'id or project_id plus path is required for op: canopy_entry' };
  }
  if ('error' in resolved) {
    return { ok: false, error: resolved.error };
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

/**
 * Stream J — agent-native parity reads (op: "notifications" |
 * "maintenance_summary" | "projects_activity").
 *
 * Each handler proxies a daemon GET endpoint that today is reachable
 * only from the UI. Wrapping them in `myco_cortex` ops lets agents
 * answer dashboard-shaped questions ("are any Groves overdue for
 * backup?", "which projects are still active?", "what notifications
 * are pending?") without shelling out to HTTP. All three are
 * read-only and forward the request context as headers so the daemon
 * can scope per Grove/project the same way the UI does.
 */
export async function handleCortexNotifications(
  input: { unread_only?: boolean; limit?: number },
  client: DaemonClient,
  requestContext?: MycoRequestContext,
): Promise<unknown | CortexFailure> {
  const endpoint = buildEndpoint('/api/notifications', {
    unread_only: input.unread_only ? 'true' : undefined,
    limit: input.limit,
  });
  const result = requestContext
    ? await client.get(endpoint, { headers: requestContextHeaders(requestContext) })
    : await client.get(endpoint);
  if (!result.ok || !result.data) {
    return { ok: false, error: 'Notifications unavailable' };
  }
  return result.data;
}

export async function handleCortexMaintenanceSummary(
  client: DaemonClient,
  requestContext?: MycoRequestContext,
): Promise<unknown | CortexFailure> {
  const result = requestContext
    ? await client.get('/api/maintenance/summary', { headers: requestContextHeaders(requestContext) })
    : await client.get('/api/maintenance/summary');
  if (!result.ok || !result.data) {
    return { ok: false, error: 'Maintenance summary unavailable' };
  }
  return result.data;
}

export async function handleCortexProjectsActivity(
  client: DaemonClient,
  requestContext?: MycoRequestContext,
): Promise<unknown | CortexFailure> {
  const result = requestContext
    ? await client.get('/api/projects/activity', { headers: requestContextHeaders(requestContext) })
    : await client.get('/api/projects/activity');
  if (!result.ok || !result.data) {
    return { ok: false, error: 'Projects activity feed unavailable' };
  }
  return result.data;
}

function resolveCanopyEntry(
  input: CortexInput,
  requestContext?: MycoRequestContext,
): ResolvedCanopyEntry | { error: string } | null {
  if (requestContext && input.path) {
    return { projectId: requestContext.projectId, path: input.path };
  }
  if (requestContext && input.id) {
    const parsed = parseCanopyRecordId(input.id);
    if (!parsed) return null;
    if (parsed.projectId !== requestContext.projectId) {
      return { error: 'Canopy entry is outside the current project context' };
    }
    return parsed;
  }
  if (input.project_id && input.path) {
    return { projectId: input.project_id, path: input.path };
  }
  if (!input.id) return null;
  return parseCanopyRecordId(input.id);
}
