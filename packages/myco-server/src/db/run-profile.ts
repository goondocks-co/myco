/** Select only the public requested profile from the run's private configuration. */
export const requestedProfileValue = (): string => `CASE WHEN json_valid(execution_overrides)
  THEN json_object('requested', json_extract(execution_overrides, '$.requested')) END`;
