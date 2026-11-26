/**
 * Release classification of one captured commit against a Project's refs.
 *
 * The vocabulary — states, confidence, basis kinds — is the one stored in
 * `knowledge_release_state`, so every row reads the same way whoever wrote it.
 *
 * **Absence of evidence is never negative evidence.** `not_on_release_line`
 * is claimed only when every candidate ref is listed completely and checked.
 * A truncated tag listing, or more release lines than one run checks, leaves
 * the answer `unknown`; a failed read — a rejected credential, a rate limit,
 * a timeout, a spent budget — is `unavailable`, which the caller answers by
 * keeping the record's previous state.
 *
 * **One tag per release line is enough.** Tags on one `major.minor` line are
 * cut in order along one branch, so the newest contains every older one; the
 * newest tag of each line is checked, newest line first, up to
 * `MAX_RELEASE_LINES`. A monorepo's package map narrows which tag families a
 * commit is checked against by the paths its session changed.
 */
import semver from 'semver';
import type { CompareStatus, GithubFailure, GithubReads } from './github-refs.js';
import { isCommitSha } from './github-refs.js';

const RELEASE_STATES = ['unreconciled', 'released', 'merged_unreleased', 'not_on_release_line', 'unknown'] as const;
type ReleaseStateValue = (typeof RELEASE_STATES)[number];

const RELEASE_CONFIDENCE = ['high', 'medium', 'low'] as const;
type ReleaseConfidence = (typeof RELEASE_CONFIDENCE)[number];

const RELEASE_BASIS_KINDS = [
  'git_ancestry', 'git_patch_id', 'github_pr_squash', 'dirty_worktree',
  'configuration', 'missing_git_evidence', 'ref_check_failed',
] as const;
type ReleaseBasisKind = (typeof RELEASE_BASIS_KINDS)[number];

/** The most release lines one pattern contributes to a run. More lines than this makes a miss `unknown`. */
export const MAX_RELEASE_LINES = 8;

export interface PackageTagMapping {
  pathGlob: string;
  tagPattern: string;
}

export interface ReleaseRefConfig {
  productionRefs: readonly string[];
  integrationRefs: readonly string[];
  packageMap: readonly PackageTagMapping[];
}

export interface Classification {
  state: ReleaseStateValue;
  confidence: ReleaseConfidence;
  basisKind: ReleaseBasisKind;
  basisRef: string | null;
  basisSha: string | null;
  releasePrNumber: number | null;
  reason: string;
  evidence: Record<string, unknown>;
}

type ClassifyOutcome =
  | { kind: 'classified'; classification: Classification }
  | { kind: 'unavailable'; failure: GithubFailure; reason: string };

// --- Ref patterns ---

function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

function refAliases(ref: string): string[] {
  const aliases = [ref];
  for (const prefix of ['refs/tags/', 'refs/heads/', 'refs/remotes/']) {
    if (ref.startsWith(prefix)) aliases.push(ref.slice(prefix.length));
  }
  return aliases;
}

function pathMatchesGlob(path: string, glob: string): boolean {
  if (glob.endsWith('/')) return path.startsWith(glob);
  if (glob.endsWith('/*')) return path.startsWith(glob.slice(0, -1));
  if (glob.endsWith('/**')) return path.startsWith(glob.slice(0, -2));
  return path === glob || path.startsWith(`${glob}/`);
}

/**
 * A captured path's repository-relative readings. A tool records the path it
 * touched as the tool named it — absolute, home-relative or relative to where the
 * agent ran — so every suffix at a directory boundary is a candidate, and a
 * mapping matches when any of them does.
 */
function relativeReadings(path: string): string[] {
  const parts = path.replace(/\\/g, '/').split('/').filter((p) => p !== '' && p !== '.' && p !== '~');
  return parts.map((_, i) => parts.slice(i).join('/'));
}

/** The tag patterns a session's changed paths select; empty when nothing maps. */
function tagPatternsForChangedPaths(changedPaths: readonly string[], mappings: readonly PackageTagMapping[]): string[] {
  if (mappings.length === 0 || changedPaths.length === 0) return [];
  const matched = new Set<string>();
  for (const path of changedPaths) {
    const readings = relativeReadings(path);
    for (const mapping of mappings) if (readings.some((r) => pathMatchesGlob(r, mapping.pathGlob))) matched.add(mapping.tagPattern);
  }
  return [...matched];
}

/** Configured production refs narrowed to the selected tag patterns; the whole set when none are selected or none match. */
function filterRefsByPackagePatterns(refs: readonly string[], patterns: readonly string[]): string[] {
  if (patterns.length === 0) return [...refs];
  const matchers = patterns.map(globToRegex);
  const filtered = refs.filter((ref) => refAliases(ref).some((alias) => matchers.some((re) => re.test(alias))));
  return filtered.length > 0 ? filtered : [...refs];
}

/** A configured production ref as a fully qualified tag ref or pattern. */
function qualifyTagRef(ref: string): string {
  return ref.startsWith('refs/') ? ref : `refs/tags/${ref}`;
}

