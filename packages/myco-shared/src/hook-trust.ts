/** When a machine's agent is asked to trust Myco's hooks: one rule for the member, the Deployment and the dashboard. */

/** What a machine reports of an agent's last use and of the hook repair its trust waits on, in epoch milliseconds. */
export interface HookTrustFact {
  ranAt?: number;
  hookRepairAt?: number;
}

/**
 * The harness ran on its machine after the hook repair its trust waits on, as its report says; a fact naming no repair
 * needs any reported use. Only such a harness is asked to trust Myco's hooks.
 */
export const ranSinceHookRepair = (fact: HookTrustFact): boolean =>
  fact.ranAt !== undefined && (fact.hookRepairAt === undefined || fact.ranAt > fact.hookRepairAt);
