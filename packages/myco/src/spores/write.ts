/**
 * Spore write operations callable from any process that has the vault DB
 * initialized. Multi-process safety relies on SQLite WAL mode.
 *
 * No synchronous embedding nudge: the daemon's reconcile sweep
 * (`daemon/embedding/manager.ts`) picks up unembedded rows on its own
 * schedule, so writes from non-daemon processes get embedded without an
 * explicit notification path.
 */

import { randomBytes } from 'node:crypto';
import { epochSeconds, USER_AGENT_ID, USER_AGENT_NAME } from '@myco/constants.js';
import { getDatabase } from '@myco/db/client.js';
import { registerAgent } from '@myco/db/queries/agents.js';
import { getSpore, insertSpore, updateSporeStatus, type SporeRow } from '@myco/db/queries/spores.js';
import { insertResolutionEvent } from '@myco/db/queries/resolution-events.js';
import { type ProjectScope } from '@myco/db/queries/project-scope.js';
import {
  RESOLUTION_ACTION,
  RESOLUTION_ACTION_TO_STATUS,
  type SporeStatus,
  type ResolutionAction,
} from '@myco/constants/spore-status.js';
import {
  projectScopeFromRequestContext,
  rowProjectIdFromRequestContext,
  type MycoRequestContext,
} from '@myco/grove/request-context.js';

const SPORE_ID_RANDOM_BYTES = 4;
const RESOLUTION_ID_RANDOM_BYTES = 8;
const DEFAULT_OBSERVATION_TYPE = 'discovery';

function registerMcpUserAgent(createdAt: number): void {
  registerAgent({
    id: USER_AGENT_ID,
    name: USER_AGENT_NAME,
    created_at: createdAt,
  });
}

export interface SaveSporeInput {
  content: string;
  type?: string;
  tags?: string[];
  requestContext?: MycoRequestContext;
}

export interface SaveSporeResult {
  id: string;
  observation_type: string;
  status: SporeRow['status'];
  created_at: number;
}

export function saveSpore(input: SaveSporeInput): SaveSporeResult {
  const observationType = input.type ?? DEFAULT_OBSERVATION_TYPE;
  const id = `${observationType}-${randomBytes(SPORE_ID_RANDOM_BYTES).toString('hex')}`;
  const now = epochSeconds();
  const projectId = rowProjectIdFromRequestContext(input.requestContext);

  registerMcpUserAgent(now);

  const spore = insertSpore({
    id,
    project_id: projectId,
    agent_id: USER_AGENT_ID,
    observation_type: observationType,
    content: input.content,
    tags: input.tags ? input.tags.join(', ') : null,
    created_at: now,
  });

  return {
    id: spore.id,
    observation_type: spore.observation_type,
    status: spore.status,
    created_at: spore.created_at,
  };
}

export interface SupersedeSporeInput {
  old_spore_id: string;
  new_spore_id: string;
  reason?: string;
  requestContext?: MycoRequestContext;
}

export interface SupersedeSporeResult {
  old_spore: string;
  new_spore: string;
  status: SporeStatus;
}

export interface SporeWriteFailure {
  ok: false;
  error: string;
}

export interface ApplySporeResolutionInput {
  spore_id: string;
  action: ResolutionAction;
  new_spore_id?: string | null;
  reason?: string | null;
  session_id?: string | null;
  scope: ProjectScope;
  project_id?: string | null;
  agent_id: string;
  machine_id?: string;
  now?: number;
}

export interface ApplySporeResolutionResult {
  ok: true;
  spore: SporeRow;
  status: SporeStatus;
  resolution_event_id: string;
}

/**
 * Shared core for every spore status transition: flip the spore's status
 * (derived from the action via RESOLUTION_ACTION_TO_STATUS) and record a
 * resolution event. Both the symbiont write helpers below and the agent
 * harness `vault_resolve_spore` tool route through this, so the two paths
 * never drift on status semantics.
 *
 * Callers own existence validation and any domain-specific error messages;
 * this returns a generic failure only if the target row vanished.
 */
export function applySporeResolution(
  input: ApplySporeResolutionInput,
): ApplySporeResolutionResult | SporeWriteFailure {
  const now = input.now ?? epochSeconds();
  const status = RESOLUTION_ACTION_TO_STATUS[input.action];

  const updated = updateSporeStatus(input.spore_id, status, now, input.scope);
  if (!updated) return { ok: false, error: `spore not found: ${input.spore_id}` };

  const resolutionEventId = `res-${randomBytes(RESOLUTION_ID_RANDOM_BYTES).toString('hex')}`;
  insertResolutionEvent({
    id: resolutionEventId,
    project_id: input.project_id ?? null,
    agent_id: input.agent_id,
    machine_id: input.machine_id,
    spore_id: input.spore_id,
    action: input.action,
    new_spore_id: input.new_spore_id ?? null,
    reason: input.reason ?? null,
    session_id: input.session_id ?? null,
    created_at: now,
  });

  return { ok: true, spore: updated, status, resolution_event_id: resolutionEventId };
}

