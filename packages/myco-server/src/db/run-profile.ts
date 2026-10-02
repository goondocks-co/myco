/** Select only the public requested profile from the run's private configuration. */
export const requestedProfileValue = (prefix = ''): string => `CASE WHEN json_valid(${prefix}execution_overrides)
  THEN json_object('requested', json_extract(${prefix}execution_overrides, '$.requested')) END`;
