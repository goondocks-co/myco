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
 * Source-gathering adapter for OKF synthesis. Subsumes the old `gather.ts`:
 * the vault reads (spores, canopy entries, canopy map) that module fetched
 * for the deterministic Myco-shaped projection now feed the agent-synthesis
 * pipeline instead. Vault knowledge is reduced to citable summaries — never
 * bodies — because Canopy/spores are source material the synthesis agent
 * reads, not a published `canopy/`/`spores/` section (Assumption B).
 */

/** High ceiling for project-scoped reads; far above any real vault. */
const SOURCE_LIMIT = 1_000_000;

/** Directory segments excluded from the repo tree regardless of git-tracked status. */
const ALWAYS_EXCLUDED_SEGMENTS = new Set(['.git', 'node_modules']);

/** One repo file discovered by the tree walk. */
export interface FileEntry {
  /** Repo-relative, forward-slash path. */
  path: string;
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
  /** Non-decision spores (gotchas, wisdom, discoveries, patterns, ...). */
  spores: SporeRef[];
  /** Raw Canopy Map markdown, or null when absent/disabled. */
  canopyMap: string | null;
  canopyEntries: CanopyRef[];
  /** Decision-type spores, called out separately — they carry rationale synthesis draws on directly. */
  decisions: DecisionRef[];
}

export interface OkfSourceSet {
  repoTree: FileEntry[];
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

function gatherRepoTree(scope: OkfSourceScope): FileEntry[] {
  const isExcluded = buildRepoTreeExclude(scope.projectRoot, scope.outputRoot);
  const out: FileEntry[] = [];
  for (const relPath of walkProject({ projectRoot: scope.projectRoot, isExcluded })) {
    out.push({ path: relPath });
  }
  return out;
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
  // (see ListSporesOptions.includeActive).
  const spores = listSpores({ scope: scope.scope, status: 'active', limit: SOURCE_LIMIT, includeActive: false });
  const sporeRefs: SporeRef[] = [];
  const decisionRefs: DecisionRef[] = [];
  for (const spore of spores) {
    const ref: OkfVaultRef = { id: spore.id, title: truncateTitle(spore.content), type: spore.observation_type };
    if (spore.observation_type === 'decision') decisionRefs.push(ref);
    else sporeRefs.push(ref);
  }

  let canopyMap: string | null = null;
  let canopyEntries: CanopyRef[] = [];
  if (capabilityEnabled(scope.config, 'canopy')) {
    canopyMap = readCanopyMap(scope.projectId, scope.machineId)?.content ?? null;
    canopyEntries = listFullCanopyEntries(getDatabase(), scope.projectId, {
      includeUndescribed: false,
      limit: SOURCE_LIMIT,
    }).map((entry) => ({
      id: entry.path,
      title: entry.llm_description ?? entry.path,
      type: entry.language ?? 'canopy_entry',
    }));
  }

  return { spores: sporeRefs, canopyMap, canopyEntries, decisions: decisionRefs };
}

/**
 * Gather the raw source material an OKF synthesis run reads: the repo file
 * tree (excluding `.git`/`node_modules`/the published bundle dir), the git
 * diff context since the last run, and vault knowledge reduced to citable
 * summaries.
 */
export function gatherSources(scope: OkfSourceScope): OkfSourceSet {
  return {
    repoTree: gatherRepoTree(scope),
    gitContext: gatherGitContext(scope),
    vault: gatherVault(scope),
  };
}
