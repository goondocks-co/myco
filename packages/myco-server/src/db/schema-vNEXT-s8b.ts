import { NEXT_S7 } from './schema-vNEXT-s7.js';

/** Placeholder first step of this change; the coordinator assigns the real numbers at merge. */
export const NEXT_S8B = NEXT_S7 + 1;
/** The last step of this change: the schema version a server of this change runs. */
export const LAST_S8B = NEXT_S8B + 4;
