/** Admission for spore content, citations and lifecycle expectations across callers. */
import type { RelationalStore } from './adapters.js';
import type { ReadScope } from '../read/scope.js';
import { getSpore, sporeRevisionRequired, MAX_SPORE_CONTENT_BYTES, type ResolutionAction, type SporeStatus, type SporeExpectation, type SporeSource, SPORE_STATUSES } from './spores.js';

export const SPORE_CAP_REASON = `content exceeds ${MAX_SPORE_CONTENT_BYTES} bytes`;

/** True when a body is larger than one spore row accepts. */
export function overSporeCap(text: string): boolean {
  return new TextEncoder().encode(text).byteLength > MAX_SPORE_CONTENT_BYTES;
}

/** `<type>-<8 hex>`, the id shape a recorded spore carries. */
export function mintSporeId(type: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return `${type}-${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** The tag list a caller names, as the one text column the row holds; null when it names none. */
export function sporeTags(value: unknown): string | null {
  return Array.isArray(value) && value.length > 0 ? value.map(String).join(', ') : null;
}

/** A resolution as a caller asks for it, whatever names its own surface gives the fields. */
export interface SporeResolutionRequest {
  action: ResolutionAction;
  sporeId?: string;
  newSporeId?: string;
  reason?: string;
}

/** A resolution the store will accept: one spore moving, with the status it lands on and the spore it lands under. */
export interface SporeResolutionPlan {
  action: ResolutionAction;
  status: SporeStatus;
  sporeId: string;
  newSporeId: string | null;
  reason: string | null;
}

export type SporeResolutionOutcome = { ok: true; plan: SporeResolutionPlan } | { ok: false; reason: string };

/**
 * The resolution this request describes, or the one thing wrong with it.
 *
 * Every action moves one named spore: a supersede and a consolidate name the
 * spore that replaces it and the store holds both ends; an obsolete says what
 * changed instead. A spore the store does not hold is left to the write for
 * `obsolete`, which reports it moved nothing.
 */
export async function planSporeResolution(
  db: RelationalStore,
  scope: ReadScope,
  request: SporeResolutionRequest,
): Promise<SporeResolutionOutcome> {
  if (request.action === 'obsolete') {
    const sporeId = request.sporeId;
    if (sporeId === undefined) return { ok: false, reason: 'id is required for op: obsolete' };
    if (request.reason === undefined) return { ok: false, reason: 'reason is required for op: obsolete' };
    return { ok: true, plan: { action: 'obsolete', status: 'obsolete', sporeId, newSporeId: null, reason: request.reason } };
  }

  const supersede = request.action === 'supersede';
  const names = supersede ? { spore: 'old_spore_id', successor: 'new_spore_id' } : { spore: 'spore_id', successor: 'new_spore_id' };
  const sporeId = request.sporeId;
  const newSporeId = request.newSporeId;
  if (sporeId === undefined) return { ok: false, reason: `${names.spore} is required for op: ${request.action}` };
  if (newSporeId === undefined) return { ok: false, reason: `${names.successor} is required for op: ${request.action}` };
  if ((await getSpore(db, scope, sporeId)) === null) return { ok: false, reason: `${names.spore} not found` };
  if ((await getSpore(db, scope, newSporeId)) === null) return { ok: false, reason: `${names.successor} not found` };
  return {
    ok: true,
    plan: { action: request.action, status: supersede ? 'superseded' : 'consolidated', sporeId, newSporeId, reason: request.reason ?? null },
  };
}

/** A consolidation that records the wisdom spore as part of the move: the sources it merges, and the body and kind that replace them. */
export interface SporeConsolidationRequest {
  sources?: readonly SporeSource[];
  content?: string;
  observationType?: string;
  reason?: string;
}

export interface SporeConsolidationPlan {
  sources: readonly SporeSource[];
  content: string;
  observationType: string;
  reason: string | null;
}

export type SporeConsolidationOutcome = { ok: true; plan: SporeConsolidationPlan } | { ok: false; reason: string };

/**
 * The consolidation this request describes, or the one thing wrong with it.
 *
 * The member's tool merges a set into a wisdom spore it records in the same
 * write. A run's surface names one source and a wisdom spore already recorded
 * instead, which is `planSporeResolution` above; the checks a body must pass
 * are these.
 */
export async function planSporeConsolidation(
  db: RelationalStore,
  scope: ReadScope,
  request: SporeConsolidationRequest,
): Promise<SporeConsolidationOutcome> {
  const sources = request.sources ?? [];
  const content = request.content;
  const observationType = request.observationType;
  if (sources.length === 0) return { ok: false, reason: 'source_spore_ids is required for op: consolidate' };
  if (content === undefined) return { ok: false, reason: 'consolidated_content is required for op: consolidate' };
  if (observationType === undefined) return { ok: false, reason: 'observation_type is required for op: consolidate' };
  if (overSporeCap(content)) return { ok: false, reason: SPORE_CAP_REASON };
  for (const { id } of sources) {
    if ((await getSpore(db, scope, id)) === null) return { ok: false, reason: `source_spore_id not found: ${id}` };
  }
  return { ok: true, plan: { sources, content, observationType, reason: request.reason ?? null } };
}

/** Admit one lifecycle call's expectations for its editorial or run authority. */
export async function sporeExpectations(
  db: RelationalStore, scope: ReadScope, input: Record<string, unknown>, runId?: string,
): Promise<{ ok: true; expect: SporeExpectation; sources?: SporeSource[] } | { ok: false; reason: string }> {
  const status = input.expect_status;
  const revision = input.expect_revision;
  if (status !== undefined && !(SPORE_STATUSES as readonly unknown[]).includes(status)) return { ok: false, reason: 'expect_status must be a spore status' };
  const validRevision = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  if (revision !== undefined && !validRevision(revision)) return { ok: false, reason: 'expect_revision must be a nonnegative safe integer' };
  let required = false;
  if (runId !== undefined) {
    if (status !== undefined && status !== 'active') return { ok: false, reason: 'runs require expect_status active' };
    required = await sporeRevisionRequired(db, scope, runId);
  }
  let sources: SporeSource[] | undefined;
  if (input.op === 'consolidate') {
    if (!Array.isArray(input.source_spore_ids)) return { ok: false, reason: 'source_spore_ids must be an array' };
    if (status !== undefined && status !== 'active') return { ok: false, reason: 'consolidation requires expect_status active' };
    sources = [];
    for (const value of input.source_spore_ids) {
      const source = typeof value === 'string' ? { id: value } : value;
      if (typeof source !== 'object' || source === null || Array.isArray(source)
        || typeof source.id !== 'string' || source.id.length === 0
        || Object.keys(source).some(key => key !== 'id' && key !== 'revision')
        || (source.revision !== undefined && !validRevision(source.revision))) {
        return { ok: false, reason: 'source_spore_ids requires ids or {id, revision?}' };
      }
      if (required && source.revision === undefined) return { ok: false, reason: 'revision is required for every source_spore_ids item' };
      if (sources.some(held => held.id === source.id)) return { ok: false, reason: 'source_spore_ids must be distinct' };
      sources.push({ id: source.id, ...(source.revision === undefined ? {} : { revision: source.revision }) });
    }
  } else if (required && revision === undefined) return { ok: false, reason: 'expect_revision is required' };
  return { ok: true, expect: { status: status as SporeStatus | undefined, revision: revision as number | undefined }, ...(sources === undefined ? {} : { sources }) };
}
