/**
 * What a hook serves its harness, read from this machine alone (#1561): no hook waits on the Deployment.
 *
 * The member helper fills the cache from the Deployment's answers, and a hook renders from it:
 * - `context/project.json` holds the Project's blocks, as the Deployment last composed them: the session start's,
 *   a compaction's and a delegated agent's, plus the features the Deployment advertised on its last answer
 *   (`x-myco-features`). The Deployment-wide snapshot is authoritative for feature gates; project advertisements
 *   supply the upgrade fallback until a protocol-bearing answer writes that snapshot.
 * - `context/<session>.json` holds what was served for the session's latest prompt, rendered on its next one: the
 *   context a prompt gets is the previous prompt's, until a local re-rank can do better.
 *
 * What the helper is to ask for travels in session state (`contextAsks`), written with the hook's own records under
 * the session lock, so a request is never lost to a hook killed between the append and the ask.
 *
 * Each file is written whole (`writePrivateFileAtomic`) by the helper, which holds the project's helper lock; a hook
 * only reads. A file that cannot be read is an empty cache: the hook serves nothing rather than fail.
 */
import fs from 'node:fs';
import { withFileLockSync } from '@myco/utils/lifecycle-lock.js';
import path from 'node:path';
import { featuresNamed, featureAdvertised as headerAdvertises, type MemberFeature } from '@goondocks/myco-shared/member-protocol';
import { HARNESS_HEALTH_FEATURE } from '@goondocks/myco-shared/harness-health';
import { BLOCK_JOIN, projectLine, withoutProjectLine } from '@goondocks/myco-shared/recall';
import { deploymentFeaturesPath, deploymentsDir, deploymentUrl, listRegistryEntriesResult, type RegistryEntry } from './registry.js';
import { spoolDirFor } from './spool.js';
import { ensureMemberDir, ensurePrivateFile, pathIsAbsent, readPrivateJson, writePrivateFileAtomic } from './store.js';

type CachedFeature = MemberFeature | typeof HARNESS_HEALTH_FEATURE;

/** Capture kinds and helper services this member knows how to use. */
export function cachedDeploymentFeatures(header: string | null): CachedFeature[] {
  return [...featuresNamed(header), ...(headerAdvertises(header, HARNESS_HEALTH_FEATURE) ? [HARNESS_HEALTH_FEATURE] as const : [])];
}

export const CONTEXT_DIRNAME = 'context';
const PROJECT_FILE = 'project.json';
const CACHE_VERSION = 1;

/** A block the Deployment composed, as the helper stored it. */
export interface CachedBlock {
  context: string;
  /** When the Deployment answered it. */
  at: number;
}

/** The blocks a session's harness is served once per session, keyed by what they are served for. */
export type SessionBlockKind = 'start' | 'compact' | 'subagent';

export interface ProjectContextCache {
  version: typeof CACHE_VERSION;
  /** The features the Deployment named on its last answer; none until one names any. */
  features: CachedFeature[];
  featuresAt?: number;
  blocks: Partial<Record<SessionBlockKind, CachedBlock>>;
}

export interface SessionContextCache {
  version: typeof CACHE_VERSION;
  /** What the Deployment served for the session's latest prompt, rendered on the next one. */
  prompt?: CachedBlock & { promptId: string };
}

/** What a hook asks the helper to fetch for its session: kept in session state until the helper has asked. */
export type ContextAsk =
  | { kind: 'start'; remote?: string; remoteFrom?: string; at: number }
  | { kind: 'compact'; compaction: number; remote?: string; remoteFrom?: string; at: number }
  | { kind: 'subagent'; agentId?: string; agentType?: string; at: number }
  | { kind: 'prompt'; promptId: string; text: string; at: number };

/** The most of a prompt's text a recall request carries: the search reads its head, and a request stays small. */
export const PROMPT_ASK_MAX_CHARS = 16_384;

export function contextDir(spoolDir: string): string {
  return path.join(spoolDir, CONTEXT_DIRNAME);
}

export function projectContextPath(spoolDir: string): string {
  return path.join(contextDir(spoolDir), PROJECT_FILE);
}

