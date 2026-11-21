/** How much of a spore's body, past its leading blank characters, a search reads to find the opening line it titles the spore by. */
export const SPORE_OPENING_CHARS = 1200;

/** Leading blank characters of a body: tabs, line breaks and spaces. */
export const LEADING_BLANK_SQL = 'char(9,10,13,32)';

/** The bounded opening of body expression `column`, past its leading blank characters. */
export const sporeOpeningSql = (column: string): string => `substr(ltrim(${column}, ${LEADING_BLANK_SQL}), 1, ${SPORE_OPENING_CHARS})`;
