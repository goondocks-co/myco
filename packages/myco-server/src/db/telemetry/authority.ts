/** A resolution is usable only while every key supporting it retains authority. */
export const liveResolution = (
  alias: string,
): string => `EXISTS(SELECT 1 FROM telemetry_keys owner WHERE owner.id=${alias}.key_id AND owner.revoked_at IS NULL) AND NOT EXISTS(SELECT 1 FROM telemetry_resolution_keys dependency
  JOIN telemetry_keys authority ON authority.id=dependency.key_id
  WHERE dependency.trace_id=${alias}.trace_id AND dependency.span_id=${alias}.span_id AND authority.revoked_at IS NOT NULL)`;

/** A report profile retains exactly the supporting keys recorded by its resolutions. */
export const liveReport = (
  alias: string,
): string => `EXISTS(SELECT 1 FROM telemetry_keys owner WHERE owner.id=${alias}.key_id AND owner.revoked_at IS NULL)
 AND NOT EXISTS(SELECT 1 FROM json_each(${alias}.evidence) dependency JOIN telemetry_keys authority ON authority.id=dependency.value WHERE authority.revoked_at IS NOT NULL)`;
