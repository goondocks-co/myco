import type { RelationalStore } from './adapters.js';
import { recordViewReadRefusal } from './attention-state.js';

export type ViewReadRefusalCode = 'view_state_inconsistent' | 'view_plan_requires_promotion' | 'view_source_identity_missing';

const REFUSAL_MESSAGES: Readonly<Record<ViewReadRefusalCode, string>> = {
  view_state_inconsistent: 'The session is unavailable because its saved sources are inconsistent.',
  view_plan_requires_promotion: 'Editing this plan is unavailable.',
  view_source_identity_missing: 'This material has no stored source identity.',
};

export class ViewReadRefusal extends Error {
  constructor(readonly code: ViewReadRefusalCode, readonly source: Readonly<{ projectId: string; sessionId: string; fence: number | null }>) {
    super(REFUSAL_MESSAGES[code]);
    this.name = 'ViewReadRefusal';
  }
}

/** Persists an observed inconsistency before propagating its named refusal. */
export async function observedViewRead<T>(db: RelationalStore, clock: () => number, read: () => Promise<T>): Promise<T> {
  try { return await read(); }
  catch (error) {
    if (error instanceof ViewReadRefusal && error.code === 'view_state_inconsistent') {
      await recordViewReadRefusal(db, { ...error.source, code: error.code }, clock());
    }
    throw error;
  }
}

/** HTTP handlers share the same named read refusal envelope. */
export function readRefusalHandler<F extends (...args: never[]) => Response | Promise<Response>>(handler: F): F {
  return (async (...args: Parameters<F>) => {
    try { return await handler(...args); }
    catch (error) {
      if (!(error instanceof ViewReadRefusal)) throw error;
      return Response.json({ error: error.message, code: error.code }, { status: 409 });
    }
  }) as F;
}
