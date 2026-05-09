/**
 * Extract a human-readable message from an unknown thrown value. Mirrors
 * `@myco/utils/error-message` on the server so handler error rendering
 * stays consistent across the wire.
 */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.constructor.name || 'Error';
  if (typeof err === 'string') return err || 'Empty string error';
  try { return JSON.stringify(err); } catch { return 'Unserializable error'; }
}
