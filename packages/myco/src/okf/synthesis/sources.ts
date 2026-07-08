import path from 'node:path';
import { getDatabase } from '@myco/db/client.js';
import { listSpores } from '@myco/db/queries/spores.js';
import { listFullCanopyEntries } from '@myco/db/queries/canopy.js';
import { readCanopyMap } from '@myco/canopy/map/store.js';
import { walkProject } from '@myco/canopy/scanner/walk.js';
import { capabilityEnabled } from '@myco/config/capabilities.js';
import { runGit } from '@myco/utils/git.js';
import type { MycoConfig } from '@myco/config/schema.js';
import type { ProjectScope } from '@myco/grove/ids.js';

/**
 * Source-gathering adapter for OKF synthesis. Returns a BOUNDED ORIENTATION,
 * not a dump: the Canopy map (the structural guide), a top-level repo-tree
 * summary (directories + file counts, not every path), git diff context, and
 * a capped sample of citable vault refs. It is a starting point — the
 * synthesis agent EXPLORES the real code and vault from here with the
 * exploration/search tools (fs_tree/fs_list/fs_read, code_grep,
 * vault_search_canopy, vault_search_semantic/fts). An earlier revision handed
 * the model EVERYTHING inline (all Canopy entries + all spores + the full file
 * tree), which overflowed the synthesis context so the model couldn't read the
 * code and fell back to describing Myco's tool surface instead of the repo.
 * Vault knowledge is still reduced to citable summaries — never bodies —
 * because Canopy/spores are source material the agent reads, not a published
 * `canopy/`/`spores/` section (Assumption B).
 */

/**
 * Bounds on the ORIENTATION sample. Beyond these the synthesis agent finds
 * what it needs by relevance with the search/exploration tools, so these are
 * a starting flavor + citable ids, not an exhaustive corpus.
 */
/** Active spores sampled into the orientation (split into spores + decisions). */
const SPORE_ORIENTATION_LIMIT = 60;
/** Described Canopy files sampled into the orientation index. */
const CANOPY_ORIENTATION_LIMIT = 80;
/** Repo-root files surfaced in the tree orientation (root files are few; drill deeper with fs_tree/fs_list). */
const ROOT_FILE_LIMIT = 100;

/** Directory segments excluded from the repo tree regardless of git-tracked status. */
const ALWAYS_EXCLUDED_SEGMENTS = new Set(['.git', 'node_modules']);

/** One top-level directory in the repo-tree orientation, with its recursive tracked-file count. */
export interface OkfTopLevelDir {
  /** Repo-relative, forward-slash directory name (a single top-level segment). */
  path: string;
  /** Count of tracked, non-excluded files anywhere under this directory. */
  fileCount: number;
}

/**
 * A bounded ORIENTATION to the repo tree — NOT the full file list. Top-level
 * directories with recursive tracked-file counts plus repo-root files, so the
 * synthesis agent gets the project's shape and scale, then drills into the
 * real structure with fs_tree/fs_list/fs_read rather than reading every path
 * inline.
 */
export interface OkfRepoTreeSummary {
  /** Total tracked, non-excluded files across the repo (the scale). */
  totalFiles: number;
  /** Top-level directories with their recursive tracked-file counts, sorted by path. */
  topLevelDirs: OkfTopLevelDir[];
  /** Tracked files living at the repo root (no directory), capped at ROOT_FILE_LIMIT. */
  rootFiles: string[];
  /** True when rootFiles hit its cap — more root files exist (list them with fs_list on "."). */
  rootFilesTruncated: boolean;
}

/** Git diff context for the synthesis run. */
export interface OkfGitContext {
  /** Current HEAD commit, or null when the project isn't a usable git repo. */
  headSha: string | null;
  /**
   * Paths touched since `sinceRef` (`git log <sinceRef>..HEAD --name-status`).
   * Null is the full-scan signal: non-git project, git unavailable/shallow
   * (an unreachable `sinceRef`), or no `sinceRef` supplied (first run) —
   * never thrown.
   */
  changedPaths: string[] | null;
  /** The ref `changedPaths` was diffed against, or null when none was supplied. */
  sinceRef: string | null;
}

/** A vault knowledge record reduced to a citable summary — id + title + type, never the body. */
export interface OkfVaultRef {
  id: string;
  title: string;
  type: string;
}

