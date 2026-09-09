/**
 * The bounds a bounded import runs under, and the one encoding of the switch
 * that turns it off.
 *
 * A member enumerates its own disk, so the bounds on how much of that disk
 * reaches a Deployment are the Deployment's to set (#1148). Two of the three
 * can only be applied where the whole pass is visible: a single write carries
 * neither a window nor a per-harness count, so `import.window_days` and
 * `import.max_sessions_per_harness` are applied when the pass is planned and
 * are not re-derivable from one event. `import.enabled` is different — it is a
 * property of the Deployment, readable on any request — so it is also an
 * admission on the write path, and a member that skipped the plan still writes
 * nothing.
 *
 * **`LEAF_OFF` is the one comparison both sides make.** The admission fragment
 * binds it as a parameter and the plan compares the stored text against it, so
 * the SQL and the TypeScript ask the same question of the same string. Reading
 * one side with `JSON.parse` and binding a literal on the other would be two
 * encodings of one value, free to disagree the first time a leaf is written by
 * a path that spells `false` differently.
 *
 * A leaf never written is enabled: an import runs at join, so the leaf exists
 * to turn that off rather than to permit it.
 */
import type { RelationalStore } from './adapters.js';
import { refusal, type Refusal } from '../telemetry.js';
import { IMPORT_MAX_SESSIONS_MAX, IMPORT_WINDOW_DAYS_MAX } from '../constants.js';
import { leafValues } from './settings.js';

export const IMPORT_ENABLED_LEAF = 'import.enabled';
export const IMPORT_WINDOW_DAYS_LEAF = 'import.window_days';
export const IMPORT_MAX_SESSIONS_LEAF = 'import.max_sessions_per_harness';

/** Every leaf this policy reads, in one list so the route and the tests enumerate rather than spell. */
export const IMPORT_LEAVES: readonly string[] = [IMPORT_ENABLED_LEAF, IMPORT_WINDOW_DAYS_LEAF, IMPORT_MAX_SESSIONS_LEAF];

/** The stored form of a leaf a Deployment has turned off, in the encoding the settings surface writes. */
export const LEAF_OFF = JSON.stringify(false);

/** What a member is answered when it offers import-channel bytes to a Deployment that has import switched off. */
export const IMPORT_DISABLED: Refusal = refusal('import is disabled on this Deployment', 'import_disabled');

/** The bounds when a Deployment has set none: the anchor's newest 50 sessions per harness within 30 days. */
export const IMPORT_WINDOW_DAYS_DEFAULT = 30;
export const IMPORT_MAX_SESSIONS_DEFAULT = 50;

export interface ImportPolicy {
  enabled: boolean;
  windowDays: number;
  maxPerAgent: number;
}

/** What a caller may ask to widen. Absent means the Deployment's own bound. */
export interface ImportPolicyAsk {
  windowDays?: number;
  maxPerAgent?: number;
}

/** Whether a leaf's stored text is the off value. The one reader; `LEAF_OFF` is what the admission binds. */
export const leafIsOff = (raw: string | undefined): boolean => raw === LEAF_OFF;

/** A stored integer leaf, or the fallback when it is absent or unreadable. */
function storedInteger(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return fallback; }
  return typeof parsed === 'number' && Number.isInteger(parsed) ? parsed : fallback;
}

const clamp = (value: number, max: number): number => Math.min(max, Math.max(1, Math.trunc(value)));

/**
 * The bounds this pass runs under: the Deployment's, widened by what the caller
 * asked for, clamped to the leaf's own range.
 *
 * A caller asking for less than the Deployment allows gets what it asked for;
 * a caller asking for more gets it up to the ceiling. Both are the repeatable
 * command's purpose — the join-time pass asks for nothing and takes the
 * Deployment's bound.
 */
export async function importPolicy(db: RelationalStore, ask: ImportPolicyAsk = {}): Promise<ImportPolicy> {
  const values = await leafValues(db, IMPORT_LEAVES);
  return {
    enabled: !leafIsOff(values.get(IMPORT_ENABLED_LEAF)),
    windowDays: clamp(ask.windowDays ?? storedInteger(values.get(IMPORT_WINDOW_DAYS_LEAF), IMPORT_WINDOW_DAYS_DEFAULT), IMPORT_WINDOW_DAYS_MAX),
    maxPerAgent: clamp(ask.maxPerAgent ?? storedInteger(values.get(IMPORT_MAX_SESSIONS_LEAF), IMPORT_MAX_SESSIONS_DEFAULT), IMPORT_MAX_SESSIONS_MAX),
  };
}
