import { LAST_S5D } from './schema-vNEXT-s5d.js';

/** Placeholder first step of this change; the coordinator assigns the real numbers at merge. */
export const NEXT_S4C = LAST_S5D + 1;
/** The last step of this change: the schema version a server of this change runs. */
export const LAST_S4C = NEXT_S4C;
