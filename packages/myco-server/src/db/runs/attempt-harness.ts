/** The harness an attempt was claimed for, as its claim recorded it in the attempt's profile; NULL where the attempt recorded none. */
export const attemptHarnessSql = (attempt: string): string =>
  `CASE WHEN json_valid(${attempt}.profile_json) THEN json_extract(${attempt}.profile_json, '$.harness') END`;
