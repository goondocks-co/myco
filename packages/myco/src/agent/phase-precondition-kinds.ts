/**
 * Single source of truth for the phase-level preCondition kind names.
 *
 * This module has zero runtime dependencies on purpose — codegen scripts
 * load schemas.ts in plain Node (via tsx), and any transitive import of
 * `bun:sqlite` (which phase-preconditions.ts pulls in via the spore query
 * helpers) breaks codegen. Keeping the kinds tuple in a leaf module lets
 * both schemas.ts (Zod enum) and phase-preconditions.ts (runtime dispatch)
 * import it without dragging in the DB layer.
 *
 * Adding a new kind:
 *   1. Append the literal name to `PHASE_PRECONDITION_KINDS` below.
 *   2. Add a matching entry to `PHASE_PRECONDITIONS` in phase-preconditions.ts.
 * TypeScript's `Record<PhasePreConditionKind, Fn>` enforces the pairing;
 * the Zod enum picks up the new value automatically.
 */

export const PHASE_PRECONDITION_KINDS = [
  'has-recent-spore-activity',
  'has-recent-consolidatable-spores',
] as const;

export type PhasePreConditionKind = (typeof PHASE_PRECONDITION_KINDS)[number];
