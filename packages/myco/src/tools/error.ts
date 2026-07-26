/**
 * Shared helpers for extracting error messages from DaemonClient failure
 * responses. Thanks to DaemonClient.parseErrorBody (Bundle F), the daemon's
 * structured error envelope rides on `result.data` even when `result.ok` is
 * false — callers just need to normalize the handful of shapes we emit:
 *
 *   - undefined               → no body parsed (timeout, daemon unreachable)
 *   - 'plain message'         → legacy routes
 *   - { error: 'msg' }        → legacy routes that wrap strings
 *   - { error: { message } }  → errorBody() canonical envelope
 */

/** Standard failure-result envelope returned by handler ops. */
export interface ToolFailure {
  ok: false;
  error: string;
}

export type ToolErrorCode =
  | 'unknown_tool'
  | 'tool_unavailable'
  | 'invalid_input'
  | 'invalid_json'
  /**
   * The vault has no Grove project id (project.toml missing or
   * malformed). Surfaced by transports that wrap
   * `tryResolveRequestContextForVault` so MCP clients can prompt
   * the user that the project hasn't been auto-registered yet
   * instead of seeing the opaque `tool_call_failed` envelope.
   * Distinct code so clients don't have to pattern-match on
   * message prose.
   */
  | 'legacy_vault'
  /**
   * A `grove_id` pivot targeted a Grove that lives in another daemon's
   * home (`<MYCO_HOME>/groves/`). Rejected before the target Grove's
   * database is opened (or schema-migrated). Distinct code so clients can
   * surface the foreign-home reason instead of a generic failure.
   */
  | 'foreign_grove'
  /**
   * A pivot targeted a project whose write lease is held (grove move,
   * residency transition) or whose lease record is unreadable — the
   * project's data is mid-operation and must not be read or written
   * through a pivot until the operation completes. Distinct code so
   * clients can present "retry after the operation finishes".
   */
  | 'project_lease_held'
  | 'tool_call_failed';

/**
 * Typed error thrown by the shared tool dispatcher so transports (CLI, HTTP
 * MCP, stdio MCP) can read a stable `code` instead of pattern-matching on
 * message prose. Message text remains the human-readable detail.
 *
 * `data` mirrors `code` in the shape the MCP SDK's `Server` already looks for
 * when it turns a thrown handler error into a JSON-RPC error response
 * (`shared/protocol.js`: `...(error['data'] !== undefined && { data:
 * error['data'] })`). A `ToolError.code` is a string, so the SDK's own
 * `Number.isSafeInteger(error['code'])` check falls through to a generic
 * `InternalError` (-32603) and would otherwise drop the code entirely on the
 * wire. Setting `data` lets any MCP transport (the daemon's `/mcp` route, now
 * that `myco tool call` is a client of it, and the stdio bridge) recover the
 * original code without a bespoke non-MCP fallback route.
 */
export class ToolError extends Error {
  public readonly data: { code: ToolErrorCode };

  constructor(public readonly code: ToolErrorCode, message: string) {
    super(message);
    this.name = 'ToolError';
    this.data = { code };
  }
}

export function isToolError(error: unknown): error is ToolError {
  return error instanceof ToolError;
}

export function extractErrorMessage(data: unknown, fallback: string): string {
  if (typeof data === 'string') return data;
  if (typeof data !== 'object' || data === null) return fallback;

  const rawError = (data as { error?: unknown }).error;
  if (typeof rawError === 'string') return rawError;
  if (
    typeof rawError === 'object'
    && rawError !== null
    && 'message' in rawError
    && typeof (rawError as { message: unknown }).message === 'string'
  ) {
    return (rawError as { message: string }).message;
  }

  return fallback;
}
