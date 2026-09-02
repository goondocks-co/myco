/** Up to two letters standing for a project's name: its first two, or the initials of its first two words. */
export function monogramFor(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'M';
  const letters = parts.length === 1 ? (parts[0]?.slice(0, 2) ?? 'M') : `${parts[0]?.[0] ?? ''}${parts[1]?.[0] ?? ''}`;
  return letters.toUpperCase();
}

/** A stable hue for a project id, so the same project wears the same colour on every visit. */
export function colorForProjectId(id: string): string {
  let hash = 0;
  for (let idx = 0; idx < id.length; idx += 1) hash = (hash * 31 + id.charCodeAt(idx)) >>> 0;
  return `hsl(${hash % 360} 58% 48%)`;
}
