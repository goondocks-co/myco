/**
 * A dismissal from "Needs you" as one commit: the machine's dismissed repositories, optionally its folders never asked
 * about, and the repository's waiting row, together or not at all. Each leaf must still hold the text the edit read and
 * the actor must still claim the machine, or the batch stops and nothing changes.
 */
import type { RelationalStore } from '../../core/adapters.js';
import { assertion, commit, refusalCode, refused, write } from '../index.js';
import { clearUncaptured } from '../sessions/uncaptured-reports.js';
import { claimedBy } from './machines.js';

export const DISMISSAL_CHANGED = refusalCode('machine_dismissal_changed');

const leafHeld = assertion<[machine: string, leaf: string, previous: string | null, actor: string]>({ name: 'machineSettings.dismissalLeafHeld', refusal: DISMISSAL_CHANGED, when:
  `${claimedBy('?1', '?4')} AND (SELECT value FROM machine_settings WHERE machine_id = ?1 AND leaf = ?2) IS ?3` });
const putLeaf = write<[machine: string, leaf: string, value: string, now: number, actor: string]>({ name: 'machineSettings.dismissalPut', sql:
  `INSERT INTO machine_settings (machine_id, leaf, value, updated_at, updated_by) VALUES (?1, ?2, ?3, ?4, ?5)
   ON CONFLICT (machine_id, leaf) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by` });

/** One leaf's edit: the stored text it was computed from (null when absent) and the text it writes. */
export interface LeafEdit { leaf: string; previous: string | null; value: string }

/** Commit the edits and forget the waiting row; false when a leaf or the claim moved under it, with nothing written. */
export async function commitDismissal(db: RelationalStore, input: { machine: string; rootKey: string; actor: string; now: number; edits: readonly LeafEdit[] }): Promise<boolean> {
  const { machine, rootKey, actor, now, edits } = input;
  try {
    await commit(db,
      ...edits.map((edit) => leafHeld.bind(machine, edit.leaf, edit.previous, actor)),
      ...edits.map((edit) => putLeaf.bind(machine, edit.leaf, edit.value, now, actor)),
      clearUncaptured(machine, rootKey));
    return true;
  } catch (error) {
    if (refused(error, DISMISSAL_CHANGED)) return false;
    throw error;
  }
}