export function supersedeSpore(input: SupersedeSporeInput): SupersedeSporeResult | SporeWriteFailure {
  const now = epochSeconds();
  const projectId = rowProjectIdFromRequestContext(input.requestContext);
  const scope = projectScopeFromRequestContext(input.requestContext);

  if (!getSpore(input.old_spore_id, scope)) {
    return { ok: false, error: 'old_spore_id not found' };
  }
  if (!getSpore(input.new_spore_id, scope)) {
    return { ok: false, error: 'new_spore_id not found' };
  }

  registerMcpUserAgent(now);

  const result = applySporeResolution({
    spore_id: input.old_spore_id,
    action: RESOLUTION_ACTION.SUPERSEDE,
    new_spore_id: input.new_spore_id,
    reason: input.reason,
    scope,
    project_id: projectId,
    agent_id: USER_AGENT_ID,
    now,
  });
  if (!result.ok) return result;

  return {
    old_spore: input.old_spore_id,
    new_spore: input.new_spore_id,
    status: result.status,
  };
}

export interface ObsoleteSporeInput {
  spore_id: string;
  reason: string;
  requestContext?: MycoRequestContext;
}

export interface ObsoleteSporeResult {
  spore: string;
  status: SporeStatus;
}

/**
 * Retire a spore with no replacement — e.g. a dropped feature, or knowledge
 * that is simply no longer relevant. The replacement-free counterpart to
 * supersede/consolidate.
 */
export function obsoleteSpore(input: ObsoleteSporeInput): ObsoleteSporeResult | SporeWriteFailure {
  const now = epochSeconds();
  const projectId = rowProjectIdFromRequestContext(input.requestContext);
  const scope = projectScopeFromRequestContext(input.requestContext);

  if (!getSpore(input.spore_id, scope)) {
    return { ok: false, error: 'spore_id not found' };
  }

  registerMcpUserAgent(now);

  const result = applySporeResolution({
    spore_id: input.spore_id,
    action: RESOLUTION_ACTION.OBSOLETE,
    reason: input.reason,
    scope,
    project_id: projectId,
    agent_id: USER_AGENT_ID,
    now,
  });
  if (!result.ok) return result;

  return { spore: input.spore_id, status: result.status };
}

export interface ConsolidateSporesInput {
  source_spore_ids: string[];
  consolidated_content: string;
  observation_type: string;
  tags?: string[];
  reason?: string;
  requestContext?: MycoRequestContext;
}

export interface ConsolidateSporesResult {
  new_spore_id: string;
  sources_consolidated: string[];
  status: 'consolidated';
  created_at: number;
}

export function consolidateSpores(input: ConsolidateSporesInput): ConsolidateSporesResult | SporeWriteFailure {
  const now = epochSeconds();
  const newSporeId = `${input.observation_type}-${randomBytes(SPORE_ID_RANDOM_BYTES).toString('hex')}`;
  const projectId = rowProjectIdFromRequestContext(input.requestContext);
  const scope = projectScopeFromRequestContext(input.requestContext);

  const missingSource = input.source_spore_ids.find((sourceId) => !getSpore(sourceId, scope));
  if (missingSource) {
    return { ok: false, error: `source_spore_id not found: ${missingSource}` };
  }

  registerMcpUserAgent(now);

  const db = getDatabase();
  const sourcesConsolidated = db.transaction(() => {
    insertSpore({
      id: newSporeId,
      project_id: projectId,
      agent_id: USER_AGENT_ID,
      observation_type: input.observation_type,
      content: input.consolidated_content,
      tags: input.tags ? input.tags.join(', ') : null,
      created_at: now,
    });

    const resolved: string[] = [];
    for (const sourceId of input.source_spore_ids) {
      const result = applySporeResolution({
        spore_id: sourceId,
        action: RESOLUTION_ACTION.CONSOLIDATE,
        new_spore_id: newSporeId,
        reason: input.reason,
        scope,
        project_id: projectId,
        agent_id: USER_AGENT_ID,
        now,
      });
      if (!result.ok) throw new Error(`source_spore_id not found: ${sourceId}`);
      resolved.push(sourceId);
    }
    return resolved;
  })();

  return {
    new_spore_id: newSporeId,
    sources_consolidated: sourcesConsolidated,
    status: 'consolidated',
    created_at: now,
  };
}
