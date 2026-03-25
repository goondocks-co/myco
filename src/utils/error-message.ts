/**
 * Extract a human-readable error message from an unknown thrown value.
 *
 * Handles Error instances, strings, and arbitrary objects. Never throws.
 */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.constructor.name || 'Error';
  if (typeof err === 'string') return err || 'Empty string error';
  try { return JSON.stringify(err); } catch { return 'Unserializable error'; }
}
