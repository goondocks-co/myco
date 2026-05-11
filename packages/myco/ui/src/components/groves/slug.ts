/**
 * UI-side slug preview. Mirrors `slugifyGroveName` from
 * `packages/myco/src/grove/ids.ts`. We keep an inline copy so the UI
 * bundle does not pull in the Node `crypto`-dependent module the
 * canonical helper sits beside.
 *
 * If you change the rules, update both files (the server's slug is
 * authoritative; this is for preview only).
 */
export function slugifyGroveNamePreview(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'default';
}