export function sessionContextPath(spoolDir: string, sessionId: string): string {
  return path.join(contextDir(spoolDir), `${sessionId}.json`);
}

const emptyProject = (): ProjectContextCache => ({ version: CACHE_VERSION, features: [], blocks: {} });

function readCache<T extends { version: number }>(file: string): T | null {
  if (!fs.existsSync(file)) return null;
  const read = readPrivateJson<T>(file);
  return read.ok && read.value !== null && typeof read.value === 'object' && read.value.version === CACHE_VERSION ? read.value : null;
}

export function readProjectContext(spoolDir: string): ProjectContextCache {
  const cached = readCache<ProjectContextCache>(projectContextPath(spoolDir));
  if (cached === null) return emptyProject();
  return {
    version: CACHE_VERSION,
    features: cachedDeploymentFeatures(Array.isArray(cached.features) ? cached.features.join(',') : ''),
    ...(typeof cached.featuresAt === 'number' ? { featuresAt: cached.featuresAt } : {}),
    blocks: cached.blocks !== null && typeof cached.blocks === 'object' ? cached.blocks : {},
  };
}

/** Change the project's cache, written whole. The helper alone writes it, under the project's helper lock. */
export function updateProjectContext(spoolDir: string, mycoHome: string, mutate: (cache: ProjectContextCache) => void): ProjectContextCache {
  const cache = readProjectContext(spoolDir);
  const priorFeatures = JSON.stringify([cache.features, cache.featuresAt]);
  mutate(cache);
  if (JSON.stringify([cache.features, cache.featuresAt]) !== priorFeatures) fallbackFeatures.clear();
  ensureMemberDir(contextDir(spoolDir), mycoHome);
  writePrivateFileAtomic(projectContextPath(spoolDir), `${JSON.stringify(cache)}\n`);
  return cache;
}

export function readSessionContext(spoolDir: string, sessionId: string): SessionContextCache {
  return readCache<SessionContextCache>(sessionContextPath(spoolDir, sessionId)) ?? { version: CACHE_VERSION };
}

export function writeSessionContext(spoolDir: string, mycoHome: string, sessionId: string, cache: SessionContextCache): void {
  ensureMemberDir(contextDir(spoolDir), mycoHome);
  writePrivateFileAtomic(sessionContextPath(spoolDir, sessionId), `${JSON.stringify(cache)}\n`);
}

/** Forget a session's cache: it goes with the session's state. */
export function removeSessionContext(spoolDir: string, sessionId: string): void {
  try { fs.unlinkSync(sessionContextPath(spoolDir, sessionId)); } catch { /* none cached */ }
}

/**
 * The block a session is served for `kind`, rendered here: the Project line, written from the session's own project
 * id, then what the Deployment composed for that kind as this machine last cached it (a compaction falls back to the
 * start's). A session is told its Project whether or not anything is cached yet: the line every Myco write needs comes
 * from no answer. `complete` says the Deployment's block was cached and rendered: only then is the block delivered,
 * and a later hook that can inject renders it once it is. A run with no project yet (a repository still joining) is
 * served nothing.
 */
export function renderedBlock(spoolDir: string, projectId: string, kind: SessionBlockKind): { text: string; complete: boolean } | undefined {
  if (projectId.length === 0) return undefined;
  const blocks = readProjectContext(spoolDir).blocks;
  const block = kind === 'compact' ? blocks.compact ?? blocks.start : blocks[kind];
  const body = block === undefined ? '' : withoutProjectLine(block.context);
  return { text: [projectLine(projectId), ...(body.length > 0 ? [body] : [])].join(BLOCK_JOIN), complete: block !== undefined };
}

/** What a session's delivered list records when it was served the Project line of `delivered` alone. */
export const projectLineOnly = (delivered: string): string => `${delivered}:project-line`;

interface FeatureSnapshot { version: number; features: CachedFeature[]; receivedAt?: number }
interface FeatureOrder { version: number; issued: number; receivedAt: number }
const FALLBACK_WINDOW_MS = 5_000;
const fallbackFeatures = new Map<string, { until: number; features: CachedFeature[] }>();
const featureDiagnostics = new Map<string, string>();

