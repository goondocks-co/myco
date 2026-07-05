/**
 * Typed error for every OkfBundle write path. The `code` is stable and
 * machine-readable so surfaces (CLI/API/MCP, Plan 5) map it to an envelope
 * without pattern-matching on prose. Re-exported from `bundle.ts` for the
 * frozen interface; lives here so `output-root.ts` can throw it without a
 * circular import.
 */

export type OkfErrorCode =
  | 'invalid_okf_output_root'
  | 'okf_validation_failed'
  | 'okf_generation_conflict'
  | 'okf_maintain_failed'
  | 'okf_disabled'
  | 'concept_path_collision'
  | 'deterministic_path_not_editable'
  | 'non_myco_output_present'
  | 'okf_publish_not_acknowledged'
  | 'atomic_replace_failed'
  | 'frontmatter_serialization_failed';

export class OkfError extends Error {
  constructor(
    readonly code: OkfErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'OkfError';
  }
}

/** HTTP status for each code — consumed by the daemon API surface (Plan 5). */
export const OKF_ERROR_HTTP_STATUS: Record<OkfErrorCode, number> = {
  invalid_okf_output_root: 400,
  okf_validation_failed: 422,
  okf_generation_conflict: 409,
  okf_maintain_failed: 500,
  okf_disabled: 403,
  concept_path_collision: 500,
  deterministic_path_not_editable: 400,
  non_myco_output_present: 409,
  okf_publish_not_acknowledged: 422,
  atomic_replace_failed: 500,
  frontmatter_serialization_failed: 500,
};
