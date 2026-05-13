/**
 * Map project paths to release tag families for monorepo classification.
 *
 * A record changed inside `packages/myco-team/` should classify against
 * `myco-team-v*` rather than the umbrella `v*` tags — otherwise an unrelated
 * shipped tag silently marks worker-only work "released."
 *
 * When changed paths span multiple package buckets (or none), we prefer
 * uncertainty over false precision and return null — the caller falls back
 * to the umbrella refs from `release_provenance.production_refs`.
 */

import type { PackageTagMapping } from './config.js';
import { refAliases } from './refs.js';

export function pathMatchesGlob(path: string, glob: string): boolean {
  if (glob.endsWith('/')) return path.startsWith(glob);
  if (glob.endsWith('/*')) return path.startsWith(glob.slice(0, -1));
  if (glob.endsWith('/**')) return path.startsWith(glob.slice(0, -2));
  return path === glob || path.startsWith(`${glob}/`);
}

/**
 * Given a list of changed paths, return the unique tag patterns implied by
 * the mappings. Multiple matching packages return an empty array — ambiguity
 * is preserved upstream rather than overclaiming one package's release.
 */
export function tagPatternsForChangedPaths(
  changedPaths: readonly string[],
  mappings: readonly PackageTagMapping[],
): string[] {
  if (mappings.length === 0 || changedPaths.length === 0) return [];
  const matched = new Set<string>();
  for (const path of changedPaths) {
    for (const mapping of mappings) {
      if (pathMatchesGlob(path, mapping.path_glob)) {
        matched.add(mapping.tag_pattern);
      }
    }
  }
  return [...matched];
}

/**
 * Filter a list of release refs against the tag patterns implied by changed
 * paths. Empty patterns (no package-map match) preserve the umbrella refs.
 * Empty result (patterns matched no refs) returns the umbrella refs too —
 * the package's release tags may not exist yet, in which case the umbrella
 * fallback is still the right baseline.
 */
export function filterRefsByPackagePatterns(
  refs: readonly string[],
  patterns: readonly string[],
): string[] {
  if (patterns.length === 0) return [...refs];
  const matchers = patterns.map(globToRegex);
  const filtered = refs.filter((ref) => refAliases(ref).some((alias) => matchers.some((re) => re.test(alias))));
  return filtered.length > 0 ? filtered : [...refs];
}

function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}
