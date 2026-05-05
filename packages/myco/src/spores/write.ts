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
import {
  rowProjectIdFromRequestContext,
  type MycoRequestContext,
} from '@myco/tools/request-context.js';

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
  status: 'superseded';
}

export interface SporeWriteFailure {
  ok: false;
  error: string;
}

export function supersedeSpore(input: SupersedeSporeInput): SupersedeSporeResult | SporeWriteFailure {
  const now = epochSeconds();
  const projectId = rowProjectIdFromRequestContext(input.requestContext);

  if (!getSpore(input.old_spore_id, projectId)) {
    return { ok: false, error: 'old_spore_id not found' };
  }
  if (!getSpore(input.new_spore_id, projectId)) {
    return { ok: false, error: 'new_spore_id not found' };
  }

  const updated = updateSporeStatus(input.old_spore_id, 'superseded', now, projectId);
  if (!updated) return { ok: false, error: 'old_spore_id not found' };

  registerMcpUserAgent(now);

  insertResolutionEvent({
    id: `res-${randomBytes(RESOLUTION_ID_RANDOM_BYTES).toString('hex')}`,
    project_id: projectId,
    agent_id: USER_AGENT_ID,
    spore_id: input.old_spore_id,
    action: 'supersede',
    new_spore_id: input.new_spore_id,
    reason: input.reason ?? null,
    created_at: now,
  });

  return {
    old_spore: input.old_spore_id,
    new_spore: input.new_spore_id,
    status: 'superseded',
  };
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
  sources_superseded: string[];
  status: 'consolidated';
  created_at: number;
}

export function consolidateSpores(input: ConsolidateSporesInput): ConsolidateSporesResult | SporeWriteFailure {
  const now = epochSeconds();
  const newSporeId = `${input.observation_type}-${randomBytes(SPORE_ID_RANDOM_BYTES).toString('hex')}`;
  const projectId = rowProjectIdFromRequestContext(input.requestContext);

  const missingSource = input.source_spore_ids.find((sourceId) => !getSpore(sourceId, projectId));
  if (missingSource) {
    return { ok: false, error: `source_spore_id not found: ${missingSource}` };
  }

  registerMcpUserAgent(now);

  const db = getDatabase();
  const sourcesSuperseded = db.transaction(() => {
    insertSpore({
      id: newSporeId,
      project_id: projectId,
      agent_id: USER_AGENT_ID,
      observation_type: input.observation_type,
      content: input.consolidated_content,
      tags: input.tags ? input.tags.join(', ') : null,
      created_at: now,
    });

    const superseded: string[] = [];
    for (const sourceId of input.source_spore_ids) {
      const updated = updateSporeStatus(sourceId, 'superseded', now, projectId);
      if (!updated) throw new Error(`source_spore_id not found: ${sourceId}`);
      insertResolutionEvent({
        id: `res-${randomBytes(RESOLUTION_ID_RANDOM_BYTES).toString('hex')}`,
        project_id: projectId,
        agent_id: USER_AGENT_ID,
        spore_id: sourceId,
        action: 'consolidate',
        new_spore_id: newSporeId,
        reason: input.reason ?? null,
        created_at: now,
      });
      superseded.push(sourceId);
    }
    return superseded;
  })();

  return {
    new_spore_id: newSporeId,
    sources_superseded: sourcesSuperseded,
    status: 'consolidated',
    created_at: now,
  };
}
