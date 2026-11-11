import { LAST_S5C2 } from './schema-vNEXT-s5c2.js';

/** Placeholder step of this change; the coordinator assigns the real number at merge. */
export const NEXT_PLAN_CURATION = LAST_S5C2 + 1;
/** The last step of this change: the schema version a server of this change runs. */
export const LAST_PLAN_CURATION = NEXT_PLAN_CURATION;