export type SporeRef = OkfVaultRef;
export type CanopyRef = OkfVaultRef;
export type DecisionRef = OkfVaultRef;

export interface OkfSourceVault {
  /** Non-decision spores (gotchas, wisdom, discoveries, patterns, ...) — a capped orientation sample. */
  spores: SporeRef[];
  /** Raw Canopy Map markdown, or null when absent/disabled. The structural guide the agent starts from. */
  canopyMap: string | null;
  /** Described Canopy files as citable id+title+type — a capped orientation sample. */
  canopyEntries: CanopyRef[];
  /** Decision-type spores, called out separately — they carry rationale synthesis draws on directly. */
  decisions: DecisionRef[];
  /** True when the spore/decision sample hit SPORE_ORIENTATION_LIMIT — find the rest with vault_search_semantic/fts. */
  sporesTruncated: boolean;
  /** True when the Canopy-entry sample hit CANOPY_ORIENTATION_LIMIT — find the rest with vault_search_canopy. */
  canopyEntriesTruncated: boolean;
}

export interface OkfSourceSet {
  /** Bounded top-level orientation to the repo tree — the agent drills in with fs_tree/fs_list/fs_read. */
  repoTree: OkfRepoTreeSummary;
  gitContext: OkfGitContext;
  vault: OkfSourceVault;
}

/** Identity, config, and diff basis a synthesis run gathers source material for. */
export interface OkfSourceScope {
  projectRoot: string;
  scope: ProjectScope;
  projectId: string;
  machineId: string;
  config: MycoConfig;
  /** Resolved absolute output root — excluded from repoTree as the published bundle dir. */
  outputRoot: string;
  /** Ref to diff against for `gitContext.changedPaths` (e.g. the prior run's headSha); omit for a full scan. */
  sinceRef?: string | null;
}

function truncateTitle(text: string, maxChars = 100): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > maxChars ? `${oneLine.slice(0, maxChars - 1)}…` : oneLine;
}

/** Exclude `.git`, `node_modules`, and the resolved output root, regardless of `.gitignore`. */
function buildRepoTreeExclude(projectRoot: string, outputRoot: string): (relPath: string) => boolean {
  const outputRel = path.relative(projectRoot, outputRoot).split(path.sep).join('/');
  const excludeOutput = outputRel !== '' && !outputRel.startsWith('..') && !path.isAbsolute(outputRel) ? outputRel : null;
  return (relPath) => {
    const normalized = relPath.replace(/\\/g, '/');
    if (normalized.split('/').some((seg) => ALWAYS_EXCLUDED_SEGMENTS.has(seg))) return true;
    if (excludeOutput && (normalized === excludeOutput || normalized.startsWith(`${excludeOutput}/`))) return true;
    return false;
  };
}

/**
 * Aggregate the repo walk into a bounded top-level ORIENTATION — top-level
 * directories with recursive tracked-file counts plus the repo-root files —
 * instead of collecting every path. The agent walks the real structure with
 * fs_tree/fs_list from here; dumping the full tree (2000+ paths on a real
 * repo) is exactly what overflowed the synthesis context.
 */
function gatherRepoTree(scope: OkfSourceScope): OkfRepoTreeSummary {
  const isExcluded = buildRepoTreeExclude(scope.projectRoot, scope.outputRoot);
  const dirFileCounts = new Map<string, number>();
  const rootFiles: string[] = [];
  let rootFileTotal = 0;
  let totalFiles = 0;
  for (const relPath of walkProject({ projectRoot: scope.projectRoot, isExcluded })) {
    totalFiles++;
    const normalized = relPath.replace(/\\/g, '/');
    const slash = normalized.indexOf('/');
    if (slash === -1) {
      rootFileTotal++;
      if (rootFiles.length < ROOT_FILE_LIMIT) rootFiles.push(normalized);
    } else {
      const top = normalized.slice(0, slash);
      dirFileCounts.set(top, (dirFileCounts.get(top) ?? 0) + 1);
    }
  }
  const topLevelDirs = [...dirFileCounts.entries()]
    .map(([path, fileCount]) => ({ path, fileCount }))
    .sort((a, b) => a.path.localeCompare(b.path));
  return {
    totalFiles,
    topLevelDirs,
    rootFiles,
    rootFilesTruncated: rootFileTotal > rootFiles.length,
  };
}

