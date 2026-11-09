/** Admission for spore content, citations and lifecycle expectations across callers. */
import { MAX_SPORE_CONTENT_BYTES, type ResolutionAction, type SporeStatus, SPORE_STATUSES } from './spores.js';
import type { SporeExpectation, SporeSource } from '../db/spores/lifecycle.js';

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
interface SporeResolutionRequest {
  action: ResolutionAction;
  sporeId?: string;
  newSporeId?: string;
  reason?: string;
}

/** A resolution the store will accept: one spore moving, with the status it lands on and the spore it lands under. */
interface SporeResolutionPlan {
  action: ResolutionAction;
  status: SporeStatus;
  sporeId: string;
  newSporeId: string | null;
  reason: string | null;
}

type SporeResolutionOutcome = { ok: true; plan: SporeResolutionPlan } | { ok: false; reason: string };

/**
 * The resolution this request describes, or the one thing wrong with it.
 *
 * Every action moves one named spore: a supersede and a consolidate name the spore that replaces it; an obsolete says what changed instead. Whether the
 * store holds either end is the write's own commit to decide.
 */
export function planSporeResolution(request: SporeResolutionRequest): SporeResolutionOutcome {
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
  return {
    ok: true,
    plan: { action: request.action, status: supersede ? 'superseded' : 'consolidated', sporeId, newSporeId, reason: request.reason ?? null },
  };
}

/** A consolidation that records the wisdom spore as part of the move: the sources it merges, and the body and kind that replace them. */
interface SporeConsolidationRequest {
  sources?: readonly SporeSource[];
  content?: string;
  observationType?: string;
  reason?: string;
}

interface SporeConsolidationPlan {
  sources: readonly SporeSource[];
  content: string;
  observationType: string;
  reason: string | null;
}

type SporeConsolidationOutcome = { ok: true; plan: SporeConsolidationPlan } | { ok: false; reason: string };

/**
 * The consolidation this request describes, or the one thing wrong with it.
 *
 * The member's tool merges a set into a wisdom spore it records in the same
 * write. A run's surface names one source and a wisdom spore already recorded
 * instead, which is `planSporeResolution` above; the checks a body must pass
 * are these.
 */
export function planSporeConsolidation(request: SporeConsolidationRequest): SporeConsolidationOutcome {
  const sources = request.sources ?? [];
  const content = request.content;
  const observationType = request.observationType;
  if (sources.length === 0) return { ok: false, reason: 'source_spore_ids is required for op: consolidate' };
  if (content === undefined) return { ok: false, reason: 'consolidated_content is required for op: consolidate' };
  if (observationType === undefined) return { ok: false, reason: 'observation_type is required for op: consolidate' };
  if (overSporeCap(content)) return { ok: false, reason: `${SPORE_CAP_REASON}; consolidated_content is ${new TextEncoder().encode(content).byteLength} UTF-8 bytes` };
  return { ok: true, plan: { sources, content, observationType, reason: request.reason ?? null } };
}

/** Admit one lifecycle call's expectations for its editorial or run authority. */
export function sporeExpectations(input: Record<string, unknown>, runId?: string): { ok: true; expect: SporeExpectation; sources?: SporeSource[] } | { ok: false; reason: string } {
  const status = input.expect_status;
  const revision = input.expect_revision;
  if (status !== undefined && !(SPORE_STATUSES as readonly unknown[]).includes(status)) return { ok: false, reason: `expect_status is ${JSON.stringify(status)}; expected ${SPORE_STATUSES.join(', ')}` };
  const validRevision = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  if (revision !== undefined && !validRevision(revision)) return { ok: false, reason: `expect_revision is ${JSON.stringify(revision)}; expected an integer from 0 to ${Number.MAX_SAFE_INTEGER}` };
  const required = runId !== undefined;
  if (required && status !== undefined && status !== 'active') return { ok: false, reason: `expect_status is ${JSON.stringify(status)}; runs require active` };
  let sources: SporeSource[] | undefined;
  if (input.op === 'consolidate') {
    if (!Array.isArray(input.source_spore_ids)) return { ok: false, reason: 'source_spore_ids must be an array' };
    if (status !== undefined && status !== 'active') return { ok: false, reason: 'consolidation requires expect_status active' };
    sources = [];
    for (const [index,value] of input.source_spore_ids.entries()) {
      const source = typeof value === 'string' ? { id: value } : value;
      if (typeof source !== 'object' || source === null || Array.isArray(source)
        || typeof source.id !== 'string' || source.id.length === 0
        || Object.keys(source).some(key => key !== 'id' && key !== 'revision')
        || (source.revision !== undefined && !validRevision(source.revision))) {
        return { ok: false, reason: `source_spore_ids[${index}] requires a nonempty id or {id,revision}, with revision an integer from 0 to ${Number.MAX_SAFE_INTEGER}` };
      }
      if (required && source.revision === undefined) return { ok: false, reason: `source_spore_ids[${index}] (${JSON.stringify(source.id)}) is missing revision; use the exact revision read` };
      if (sources.some(held => held.id === source.id)) return { ok: false, reason: `source_spore_ids[${index}] duplicates ${JSON.stringify(source.id)}; each source must be distinct` };
      sources.push({ id: source.id, ...(source.revision === undefined ? {} : { revision: source.revision }) });
    }
  } else if (required && revision === undefined) return { ok: false, reason: 'expect_revision is required' };
  return { ok: true, expect: { status: status as SporeStatus | undefined, revision: revision as number | undefined }, ...(sources === undefined ? {} : { sources }) };
}
