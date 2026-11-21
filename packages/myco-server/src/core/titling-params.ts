/**
 * What a titling run is asked with, and the bounds on what it may write.
 *
 * A leaf: the instruction builder reads these without pulling the dispatcher in.
 */

export const TITLE_HEAD_TURNS = 3;
export const TITLE_TAIL_TURNS = 4;
export const TITLE_MIDDLE_TURNS = 12;

export const SINGLE_TURN_MATERIAL_CHARS = 10_000;
export const SINGLE_TURN_MATERIAL_JSON_BYTES = 20_000;

export const TITLE_MAX_CHARS = 80;
export const SUMMARY_MAX_CHARS = 1200;

/** First titles preserve a standing title; owner asks and quiet-period refreshes replace it from the same bounded arc. */
export type TitlingMode = 'claim' | 'owner' | 'refresh';
const TITLING_MODES: readonly TitlingMode[] = ['claim', 'owner', 'refresh'];

/** The parameters a titling run is dispatched with, as the runtime and the run routes read them back from the run's context the server wrote. */
export interface TitlingParams {
  session_id: string;
  mode: TitlingMode;
  /** The member whose ask this is, on an owner's ask; the write names them as `titled_by`. */
  by?: string;
}

/** The titling parameters a record carries, or null when it names no session in a known mode. */
export function titlingParamsFrom(record: Record<string, unknown>): TitlingParams | null {
  const { session_id: sessionId, mode, by } = record;
  if (typeof sessionId !== 'string' || sessionId.length === 0) return null;
  if (!TITLING_MODES.includes(mode as TitlingMode)) return null;
  return { session_id: sessionId, mode: mode as TitlingMode, ...(typeof by === 'string' && by.length > 0 ? { by } : {}) };
}

/** The parameters a run's stored context names, or null when the context is not a titling dispatch. */
export function titlingParamsOf(runContext: string | null): TitlingParams | null {
  if (runContext === null) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(runContext); } catch { return null; }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return titlingParamsFrom(parsed as Record<string, unknown>);
}
