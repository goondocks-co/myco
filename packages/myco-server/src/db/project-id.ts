/** The project-id grammar as SQL over a column expression. */
export const projectIdGrammar = (column: string): string => `${column} NOT GLOB '*[^A-Za-z0-9._-]*' AND length(${column}) BETWEEN 1 AND 64 AND ${column} NOT IN ('.', '..')`;
export const PROJECT_ID_GRAMMAR = projectIdGrammar('project_id');
