/**
 * Structured error envelope shared across routes added in the 0.21.x window.
 *
 * Legacy routes stay on their existing shape (often `{error: 'message'}` or
 * `{error: {...}}`) to avoid churn; new routes opt into this helper so the
 * client has a single code+message pair to key against.
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

export interface PausedInfo {
  reason: string;
  since: number;
  owner_op: string;
  /**
   * The Grove the paused project sits in, or null when it is registered
   * nowhere — the pause is held on the PROJECT, and an operation that moves a
   * project between registries deregisters it for part of the window.
   */
  grove_id: string | null;
}

export interface PausedErrorBody extends ErrorBody {
  paused: PausedInfo;
}

/**
 * Canonical 409 envelope for project-paused responses. Every writer-side
 * gate (server middleware, project-scoped handlers) emits the same shape
 * so clients can key on a single discriminator.
 */
export function pausedErrorResponse(
  projectId: string,
  paused: PausedInfo,
): { status: number; body: PausedErrorBody } {
  return {
    status: 409,
    body: {
      ...errorBody('project_paused', `Project ${projectId} is paused (${paused.reason})`),
      paused: {
        reason: paused.reason,
        since: paused.since,
        owner_op: paused.owner_op,
        grove_id: paused.grove_id,
      },
    },
  };
}
