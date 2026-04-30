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
