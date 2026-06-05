/**
 * Canonical string values for spores.status and the resolution actions that
 * transition a spore between them.
 *
 * The spore lifecycle has one live state and three terminal states:
 *   - active:       live knowledge, eligible for retrieval/injection
 *   - superseded:   replaced by a specific newer spore (op: supersede)
 *   - consolidated: merged into a comprehensive wisdom note (op: consolidate)
 *   - obsolete:     no longer relevant, with no replacement — e.g. a dropped
 *                   feature (op: obsolete)
 *
 * Every retrieval/search/embedding/feed path gates on `active` (an allowlist),
 * so any of the three terminal states removes a spore from injection
 * automatically — there is deliberately no "excluded statuses" denylist to keep
 * in sync as statuses are added.
 *
 * This module is the single source of truth for the wire encoding shared by
 * the symbiont MCP tool (`myco_spores`), the agent harness tool
 * (`vault_resolve_spore`), the daemon REST filters, and the UI. The UI lives
 * in a separate workspace and cannot import from here, so it mirrors
 * SPORE_STATUSES with a pointer comment — keep the two in sync.
 */
export const SPORE_STATUS = {
  ACTIVE: 'active',
  SUPERSEDED: 'superseded',
  CONSOLIDATED: 'consolidated',
  OBSOLETE: 'obsolete',
} as const;

export type SporeStatus = (typeof SPORE_STATUS)[keyof typeof SPORE_STATUS];

/** All statuses, in lifecycle order — for filter enums (MCP, agent tools, UI). */
export const SPORE_STATUSES = [
  SPORE_STATUS.ACTIVE,
  SPORE_STATUS.SUPERSEDED,
  SPORE_STATUS.CONSOLIDATED,
  SPORE_STATUS.OBSOLETE,
] as const;

/**
 * Resolution actions that retire or transition a spore, and the terminal
 * status each one yields. `supersede` and `consolidate` require a replacement
 * spore; `obsolete` does not.
 */
export const RESOLUTION_ACTION = {
  SUPERSEDE: 'supersede',
  CONSOLIDATE: 'consolidate',
  OBSOLETE: 'obsolete',
} as const;

export type ResolutionAction = (typeof RESOLUTION_ACTION)[keyof typeof RESOLUTION_ACTION];

export const RESOLUTION_ACTIONS = [
  RESOLUTION_ACTION.SUPERSEDE,
  RESOLUTION_ACTION.CONSOLIDATE,
  RESOLUTION_ACTION.OBSOLETE,
] as const;

export const RESOLUTION_ACTION_TO_STATUS: Record<ResolutionAction, SporeStatus> = {
  [RESOLUTION_ACTION.SUPERSEDE]: SPORE_STATUS.SUPERSEDED,
  [RESOLUTION_ACTION.CONSOLIDATE]: SPORE_STATUS.CONSOLIDATED,
  [RESOLUTION_ACTION.OBSOLETE]: SPORE_STATUS.OBSOLETE,
};
