import { MAP_TASK } from './canopy.js';
export class RepositoryInputError extends Error {}
export const REPOSITORY_COMMIT_PATTERN = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
export const MAX_REPOSITORY_REQUEST_BYTES = 16_384;
/** Optional source preparation has its own allowance beside the harness budget. */
export const REPOSITORY_PREPARATION_TIMEOUT_MS = 120_000;
/** Tasks that require a connection rather than optionally validate knowledge against source. */
export const REQUIRED_REPOSITORY_TASKS: readonly string[] = ['canopy-map', 'vault-seed'];
/** Knowledge runs may inspect files, without shell or edit tools. */
export const KNOWLEDGE_REPOSITORY_TASKS: readonly string[] = ['curate-spores', 'extract-curate'];
export const REPOSITORY_TASKS: readonly string[] = [...REQUIRED_REPOSITORY_TASKS, ...KNOWLEDGE_REPOSITORY_TASKS];

/** A capability needs a connection only when every task requires one. */
export const allTasksRequireRepository = (tasks: readonly string[]): boolean =>
  tasks.length > 0 && tasks.every(task => REQUIRED_REPOSITORY_TASKS.includes(task));

/** HTTPS source with credentials supplied independently of the remote URL. */
export function repositoryUrl(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new RepositoryInputError('Repository URL is invalid.'); }
  if (raw.length > 2048 || raw !== raw.trim() || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname === '/') {
    throw new RepositoryInputError('Repository URL must be HTTPS, with a repository path and no credentials, query, or fragment.');
  }
  return url.href;
}

