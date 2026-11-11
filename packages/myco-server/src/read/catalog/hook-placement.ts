import type { RelationalStore as hook_placement_import_RelationalStore } from "../../core/adapters.js";
import { subagentContextIdentities } from '../hook-placement.js';
import { subagentContextKinds, unplacedHookRows } from '../../db/sessions/hook-placement.js';
import { binaryOrder as hook_placement_import_binaryOrder } from "../scope.js";
import { clampLimit as hook_placement_import_clampLimit, decodeCursor as hook_placement_import_decodeCursor } from "../scope.js";
import { page as hook_placement_import_page } from "../scope.js";
import type { ReadScope as hook_placement_import_ReadScope } from "../scope.js";

/** The session's sub-agent context records with their canonical sub-agent ids, as the JSON array the placement reads bind. */
async function hook_placement_sessionContextIdentities(db: hook_placement_import_RelationalStore, scope: hook_placement_import_ReadScope, sessionId: string): Promise<string> {
  const kinds = await subagentContextKinds(db, scope.projectId, sessionId);
  return JSON.stringify(await subagentContextIdentities(kinds));
}

/** Why a record is on no turn: it names no prompt, or it names one this session's live document does not hold. */
type hook_placement_Placement = 'unnamed' | 'unavailable';

interface hook_placement_UnplacedHookRecord {
  key: string; kind: string; id: string; promptHint: string | null; label: string; createdAt: number; placement: hook_placement_Placement;
}

/** Unplaced records stay visible at session level, in immutable capture order. */
async function hook_placement_listUnplacedHookRecords(db: hook_placement_import_RelationalStore, scope: hook_placement_import_ReadScope, sessionId: string, opts: { limit?: number; cursor?: string } = {}) {
  const limit = hook_placement_import_clampLimit(opts.limit);
  const after = opts.cursor === undefined ? null : hook_placement_import_decodeCursor(opts.cursor);
  if (opts.cursor !== undefined && after === null) return { rows: [], cursor: null };
  const identities = await hook_placement_sessionContextIdentities(db, scope, sessionId);
  const sources = await unplacedHookRows(db, { project: scope.projectId, session: sessionId, identities, after, limit: limit + 1 });
  const results = sources.flat().sort((a, b) => a.created_at - b.created_at
    || hook_placement_import_binaryOrder(a.record_key, b.record_key));
  const rows: hook_placement_UnplacedHookRecord[] = results.map(row => ({ key: row.record_key, kind: row.record_kind,
    id: row.record_id, promptHint: row.prompt_hint, label: row.label, createdAt: row.created_at,
    placement: row.prompt_hint === null ? 'unnamed' as const : 'unavailable' as const }));
  return hook_placement_import_page(rows, limit, row => ({ createdAt: row.createdAt, id: row.key }));
}

export {
  hook_placement_listUnplacedHookRecords,
  hook_placement_sessionContextIdentities,
};
