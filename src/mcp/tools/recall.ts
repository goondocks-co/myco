/**
 * myco_recall — get context relevant to current work.
 *
 * Queries sessions, plans, and spores from PGlite. Returns a composite
 * result with active plans, recent sessions, and relevant spores.
 */

import { getSession } from '@myco/db/queries/sessions.js';
import { getSpore } from '@myco/db/queries/spores.js';
import { getPlan } from '@myco/db/queries/plans.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RecallInput {
  note_id: string;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Recall looks up a specific note by ID. It tries sessions, spores, and
 * plans in parallel and returns the first match.
 */
export async function handleMycoRecall(
  input: RecallInput,
): Promise<Record<string, unknown>> {
  const id = input.note_id;

  const [session, spore, plan] = await Promise.all([
    getSession(id),
    getSpore(id),
    getPlan(id),
  ]);

  if (session) return { type: 'session', ...session };
  if (spore) return { type: 'spore', ...spore };
  if (plan) return { type: 'plan', ...plan };

  return { error: `Note not found: ${id}` };
}