/** Emit a cache failure once until its state changes or the operation succeeds. */
export function featureCacheDiagnostic(serverUrl: string, mycoHome: string, operation: 'read' | 'write', error?: unknown): void {
  const key = `${mycoHome}:${deploymentUrl(serverUrl)}:${operation}`;
  const message = error === undefined ? '' : error instanceof Error ? error.message : String(error);
  const state = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : message;
  const diagnosticPath = `${deploymentFeaturesPath(serverUrl, mycoHome)}.${operation}-diagnostic`;
  let changed = false;
  try {
    ensureMemberDir(deploymentsDir(mycoHome), mycoHome);
    const lockPath = `${diagnosticPath}.lock`;
    ensurePrivateFile(lockPath);
    changed = withFileLockSync(lockPath, () => {
      if (readCache<{ version: number; state: string }>(diagnosticPath)?.state === state) return false;
      writePrivateFileAtomic(diagnosticPath, `${JSON.stringify({ version: CACHE_VERSION, state })}\n`);
      return true;
    });
  } catch { changed = featureDiagnostics.get(key) !== state; }
  featureDiagnostics.set(key, state);
  if (changed && state.length > 0) process.stderr.write(`[myco] feature cache ${operation} failed: ${message}\n`);
}

function withFeatureOrder<T>(serverUrl: string, mycoHome: string, change: (order: FeatureOrder) => T, publish?: (result: T) => void): T {
  ensureMemberDir(deploymentsDir(mycoHome), mycoHome);
  const snapshotPath = deploymentFeaturesPath(serverUrl, mycoHome);
  const orderPath = `${snapshotPath}.order`;
  const lockPath = `${snapshotPath}.lock`;
  ensurePrivateFile(lockPath);
  return withFileLockSync(lockPath, () => {
    let order = readCache<FeatureOrder>(orderPath);
    if (order === null) {
      if (!pathIsAbsent(orderPath)) throw new Error('Cannot read the Deployment feature ordering state');
      const lastStamp = readCache<FeatureSnapshot>(snapshotPath)?.receivedAt ?? 0;
      order = { version: CACHE_VERSION, issued: lastStamp, receivedAt: lastStamp };
    }
    const result = change(order);
    writePrivateFileAtomic(orderPath, `${JSON.stringify(order)}\n`);
    publish?.(result);
    return result;
  });
}

/** Allocate an answer's ordering stamp before its request starts, independent of wall clocks. */
export function beginFeatureRequest(serverUrl: string, mycoHome: string): number {
  return withFeatureOrder(serverUrl, mycoHome, (order) => ++order.issued);
}

/** Publish an ordered answer; unchanged feature files retain their existing bytes. */
export function cacheDeploymentFeatures(serverUrl: string, features: CachedFeature[], mycoHome: string, receivedAt = beginFeatureRequest(serverUrl, mycoHome), project?: { spoolDir: string; at: number }): boolean {
  return withFeatureOrder(serverUrl, mycoHome, (order) => {
    if (receivedAt < order.receivedAt) return false;
    order.receivedAt = receivedAt;
    return true;
  }, (accepted) => {
    if (!accepted) return;
    fallbackFeatures.clear();
    const snapshotPath = deploymentFeaturesPath(serverUrl, mycoHome);
    const snapshot = readCache<FeatureSnapshot>(snapshotPath);
    if (JSON.stringify(snapshot?.features) !== JSON.stringify(features)) {
      writePrivateFileAtomic(snapshotPath, `${JSON.stringify({ version: CACHE_VERSION, features, receivedAt })}\n`);
    }
    if (project !== undefined && JSON.stringify(readProjectContext(project.spoolDir).features) !== JSON.stringify(features)) {
      updateProjectContext(project.spoolDir, mycoHome, (cache) => { cache.features = features; cache.featuresAt = project.at; });
    }
  });
}

