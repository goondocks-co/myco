// Myco-managed exclusion segments. These are agent and tool configuration
// directories that aren't useful to index even if they happen to be tracked
// in git. The list is the union of:
//   1. A small fixed set covering Myco's own state and common companion
//      tools (vault, agent harness scratch, the superpowers/context skill
//      packs, and Playwright's MCP/CLI fixture dirs).
//   2. The `configDir` declared by every loaded symbiont manifest. This is
//      the canonical source — manifests already track which directory each
//      agent owns, so we never hardcode a parallel `.claude` / `.cursor` /
//      `.opencode` list that could drift.
//
// Returned values are bare segment names; callers treat them as
// "exclude any path that has this name as a directory component."
import { loadManifests } from '../symbionts/detect.js';

const FIXED_MANAGED_SEGMENTS: readonly string[] = [
  '.myco',
  '.agents',
  '.superpowers',
  '.context',
  '.playwright-mcp',
  '.playwright-cli',
];

/**
 * Return the merged list of bare segment names that the scanner should
 * always treat as excluded, regardless of whether they appear in
 * `.gitignore`. Order is stable but unimportant — callers compose the
 * result into a matcher that does set membership checks.
 */
export function getManagedExcludeSegments(): string[] {
  const fromManifests = loadManifests().map((m) => stripLeadingSlash(m.configDir));
  const merged = new Set<string>([...FIXED_MANAGED_SEGMENTS, ...fromManifests]);
  return [...merged];
}

function stripLeadingSlash(segment: string): string {
  // Manifest configDirs are recorded as `.claude`, `.cursor`, etc. — but
  // tolerate a stray leading slash so a future manifest edit doesn't
  // silently produce a non-matching segment.
  return segment.replace(/^\/+/, '').replace(/\/+$/, '');
}
