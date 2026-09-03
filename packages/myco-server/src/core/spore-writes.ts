/**
 * What a spore write must satisfy before it reaches the store.
 *
 * Two writers reach the same rows — a member through `myco_spores`, a harness
 * run through the run routes — and one set of checks serves both. A resolution
 * a member may not make is one a run may not make either, refused in the same
 * words, so the two surfaces cannot drift into disagreeing about what a valid
 * supersession is.
 *
 * The checks name what is missing and what the store does not hold; the write
 * itself stays in `core/spores.ts`, where a status move and its resolution
 * event commit together.
 */
import type { RelationalStore } from './adapters.js';
import type { ReadScope } from '../read/scope.js';
import { getSpore, MAX_SPORE_CONTENT_BYTES, type ResolutionAction, type SporeStatus } from './spores.js';

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
  sources?: readonly string[];
  content?: string;
  observationType?: string;
}

/**
 * A resolution the store will accept, with the status the move lands on. A
 * consolidate comes in two shapes: one that names the sources and the body that
 * replaces them, recording the wisdom spore as part of the move, and one that
 * moves a single source into a wisdom spore already recorded.
 */
export type SporeResolutionPlan =
  | { action: 'supersede'; status: SporeStatus; sporeId: string; newSporeId: string; reason: string | null }
  | { action: 'obsolete'; status: SporeStatus; sporeId: string; reason: string }
  | { action: 'consolidate'; status: SporeStatus; sporeId: string; newSporeId: string; reason: string | null }
  | { action: 'consolidate'; status: SporeStatus; sources: readonly string[]; content: string; observationType: string; reason: string | null };

export type SporeResolutionOutcome = { ok: true; plan: SporeResolutionPlan } | { ok: false; reason: string };

/**
 * The resolution this request describes, or the one thing wrong with it.
 *
 * A supersede names both ends and the store holds both; an obsolete says what
 * changed; a consolidate names its sources, the body that replaces them and the
 * kind that body is recorded as. An `obsolete` spore the store does not hold is
 * left to the write, which reports it moved nothing.
 */
export async function planSporeResolution(
  db: RelationalStore,
  scope: ReadScope,
  request: SporeResolutionRequest,
): Promise<SporeResolutionOutcome> {
  if (request.action === 'supersede') {
    const sporeId = request.sporeId;
    const newSporeId = request.newSporeId;
    if (sporeId === undefined) return { ok: false, reason: 'old_spore_id is required for op: supersede' };
    if (newSporeId === undefined) return { ok: false, reason: 'new_spore_id is required for op: supersede' };
    if ((await getSpore(db, scope, sporeId)) === null) return { ok: false, reason: 'old_spore_id not found' };
    if ((await getSpore(db, scope, newSporeId)) === null) return { ok: false, reason: 'new_spore_id not found' };
    return { ok: true, plan: { action: 'supersede', status: 'superseded', sporeId, newSporeId, reason: request.reason ?? null } };
  }

  if (request.action === 'obsolete') {
    const sporeId = request.sporeId;
    if (sporeId === undefined) return { ok: false, reason: 'id is required for op: obsolete' };
    if (request.reason === undefined) return { ok: false, reason: 'reason is required for op: obsolete' };
    return { ok: true, plan: { action: 'obsolete', status: 'obsolete', sporeId, reason: request.reason } };
  }

  const sources = request.sources ?? [];
  const content = request.content;
  const observationType = request.observationType;
  if (sources.length === 0 && (request.sporeId !== undefined || request.newSporeId !== undefined)) {
    const sporeId = request.sporeId;
    const newSporeId = request.newSporeId;
    if (sporeId === undefined) return { ok: false, reason: 'spore_id is required for op: consolidate' };
    if (newSporeId === undefined) return { ok: false, reason: 'new_spore_id is required for op: consolidate' };
    if ((await getSpore(db, scope, sporeId)) === null) return { ok: false, reason: 'spore_id not found' };
    if ((await getSpore(db, scope, newSporeId)) === null) return { ok: false, reason: 'new_spore_id not found' };
    return { ok: true, plan: { action: 'consolidate', status: 'consolidated', sporeId, newSporeId, reason: request.reason ?? null } };
  }
  if (sources.length === 0) return { ok: false, reason: 'source_spore_ids is required for op: consolidate' };
  if (content === undefined) return { ok: false, reason: 'consolidated_content is required for op: consolidate' };
  if (observationType === undefined) return { ok: false, reason: 'observation_type is required for op: consolidate' };
  if (overSporeCap(content)) return { ok: false, reason: SPORE_CAP_REASON };
  for (const id of sources) {
    if ((await getSpore(db, scope, id)) === null) return { ok: false, reason: `source_spore_id not found: ${id}` };
  }
  return { ok: true, plan: { action: 'consolidate', status: 'consolidated', sources, content, observationType, reason: request.reason ?? null } };
}
