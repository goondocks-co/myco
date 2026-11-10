import { LAST_S2F } from './schema-vNEXT-s2f.js';

/** Placeholder first step of this change; the coordinator assigns the real number at merge. */
export const NEXT_SEARCH = LAST_S2F + 1;
/** The last step of this change: the schema version a server of this change runs. */
export const LAST_SEARCH = NEXT_SEARCH;
