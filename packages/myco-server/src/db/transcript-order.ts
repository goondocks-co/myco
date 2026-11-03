/** Session file pages list primary files before subagent files, with the canonical id breaking ties. */
export const transcriptRoleSql = (alias = ''): string => `CASE WHEN ${alias ? alias + '.' : ''}role='subagent' THEN 1 ELSE 0 END`;
