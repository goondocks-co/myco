import { createHash } from 'node:crypto';
import path from 'node:path';

export const TRANSCRIPT_SOURCE_PREFIX = 'transcript:';

const PLAN_ID_HASH_LENGTH = 16;
const PLAN_PATH_KEY_PREFIX = 'path:';
const PLAN_SESSION_KEY_PREFIX = 'session:';
const PLAN_TAG_KEY_SEGMENT = ':tag:';
const PLAN_PLAN_KEY_SEGMENT = ':key:';
const PLAN_LEGACY_KEY_PREFIX = 'legacy:';
const PLAN_SESSION_LEGACY_KEY_SEGMENT = ':legacy:';
const WINDOWS_SEPARATOR = '\\';
const POSIX_SEPARATOR = '/';
const ABSOLUTE_PATH_PREFIXES = ['..', `..${path.sep}`];

function normalizePathSeparators(value: string): string {
  return value.replaceAll(WINDOWS_SEPARATOR, POSIX_SEPARATOR);
}

function isInsideRoot(relativePath: string): boolean {
  if (relativePath === '') return true;
  return !ABSOLUTE_PATH_PREFIXES.some((prefix) => relativePath === prefix || relativePath.startsWith(prefix))
    && !path.isAbsolute(relativePath);
}

export function normalizePlanSourcePath(sourcePath: string, projectRoot?: string): string {
  if (sourcePath.startsWith(TRANSCRIPT_SOURCE_PREFIX)) return sourcePath;

  const normalizedProjectRoot = projectRoot ? path.resolve(projectRoot) : null;
  const resolvedSourcePath = normalizedProjectRoot
    ? path.resolve(normalizedProjectRoot, sourcePath)
    : path.resolve(sourcePath);

  if (normalizedProjectRoot) {
    const relativePath = path.relative(normalizedProjectRoot, resolvedSourcePath);
    if (isInsideRoot(relativePath)) {
      return normalizePathSeparators(path.normalize(relativePath));
    }
  }

  if (path.isAbsolute(sourcePath)) {
    return normalizePathSeparators(path.normalize(resolvedSourcePath));
  }

  return normalizePathSeparators(path.normalize(sourcePath));
}

export function buildPathPlanLogicalKey(sourcePath: string, projectRoot?: string): string {
  return `${PLAN_PATH_KEY_PREFIX}${normalizePlanSourcePath(sourcePath, projectRoot)}`;
}

export function buildSessionTagPlanLogicalKey(sessionId: string, tag: string): string {
  return `${PLAN_SESSION_KEY_PREFIX}${sessionId}${PLAN_TAG_KEY_SEGMENT}${tag}`;
}

export function buildSessionPlanLogicalKey(sessionId: string, planKey: string): string {
  return `${PLAN_SESSION_KEY_PREFIX}${sessionId}${PLAN_PLAN_KEY_SEGMENT}${planKey}`;
}

export function buildLegacyPlanLogicalKey(
  id: string,
  sessionId?: string | null,
): string {
  return sessionId
    ? `${PLAN_SESSION_KEY_PREFIX}${sessionId}${PLAN_SESSION_LEGACY_KEY_SEGMENT}${id}`
    : `${PLAN_LEGACY_KEY_PREFIX}${id}`;
}

export function deriveStoredPlanLogicalKey(row: {
  id: string;
  source_path?: string | null;
  session_id?: string | null;
}): string {
  const sourcePath = row.source_path ?? null;
  if (sourcePath) {
    if (sourcePath.startsWith(TRANSCRIPT_SOURCE_PREFIX) && row.session_id) {
      return buildSessionTagPlanLogicalKey(
        row.session_id,
        sourcePath.slice(TRANSCRIPT_SOURCE_PREFIX.length),
      );
    }
    return buildPathPlanLogicalKey(sourcePath);
  }
  return buildLegacyPlanLogicalKey(row.id, row.session_id);
}

export function buildPlanId(logicalKey: string): string {
  return createHash('md5').update(logicalKey).digest('hex').slice(0, PLAN_ID_HASH_LENGTH);
}

export function buildScopedPlanId(logicalKey: string, projectId?: string | null): string {
  return projectId
    ? createHash('md5').update(`${projectId}\0${logicalKey}`).digest('hex').slice(0, PLAN_ID_HASH_LENGTH)
    : buildPlanId(logicalKey);
}

export function humanizePlanToken(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}
