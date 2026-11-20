/** Every telemetry assertion is owned by exactly one live key. */
export const liveResolution = (alias: string): string =>
  `EXISTS(SELECT 1 FROM telemetry_keys owner WHERE owner.id=${alias}.key_id AND owner.revoked_at IS NULL)`;
export const liveReport = liveResolution;
