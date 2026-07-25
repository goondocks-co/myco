/**
 * Three-state reads for durable state: `present`, `absent`, `unknown`.
 *
 * A read that wraps `fs.*` in `try/catch` and returns `null` / `[]` collapses two
 * different facts into one value: "this genuinely is not here" and "I could not
 * find out". Callers then treat the second as the first, and the ones that go on
 * to delete, dequeue, advance a cursor, or mark something complete destroy data
 * on a transient `EACCES` or `EMFILE`.
 *
 * `absent` stays a first-class, silent domain answer — ENOENT is not an error and
 * must not become one. Everything else is `unknown`, and an `unknown` is never
 * authority to destroy.
 *
 * The discriminating read already existed in `grove/registry.ts`; this is that
 * idiom extracted so the destructive paths can share it.
 */
import fs from 'node:fs';

export type Presence<T> =
  | { state: 'present'; value: T }
  | { state: 'absent' }
  | { state: 'unknown'; error: NodeJS.ErrnoException };

export function present<T>(value: T): Presence<T> {
  return { state: 'present', value };
}

export const ABSENT: Presence<never> = { state: 'absent' };

export function unknown<T>(error: NodeJS.ErrnoException): Presence<T> {
  return { state: 'unknown', error };
}

/** Errno values that mean "the thing is genuinely not there". */
const ABSENCE_CODES: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR']);

/** Classify a caught filesystem error as absence or an undetermined read. */
export function classifyFsError<T>(err: unknown): Presence<T> {
  const errno = err as NodeJS.ErrnoException;
  if (errno && typeof errno.code === 'string' && ABSENCE_CODES.has(errno.code)) return ABSENT;
  return unknown(errno);
}

export function readFilePresence(filePath: string): Presence<string> {
  try {
    return present(fs.readFileSync(filePath, 'utf-8'));
  } catch (err) {
    return classifyFsError(err);
  }
}

export function statPresence(filePath: string): Presence<fs.Stats> {
  try {
    return present(fs.statSync(filePath));
  } catch (err) {
    return classifyFsError(err);
  }
}

export function readDirPresence(dir: string): Presence<fs.Dirent[]> {
  try {
    return present(fs.readdirSync(dir, { withFileTypes: true }));
  } catch (err) {
    return classifyFsError(err);
  }
}

/**
 * Collapse to a nullable value. Only for call sites where an undetermined read
 * and a genuine absence truly are equivalent — never on a path that goes on to
 * delete, dequeue, or mark complete.
 */
export function orNull<T>(result: Presence<T>): T | null {
  return result.state === 'present' ? result.value : null;
}
