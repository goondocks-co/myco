/**
 * myco_remember — save a decision, gotcha, bug fix, discovery, or trade-off as a spore.
 *
 * Inserts a spore into PGlite via the `insertSpore()` query helper.
 * Embedding is fire-and-forget to avoid blocking the response.
 */

import { randomBytes } from 'node:crypto';
import { insertSpore, type SporeRow } from '@myco/db/queries/spores.js';
import { registerCurator } from '@myco/db/queries/curators.js';
import { epochSeconds, USER_CURATOR_ID, USER_CURATOR_NAME } from '@myco/constants.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Byte length for random spore ID suffix. */
const SPORE_ID_RANDOM_BYTES = 4;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RememberInput {
  content: string;
  type?: string;
  tags?: string[];
}

interface RememberResult {
  id: string;
  observation_type: string;
  status: string;
  created_at: number;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleMycoRemember(
  input: RememberInput,
): Promise<RememberResult> {
  const observationType = input.type ?? 'discovery';
  const id = `${observationType}-${randomBytes(SPORE_ID_RANDOM_BYTES).toString('hex')}`;
  const now = epochSeconds();

  // Ensure the user curator exists (idempotent upsert)
  await registerCurator({
    id: USER_CURATOR_ID,
    name: USER_CURATOR_NAME,
    created_at: now,
  });

  const spore = await insertSpore({
    id,
    curator_id: USER_CURATOR_ID,
    observation_type: observationType,
    content: input.content,
    tags: input.tags ? input.tags.join(', ') : null,
    created_at: now,
  });

  // TODO: Phase 2 — fire-and-forget embedding of the new spore

  return {
    id: spore.id,
    observation_type: spore.observation_type,
    status: spore.status,
    created_at: spore.created_at,
  };
}
