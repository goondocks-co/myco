/**
 * myco_supersede — mark a spore as outdated and replaced by a newer one.
 *
 * Updates the old spore's status to 'superseded' via PGlite and records
 * a resolution event for audit.
 */

import { randomBytes } from 'node:crypto';
import { updateSporeStatus } from '@myco/db/queries/spores.js';
import { registerCurator } from '@myco/db/queries/curators.js';
import { getDatabase } from '@myco/db/client.js';
import { epochSeconds, USER_CURATOR_ID, USER_CURATOR_NAME } from '@myco/constants.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Status value for superseded spores. */
const STATUS_SUPERSEDED = 'superseded';

/** Resolution action type for supersession. */
const ACTION_SUPERSEDE = 'supersede';

/** Byte length for random resolution event ID. */
const RESOLUTION_ID_RANDOM_BYTES = 8;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SupersedeInput {
  old_spore_id: string;
  new_spore_id: string;
  reason?: string;
}

interface SupersedeResult {
  old_spore: string;
  new_spore: string;
  status: 'superseded';
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleMycoSupersede(
  input: SupersedeInput,
): Promise<SupersedeResult> {
  const now = epochSeconds();

  // Update status to superseded
  await updateSporeStatus(input.old_spore_id, STATUS_SUPERSEDED, now);

  // Ensure user curator exists (idempotent)
  await registerCurator({
    id: USER_CURATOR_ID,
    name: USER_CURATOR_NAME,
    created_at: now,
  });

  // Record resolution event for audit trail
  const db = getDatabase();
  const resolutionId = `res-${randomBytes(RESOLUTION_ID_RANDOM_BYTES).toString('hex')}`;

  await db.query(
    `INSERT INTO resolution_events (id, curator_id, spore_id, action, new_spore_id, reason, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      resolutionId,
      USER_CURATOR_ID,
      input.old_spore_id,
      ACTION_SUPERSEDE,
      input.new_spore_id,
      input.reason ?? null,
      now,
    ],
  );

  return {
    old_spore: input.old_spore_id,
    new_spore: input.new_spore_id,
    status: STATUS_SUPERSEDED,
  };
}
