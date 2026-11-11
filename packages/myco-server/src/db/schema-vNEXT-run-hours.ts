import { LAST_PLAN_PAGES } from './schema-vNEXT-plan-pages.js';

/** Placeholder step of this change; the coordinator assigns the real number at merge. */
export const NEXT_RUN_HOURS = LAST_PLAN_PAGES + 1;
/** The last step of this change: the schema version a server of this change runs. */
export const LAST_RUN_HOURS = NEXT_RUN_HOURS;