/** A configured integration ref as a branch name GitHub can compare against: `origin/main`, `refs/heads/main` and `main` are one branch. */
function integrationBranch(ref: string): string {
  return ref.replace(/^refs\/remotes\/[^/]+\//, '').replace(/^refs\/heads\//, '').replace(/^origin\//, '');
}

function versionOf(suffix: string): semver.SemVer | null {
  const match = /(\d+)(?:\.(\d+))?(?:\.(\d+))?(-.+)?/.exec(suffix);
  if (!match) return null;
  return semver.parse(`${match[1]}.${match[2] ?? '0'}.${match[3] ?? '0'}${match[4] ?? ''}`);
}

interface ResolvedPattern {
  pattern: string;
  /** The object each checked ref points at, so a run can tell whether anything moved after a record's check. */
  shas: string[];
  /** Newest tag per release line, newest line first. */
  refs: string[];
  /** False when the listing or the line bound left refs unchecked, so a miss proves nothing. */
  complete: boolean;
  failure?: GithubFailure;
}

/** Newest tag of each release line among `refs` matching `pattern`, and whether that selection covers every line. */
export function newestPerLine(pattern: string, refs: readonly string[]): { refs: string[]; complete: boolean } {
  const matcher = globToRegex(pattern);
  const literal = pattern.split(/[*?]/, 1)[0];
  const lines = new Map<string, { ref: string; version: semver.SemVer }>();
  const unversioned: string[] = [];
  for (const ref of refs) {
    if (!matcher.test(ref)) continue;
    const version = versionOf(ref.slice(literal.length));
    if (version === null) { unversioned.push(ref); continue; }
    const line = `${version.major}.${version.minor}`;
    const held = lines.get(line);
    if (held === undefined || version.compare(held.version) > 0) lines.set(line, { ref, version });
  }
  const ordered = [...lines.values()].sort((a, b) => b.version.compare(a.version)).map((l) => l.ref);
  const all = [...ordered, ...unversioned.sort()];
  return { refs: all.slice(0, MAX_RELEASE_LINES), complete: all.length <= MAX_RELEASE_LINES };
}

/** Resolve one configured production ref or pattern into the refs a run checks. One listing per pattern. */
async function resolveProductionRef(reads: GithubReads, configured: string): Promise<ResolvedPattern> {
  const pattern = qualifyTagRef(configured);
  const prefix = (/[*?]/.test(pattern) ? pattern.split(/[*?]/, 1)[0] : pattern).replace(/^refs\//, '');
  const listed = await reads.matchingRefs(prefix);
  if (!listed.ok) return { pattern, refs: [], shas: [], complete: false, failure: listed.failure };
  const sha = new Map(listed.value.map((r) => [r.ref, r.sha]));
  const picked = /[*?]/.test(pattern)
    ? newestPerLine(pattern, [...sha.keys()])
    : { refs: sha.has(pattern) ? [pattern] : [], complete: true };
  return { pattern, ...picked, shas: picked.refs.map((ref) => sha.get(ref) ?? '') };
}

/** A listing that failed for a reason retrying could fix; `truncated` and `not_found` are answers, not outages. */
const isTransient = (failure: GithubFailure): boolean => failure !== 'truncated' && failure !== 'not_found';

interface RunRefs {
  config: ReleaseRefConfig;
  production: ReadonlyMap<string, ResolvedPattern>;
  integration: ReadonlyMap<string, string | null>;
}

type RunRefOutcome =
  | { ok: true; refs: RunRefs; fingerprint: { production: string; integration: string } }
  | { ok: false; failure: GithubFailure };

/** Resolve every configured ref once per run; sessions share the result. */
export async function resolveRunRefs(reads: GithubReads, config: ReleaseRefConfig): Promise<RunRefOutcome> {
  const production = new Map<string, ResolvedPattern>();
  for (const ref of config.productionRefs) {
    const resolved = await resolveProductionRef(reads, ref);
    if (resolved.failure !== undefined && isTransient(resolved.failure)) return { ok: false, failure: resolved.failure };
    production.set(resolved.pattern, resolved);
  }
  const integration = new Map<string, string | null>();
  for (const branch of new Set(config.integrationRefs.map(integrationBranch))) {
    const head = await reads.branchHead(branch);
    if (!head.ok && isTransient(head.failure)) return { ok: false, failure: head.failure };
    integration.set(branch, head.ok ? head.value : null);
  }
  return {
    ok: true, refs: { config, production, integration },
    fingerprint: {
      production: JSON.stringify([config.packageMap, [...production.values()]]),
      integration: JSON.stringify([...integration]),
    },
  };
}

interface ClassifyInput {
  headSha: string | null;
  changedPaths: readonly string[];
}

const classified = (
  state: ReleaseStateValue, confidence: ReleaseConfidence, basisKind: ReleaseBasisKind,
  basisRef: string | null, basisSha: string | null, reason: string,
  evidence: Record<string, unknown>, releasePrNumber: number | null = null,
): ClassifyOutcome => ({ kind: 'classified', classification: { state, confidence, basisKind, basisRef, basisSha, releasePrNumber, reason, evidence } });

const UNAVAILABLE_REASON: Record<GithubFailure, string> = {
  budget_exhausted: 'The run reached its GitHub lookup limit before this commit was checked',
  credential_rejected: 'GitHub refused the App’s release lookup token',
  rate_limited: 'GitHub rate-limited release lookups',
  not_found: 'GitHub could not find the repository',
  truncated: 'GitHub returned a truncated tag listing',
  timeout: 'GitHub did not answer in time',
  network: 'GitHub could not be reached',
  unexpected_response: 'GitHub returned an unexpected response',
};

const unavailable = (failure: GithubFailure): ClassifyOutcome => ({ kind: 'unavailable', failure, reason: UNAVAILABLE_REASON[failure] });

const contains = (status: CompareStatus) => status === 'ahead' || status === 'identical';

/**
 * Classify one captured commit.
 *
 * Production refs first, by direct ancestry and then by a merged pull
 * request's squash commit; then integration branches; then the negative
 * answer, and only when nothing is left unchecked.
 */
export async function classifyCommit(
  reads: GithubReads,
  run: RunRefOutcome,
  input: ClassifyInput,
): Promise<ClassifyOutcome> {
  const sha = input.headSha;
  if (!isCommitSha(sha)) return classified('unknown', 'low', 'missing_git_evidence', null, null, 'No captured commit', {});
  if (!run.ok) return unavailable(run.failure);
  const { config, production, integration } = run.refs;
  if (config.productionRefs.length === 0 && config.integrationRefs.length === 0) {
    return classified('unreconciled', 'low', 'configuration', null, sha, 'No release refs configured', {});
  }
  const patterns = tagPatternsForChangedPaths(input.changedPaths, config.packageMap);
  const selected = filterRefsByPackagePatterns(config.productionRefs.map(qualifyTagRef), patterns);
  const resolved = selected.map(ref => production.get(ref)!);
  const candidates = [...new Set(resolved.flatMap(pattern => pattern.refs))];
  const evidence = { package_patterns: patterns, checked_refs: candidates };
  let complete = resolved.every(pattern => pattern.complete);
  let compareMissing = false;

  async function firstContaining(commit: string, refs: readonly string[]): Promise<
    { hit: string } | { failed: GithubFailure } | { none: true }
  > {
    for (const ref of refs) {
      const result = await reads.compare(commit, ref);
      if (result.ok) {
        if (contains(result.value)) return { hit: ref };
      } else if (result.failure === 'not_found') {
        compareMissing = true;
      } else {
        return { failed: result.failure };
      }
    }
    return { none: true };
  }

  const direct = await firstContaining(sha, candidates);
  if ('failed' in direct) return unavailable(direct.failed);
  if ('hit' in direct) return classified('released', 'high', 'git_ancestry', direct.hit, sha, `Commit is contained in production ref ${direct.hit}`, evidence);

  // A failed ancestry lookup does not rule out GitHub retaining the PR association.
  const associated = await reads.mergedPullsForCommit(sha);
  if (!associated.ok && associated.failure !== 'not_found') return unavailable(associated.failure);
  const pulls = associated.ok ? associated.value.pulls : [];
  for (const pull of pulls) {
    if (pull.mergeCommitSha === sha) continue;
    const viaPull = await firstContaining(pull.mergeCommitSha, candidates);
    if ('failed' in viaPull) return unavailable(viaPull.failed);
    if ('hit' in viaPull) {
      return classified('released', 'high', 'github_pr_squash', viaPull.hit, pull.mergeCommitSha,
        `PR #${pull.number} merge commit is contained in production ref ${viaPull.hit}`, { ...evidence, pull: pull.number }, pull.number);
    }
  }

  for (const [branch, head] of integration) {
    const pull = pulls.find(p => p.baseRef === branch);
    if (pull !== undefined) {
      return classified('merged_unreleased', 'medium', 'github_pr_squash', branch, pull.mergeCommitSha,
        `PR #${pull.number} was merged into ${branch}; no checked production ref was found to contain its merge commit`,
        { ...evidence, pull: pull.number }, pull.number);
    }
    if (head === null) { complete = false; continue; }
    const merged = await firstContaining(sha, [branch]);
    if ('failed' in merged) return unavailable(merged.failed);
    if ('hit' in merged) {
      return classified('merged_unreleased', 'medium', 'git_ancestry', branch, sha,
        `Commit is contained in integration branch ${branch}; no checked production ref was found to contain it`, evidence);
    }
  }

  if (compareMissing || !associated.ok) {
    const exists = await reads.commit(sha);
    if (!exists.ok && exists.failure !== 'not_found') return unavailable(exists.failure);
    if (!exists.ok) return classified('unknown', 'low', 'missing_git_evidence', null, sha,
      'GitHub could not find the captured commit or establish its release through a pull request', evidence);
  }
  if (!complete || compareMissing || !associated.ok || !associated.value.complete) {
    return classified('unknown', 'low', 'ref_check_failed', null, sha,
      'Not every release ref or pull request could be checked, so absence from a release is not established', evidence);
  }
  return classified('not_on_release_line', 'medium', 'git_ancestry', null, sha, 'Commit is not contained in any configured release ref', evidence);
}
