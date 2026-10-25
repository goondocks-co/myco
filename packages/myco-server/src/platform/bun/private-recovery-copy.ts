import fs from 'node:fs';
import path from 'node:path';
import { admitThinLearningRemoval, thinLearningUpgradeAdmission, THIN_LEARNING_NOT_DRAINED, THIN_LEARNING_PAUSE_VERSION, THIN_LEARNING_PRE_PAUSE_ADMISSION_SQL, THIN_LEARNING_REMOVAL_VERSION, THIN_LEARNING_RUNS_TABLE_SQL, THIN_LEARNING_UPGRADE_REMEDY } from '../../db/thin-learning-admission.js';

export const PRIVATE_RECOVERY_COPY_REQUIRED = 'private_recovery_copy_required';
const RUNS_SCHEMA_VERSION = 7;

export interface PrivateRecoveryCopy { readonly databasePath: string }
const copies = new WeakMap<PrivateRecoveryCopy, { path: string; dev: number; ino: number }>();

/** Only a newly copied, verified file receives a callback-scoped recovery identity. */
export async function withPrivateRecoveryCopy<T>(source: string, verify: (file: string) => Promise<void>, use: (copy: PrivateRecoveryCopy) => Promise<T>): Promise<T> {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(path.dirname(source)), '.recovery-data-'));
  fs.chmodSync(directory, 0o700);
  const databasePath = path.join(directory, 'myco.sqlite');
  const copy = Object.freeze({ databasePath });
  try {
    fs.copyFileSync(source, databasePath, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(databasePath, 0o600);
    const created = fs.lstatSync(databasePath);
    await verify(databasePath);
    const stat = fs.lstatSync(databasePath);
    if (!stat.isFile() || stat.nlink !== 1 || stat.dev !== created.dev || stat.ino !== created.ino
      || fs.realpathSync(databasePath) !== databasePath) throw new Error(PRIVATE_RECOVERY_COPY_REQUIRED);
    copies.set(copy, { path: databasePath, dev: stat.dev, ino: stat.ino });
    return await use(copy);
  } finally {
    copies.delete(copy);
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

/** Recovery authority is bound to one live callback and its original private file. */
export function assertPrivateRecoveryCopy(copy: PrivateRecoveryCopy, databasePath: string): void {
  const held = copies.get(copy);
  if (held === undefined || databasePath !== held.path) throw new Error(PRIVATE_RECOVERY_COPY_REQUIRED);
  const stat = fs.lstatSync(databasePath);
  if (!stat.isFile() || stat.nlink !== 1 || fs.realpathSync(databasePath) !== held.path || stat.dev !== held.dev || stat.ino !== held.ino) throw new Error(PRIVATE_RECOVERY_COPY_REQUIRED);
}

/** A private legacy copy must drain before migration can terminalize queued learning. */
export function* recoveryCopyAdmission(copy: PrivateRecoveryCopy, databasePath: string, before: number, target: number, report: (line: string) => void): Generator<string, void, Record<string, unknown>[]> {
  assertPrivateRecoveryCopy(copy, databasePath);
  if (before >= THIN_LEARNING_PAUSE_VERSION || target < THIN_LEARNING_REMOVAL_VERSION) {
    yield* thinLearningUpgradeAdmission(before, target, report);
    return;
  }
  if (before < RUNS_SCHEMA_VERSION) {
    const tables = yield THIN_LEARNING_RUNS_TABLE_SQL;
    if (tables.length === 0) return;
    if (tables.length !== 1 || tables[0]!.name !== 'agent_runs') throw new Error('thin learning admission returned an invalid table result');
  }
  try { admitThinLearningRemoval(yield THIN_LEARNING_PRE_PAUSE_ADMISSION_SQL); }
  catch (error) {
    if (error instanceof Error && error.message === THIN_LEARNING_NOT_DRAINED) report(THIN_LEARNING_UPGRADE_REMEDY);
    throw error;
  }
}