/** A named branch, without Git revision expressions or refspec destinations. */
export function repositoryBranch(raw: string): string {
  // eslint-disable-next-line no-control-regex
  if (!raw || raw.length > 192 || /[\x00-\x20\x7f~^:?*\[\\]/.test(raw) || raw.includes('..') || raw.includes('@{')
    || raw.startsWith('-') || raw.endsWith('.') || raw.split('/').some((part) => !part || part.startsWith('.') || part.endsWith('.lock'))) {
    throw new RepositoryInputError('Repository branch must be a valid named Git branch.');
  }
  return raw;
}

export interface RepositoryIdentity { url: string; branch: string }
export interface RepositoryPin extends RepositoryIdentity { commit: string }
export interface RepositoryAccess extends RepositoryIdentity {
  credential?: { username: string; token: string };
  commit?: string;
}

/** Worker support for preparing source before starting a harness. */
export const REPOSITORY_CHECKOUT_CAPABILITY = 'repository-checkout';
/** Worker support for writing the digest listing (`RUN_REPOSITORY_DIGESTS_FILE`) beside the checkout it prepares. */
export const REPOSITORY_DIGESTS_CAPABILITY = 'repository-digests';
/** Every capability a worker may report that this Deployment knows. A worker reports what it has, so a name outside this set is a worker's own text. */
export const KNOWN_WORKER_CAPABILITIES: readonly string[] = [REPOSITORY_CHECKOUT_CAPABILITY, REPOSITORY_DIGESTS_CAPABILITY];
/** What this build's worker does, reported on every claim. */
export const WORKER_CAPABILITIES: readonly string[] = [REPOSITORY_CHECKOUT_CAPABILITY, REPOSITORY_DIGESTS_CAPABILITY];
/** The tasks whose instructions read the digest listing: a worker writes it for these, and only one that reports it can take them. */
export const REPOSITORY_DIGEST_TASKS: readonly string[] = [MAP_TASK];

/** Required-source tasks need checkout support; knowledge runs request it only when carrying a checkout. */
export function capabilitiesRequiredBy(task: string, carriesCheckout = REQUIRED_REPOSITORY_TASKS.includes(task)): readonly string[] {
  if (!carriesCheckout || !REPOSITORY_TASKS.includes(task)) return [];
  return REPOSITORY_DIGEST_TASKS.includes(task) ? [REPOSITORY_CHECKOUT_CAPABILITY, REPOSITORY_DIGESTS_CAPABILITY] : [REPOSITORY_CHECKOUT_CAPABILITY];
}
/** Whether a reported capability is one this Deployment knows. */
export const isKnownWorkerCapability = (value: string): boolean => KNOWN_WORKER_CAPABILITIES.includes(value);
/** Source lives beside the run's own instructions and MCP configuration. */
export const RUN_REPOSITORY_DIR = 'repo';
/**
 * The listing the worker writes beside the checkout: one line per committed
 * regular file, `<sha256 of its content>  <path>`, sorted by path, in the
 * `sha256sum` format. A run that grounds an artifact in file content reads its
 * digests here rather than hashing files itself.
 */
export const RUN_REPOSITORY_DIGESTS_FILE = 'repo.sha256';
/** Git inspection commands available to unattended source-reading runs. A text search goes through the harness's own search tool: `git grep -O` runs a program. */
export const SOURCE_GIT_READ_COMMANDS = ['log', 'shortlog', 'show', 'diff', 'diff-tree', 'ls-tree', 'ls-files', 'rev-parse', 'rev-list', 'status', 'blame', 'cat-file', 'describe'] as const;
/**
 * How a source-reading run's instructions tell it to read Git: one call per
 * read, naming the checkout the same way from wherever the shell stands, and a
 * refused or failed call taken as that call's answer rather than the run's end.
 */
export const SOURCE_GIT_RULES = `Run each Git read as a separate shell tool call naming the checkout by the literal relative path: \`git -C ${RUN_REPOSITORY_DIR} <command>\`. Do not use shell variables, pipelines, command chains, or \`cd\`; those forms require permissions this unattended run does not hold. Allowed Git commands: ${SOURCE_GIT_READ_COMMANDS.join(', ')}. A refused or failed call ends that call, not the run: read its error, and carry on with the rest of the work.`;
/** The maximum Git fetch depth for a source-reading run. */
export const MAX_REPOSITORY_HISTORY_DEPTH = 200;

/** Credential-free source material named by a task's prompt. */
export interface RepositoryCheckoutSpec extends RepositoryIdentity {
  historyDepth: number;
}

export function parseRepositoryCheckoutSpec(value: unknown): RepositoryCheckoutSpec {
  if (value === null || typeof value !== 'object') throw new RepositoryInputError('Repository checkout specification is invalid.');
  const { url, branch, historyDepth } = value as Record<string, unknown>;
  if (typeof url !== 'string' || typeof branch !== 'string' || typeof historyDepth !== 'number'
    || !Number.isInteger(historyDepth) || historyDepth < 1 || historyDepth > MAX_REPOSITORY_HISTORY_DEPTH) {
    throw new RepositoryInputError('Repository checkout specification is invalid.');
  }
  return { url: repositoryUrl(url), branch: repositoryBranch(branch), historyDepth };
}

/** Structured repository checkout reasons supported by a Deployment's worker end reports. */
export const REPOSITORY_FAILURE_FEATURE = 'repository-failure-v1';
export const REPOSITORY_FAILURE_CODES = ['fetch_failed', 'submodules', 'lfs', 'too_large', 'commit_mismatch', 'checkout_failed'] as const;
export type RepositoryFailureCode = typeof REPOSITORY_FAILURE_CODES[number];
export interface RepositoryFailure { code: RepositoryFailureCode; summary?: string }
export const MAX_REPOSITORY_FAILURE_SUMMARY_CHARS = 512;

const KNOWLEDGE_REPOSITORY_SECTION = '\n\n## Repository validation\n';
export const KNOWLEDGE_ONLY_INSTRUCTION = 'No usable repository checkout is available. Judge on the served knowledge alone. When in doubt, keep it.';

/** Replace only the builder's final source instruction, preserving every served knowledge item. */
export function knowledgeOnlyInstruction(instruction: string): string {
  const offset = instruction.lastIndexOf(KNOWLEDGE_REPOSITORY_SECTION);
  return (offset < 0 ? instruction : instruction.slice(0, offset)) + KNOWLEDGE_REPOSITORY_SECTION + KNOWLEDGE_ONLY_INSTRUCTION;
}

/** The server and runner share the exact knowledge-only instruction. */
export function knowledgeRepositoryInstruction(repository: RepositoryIdentity | null): string {
  return KNOWLEDGE_REPOSITORY_SECTION + (repository === null ? KNOWLEDGE_ONLY_INSTRUCTION
    : `The connected repository ${repository.url} (branch ${repository.branch}) is pinned at its current commit in the ${RUN_REPOSITORY_DIR} checkout beside the run instructions. Your working directory is the checkout; read and search paths relative to it. Check claims against this code before saving, merging or retiring knowledge. Use only the harness file read, grep and glob tools inside the checkout; no edit or shell tools. A missing file alone never invalidates knowledge. Historical paths are hints at most. When in doubt, keep it.`);
}
