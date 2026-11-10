import { LAST_S4C } from './schema-vNEXT-s4c.js';

/** Placeholder first step of this change; the coordinator assigns the real numbers at merge. */
export const NEXT_S2F = LAST_S4C + 1;
/** The last step of this change: the schema version a server of this change runs. */
export const LAST_S2F = NEXT_S2F + 1;
