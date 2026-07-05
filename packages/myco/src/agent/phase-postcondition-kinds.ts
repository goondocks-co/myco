/**
 * Single source of truth for the phase-level postCondition kind names.
 *
 * This module has zero runtime dependencies on purpose — codegen scripts
 * load schemas.ts in plain Node (via tsx), and any transitive import of
 * `bun:sqlite` (which phase-postconditions.ts pulls in via the report and
 * agent-state query helpers) breaks codegen. Keeping the kinds tuple in a
 * leaf module lets both schemas.ts (Zod enum) and phase-postconditions.ts
 * (runtime dispatch) import it without dragging in the DB layer.
 *
 * Adding a new kind:
 *   1. Append the literal name to `PHASE_POSTCONDITION_KINDS` below.
 *   2. Add a matching entry to `PHASE_POSTCONDITIONS` in phase-postconditions.ts.
 * TypeScript's `Record<PhasePostConditionKind, Fn>` enforces the pairing;
 * the Zod enum picks up the new value automatically.
 */

export const PHASE_POSTCONDITION_KINDS = [
  'skill-evolve-inventory',
  'skill-evolve-assess',
  'cortex-prompt-builder-build',
  'skill-generate-validate',
  'skill-survey-reconcile-queue',
  'skill-survey-persist-decisions',
  'harness-health-report',
  'vault-seed-spores',
  'vault-seed-digest-10000',
  'vault-seed-digest-5000',
  'vault-seed-digest-1500',
] as const;

export type PhasePostConditionKind = (typeof PHASE_POSTCONDITION_KINDS)[number];