type Deployment = Pick<RegistryEntry, 'serverUrl' | 'projectId'>;
function newestProjectFeatures(deployment: Deployment, mycoHome: string): CachedFeature[] {
  const registry = listRegistryEntriesResult(mycoHome);
  if (!registry.readable) throw new Error('Cannot read the member registry for Deployment features');
  const projects = new Set([...(deployment.projectId.length > 0 ? [deployment.projectId] : []), ...registry.entries
    .filter((entry) => deploymentUrl(entry.serverUrl) === deploymentUrl(deployment.serverUrl))
    .map((entry) => entry.projectId)]);
  let newest: ProjectContextCache | undefined;
  for (const projectId of projects) {
    const spoolDir = spoolDirFor(projectId, mycoHome);
    if (pathIsAbsent(projectContextPath(spoolDir))) continue;
    const cache = readProjectContext(spoolDir);
    if (newest === undefined || (cache.featuresAt ?? 0) > (newest.featuresAt ?? 0)) newest = cache;
  }
  return newest?.features ?? [];
}

/** The Deployment advertisement; reporting surfaces unreadable snapshots and registries. */
export function readDeploymentFeaturesStrict(deployment: Deployment, mycoHome: string): CachedFeature[] {
  const snapshotPath = deploymentFeaturesPath(deployment.serverUrl, mycoHome);
  const snapshot = readCache<FeatureSnapshot>(snapshotPath);
  if (snapshot !== null && Array.isArray(snapshot.features)) return cachedDeploymentFeatures(snapshot.features.join(','));
  if (!pathIsAbsent(snapshotPath)) throw new Error('Cannot read the Deployment feature snapshot');
  return newestProjectFeatures(deployment, mycoHome);
}

/** Capture reads recover from cache failures using their own project, then the newest bound project. */
export function readDeploymentFeatures(deployment: Deployment, mycoHome: string): CachedFeature[] {
  const key = `${mycoHome}:${deploymentUrl(deployment.serverUrl)}:${deployment.projectId}`;
  const remembered = fallbackFeatures.get(key);
  if (remembered !== undefined && performance.now() < remembered.until) return remembered.features;
  let features: CachedFeature[] = [];
  let fallback = false;
  try {
    features = readDeploymentFeaturesStrict(deployment, mycoHome);
    fallback = pathIsAbsent(deploymentFeaturesPath(deployment.serverUrl, mycoHome));
    featureCacheDiagnostic(deployment.serverUrl, mycoHome, 'read');
  } catch (error) {
    fallback = true;
    featureCacheDiagnostic(deployment.serverUrl, mycoHome, 'read', error);
    let ownFeatures: CachedFeature[] | undefined;
    try {
      const ownDir = deployment.projectId.length > 0 ? spoolDirFor(deployment.projectId, mycoHome) : undefined;
      const own = ownDir === undefined ? null : readCache<ProjectContextCache>(projectContextPath(ownDir));
      if (own !== null && Array.isArray(own.features)) ownFeatures = cachedDeploymentFeatures(own.features.join(','));
    } catch { /* An unreadable own-project cache leaves the bound-project fallback available. */ }
    if (ownFeatures !== undefined) features = ownFeatures;
    else {
      try { features = newestProjectFeatures(deployment, mycoHome); }
      catch { /* The read failure was diagnosed; capture proceeds with no optional features. */ }
    }
  }
  if (fallback) fallbackFeatures.set(key, { features, until: performance.now() + FALLBACK_WINDOW_MS });
  return features;
}

/** Whether the Deployment named an optional capture feature. */
export function featureAdvertised(deployment: Deployment, mycoHome: string, feature: CachedFeature): boolean {
  return readDeploymentFeatures(deployment, mycoHome).includes(feature);
}

/**
 * Add an ask to the ones a session holds, replacing an older ask of the same kind: only the latest prompt is worth
 * asking about, and a block is asked for once per kind.
 */
export function withAsk(asks: readonly ContextAsk[] | undefined, ask: ContextAsk): ContextAsk[] {
  const kept = (asks ?? []).filter((held) => held.kind !== ask.kind);
  return [...kept, ask];
}
