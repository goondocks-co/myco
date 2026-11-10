import { LAST_S8B } from './schema-vNEXT-s8b.js';

/** Placeholder first step of this change; the coordinator assigns the real numbers at merge. */
export const NEXT_S5D = LAST_S8B + 1;
/** The last step of this change: the schema version a server of this change runs. */
export const LAST_S5D = NEXT_S5D + 2;
