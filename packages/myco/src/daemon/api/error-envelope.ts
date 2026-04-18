/**
 * Structured error envelope shared across routes added in the 0.21.x window.
 *
 * Legacy routes stay on their existing shape (often `{error: 'message'}` or
 * `{error: {...}}`) to avoid churn; new routes opt into this helper so the
 * client has a single code+message pair to key against. See PR description
 * for the list of routes that adopted this shape and the tech-debt note
 * covering the rest.
 */

export interface ErrorBody {
  error: {
    code: string;
    message: string;
  };
}

/**
 * Build a canonical error body. `code` should be a stable machine-readable
 * slug (kebab-case or snake_case); `message` is a human-readable string.
 */
export function errorBody(code: string, message: string): ErrorBody {
  return { error: { code, message } };
}