/** Parse `--name-status` output into a de-duplicated, sorted path list (rename/copy lines contribute both sides). */
function parseNameStatus(output: string): string[] {
  const paths = new Set<string>();
  for (const line of output.split('\n')) {
    const match = /^[A-Z]\d*\t(.+)$/.exec(line);
    if (!match) continue;
    for (const col of match[1].split('\t')) {
      if (col) paths.add(col);
    }
  }
  return [...paths].sort();
}

function gatherGitContext(scope: OkfSourceScope): OkfGitContext {
  const sinceRef = scope.sinceRef ?? null;
  let headSha: string;
  try {
    headSha = runGit(['rev-parse', 'HEAD'], scope.projectRoot);
  } catch {
    // Not a git repo, no commits yet, or git unavailable — full-scan signal, never throw.
    return { headSha: null, changedPaths: null, sinceRef };
  }
  if (!sinceRef) return { headSha, changedPaths: null, sinceRef: null };
  try {
    const raw = runGit(['log', `${sinceRef}..HEAD`, '--name-status', '--pretty=format:'], scope.projectRoot);
    return { headSha, changedPaths: parseNameStatus(raw), sinceRef };
  } catch {
    // Unreachable/unknown ref (shallow clone, rewritten history) — fall back to full-scan.
    return { headSha, changedPaths: null, sinceRef };
  }
}

function gatherVault(scope: OkfSourceScope): OkfSourceVault {
  // includeActive: false — exclude spores whose source session is still in
  // flight, matching the established intelligence-task read convention
  // (see ListSporesOptions.includeActive). Bounded to a recent-active
  // orientation sample; the agent finds the rest by relevance with
  // vault_search_semantic/fts rather than reading the whole vault inline.
  const spores = listSpores({ scope: scope.scope, status: 'active', limit: SPORE_ORIENTATION_LIMIT, includeActive: false });
  const sporeRefs: SporeRef[] = [];
  const decisionRefs: DecisionRef[] = [];
  for (const spore of spores) {
    const ref: OkfVaultRef = { id: spore.id, title: truncateTitle(spore.content), type: spore.observation_type };
    if (spore.observation_type === 'decision') decisionRefs.push(ref);
    else sporeRefs.push(ref);
  }

  let canopyMap: string | null = null;
  let canopyEntries: CanopyRef[] = [];
  let canopyEntriesTruncated = false;
  if (capabilityEnabled(scope.config, 'canopy')) {
    canopyMap = readCanopyMap(scope.projectId, scope.machineId)?.content ?? null;
    // Over-fetch by one to detect truncation, then cap — the Canopy MAP is the
    // real structural guide; this list is just a citable index the agent
    // extends via vault_search_canopy.
    const entries = listFullCanopyEntries(getDatabase(), scope.projectId, {
      includeUndescribed: false,
      limit: CANOPY_ORIENTATION_LIMIT + 1,
    });
    canopyEntriesTruncated = entries.length > CANOPY_ORIENTATION_LIMIT;
    canopyEntries = entries.slice(0, CANOPY_ORIENTATION_LIMIT).map((entry) => ({
      id: entry.path,
      title: entry.llm_description ?? entry.path,
      type: entry.language ?? 'canopy_entry',
    }));
  }

  return {
    spores: sporeRefs,
    canopyMap,
    canopyEntries,
    decisions: decisionRefs,
    sporesTruncated: spores.length >= SPORE_ORIENTATION_LIMIT,
    canopyEntriesTruncated,
  };
}

/**
 * Gather the bounded ORIENTATION an OKF synthesis run starts from: a top-level
 * repo-tree summary (excluding `.git`/`node_modules`/the published bundle
 * dir), the git diff context since the last run, and a capped sample of
 * citable vault knowledge. The agent explores the real code and vault from
 * here with the exploration/search tools — this is not a full corpus dump.
 */
export function gatherSources(scope: OkfSourceScope): OkfSourceSet {
  return {
    repoTree: gatherRepoTree(scope),
    gitContext: gatherGitContext(scope),
    vault: gatherVault(scope),
  };
}
