/** Shared seeding limits and checkout location. */

/** Where, under the run's working directory, the worker places the checkout. */
export { RUN_REPOSITORY_DIR as SEEDING_CHECKOUT_DIR } from '@goondocks/myco-shared/repository';
/** An inventory at or past this many active spores is a Project already seeded. */
export const SEEDED_SPORE_FLOOR = 20;
/** How many spores one seeding pass writes, at most. */
export const SEEDING_SPORE_CEILING = 40;
