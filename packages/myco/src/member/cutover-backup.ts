/**
 * The copies a cutover takes of every settings file before it changes one,
 * kept together in one folder of the 2.0 home and never beside the files, so
 * a project's working tree gains nothing.
 *
 * `<2.0 home>/backups/cutover-<stamp>/` mirrors each original's absolute path,
 * and its `manifest.json` lists every original, its copy and the copy's
 * sha256. A copy keeps the original's mode. A copy of a file the run leaves
 * unchanged is dropped once every change is made.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { writePrivateFileAtomic } from './store.js';

export interface BackupEntry {
  original: string;
  backup: string;
  sha256: string;
}

export const MANIFEST_FILE = 'manifest.json';
const FOLDER_PREFIX = 'cutover-';

const sha256 = (bytes: Buffer): string => crypto.createHash('sha256').update(bytes).digest('hex');

/** Where a cutover run's copies go. */
export const cutoverBackupDir = (mycoHome: string, stamp: string): string => path.join(mycoHome, 'backups', `${FOLDER_PREFIX}${stamp}`);

function readManifest(dir: string): BackupEntry[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST_FILE), 'utf8')) as { entries?: unknown };
    return Array.isArray(parsed.entries) ? parsed.entries as BackupEntry[] : [];
  } catch { return []; }
}

/** Whether an earlier cutover already holds a copy of `file` with exactly its current bytes. */
export function earlierCopyHolds(mycoHome: string, file: string): boolean {
  const root = path.join(mycoHome, 'backups');
  let folders: string[];
  try { folders = fs.readdirSync(root).filter((n) => n.startsWith(FOLDER_PREFIX)); } catch { return false; }
  let digest: string;
  try { digest = sha256(fs.readFileSync(file)); } catch { return false; }
  return folders.some((folder) => readManifest(path.join(root, folder)).some((e) => e.original === file && e.sha256 === digest && fs.existsSync(e.backup)));
}

export class CutoverBackup {
  private readonly entries: BackupEntry[] = [];

  constructor(readonly dir: string) {}

  /** The copy's path: the original's absolute path, mirrored under the folder. */
  pathFor(original: string): string {
    return path.join(this.dir, path.resolve(original).replace(/^[A-Za-z]:/, '').replace(/^[\\/]+/, ''));
  }

  /** Copy `original`, keeping its mode, and record it in the manifest. */
  take(original: string): BackupEntry {
    const backup = this.pathFor(original);
    fs.mkdirSync(path.dirname(backup), { recursive: true, mode: 0o700 });
    fs.copyFileSync(original, backup, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(backup, fs.statSync(original).mode & 0o7777);
    const entry = { original, backup, sha256: sha256(fs.readFileSync(backup)) };
    this.entries.push(entry);
    this.writeManifest();
    return entry;
  }

  /** Drop the copies of files still holding the bytes they were copied with; answer the copies kept. */
  pruneUnchanged(): BackupEntry[] {
    const kept = this.entries.filter((entry) => {
      let current: string | null = null;
      try { current = sha256(fs.readFileSync(entry.original)); } catch { /* a removed original keeps its copy */ }
      if (current !== entry.sha256) return true;
      fs.rmSync(entry.backup, { force: true });
      return false;
    });
    this.entries.splice(0, this.entries.length, ...kept);
    if (kept.length === 0) fs.rmSync(this.dir, { recursive: true, force: true });
    else this.writeManifest();
    return kept;
  }

  private writeManifest(): void {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writePrivateFileAtomic(path.join(this.dir, MANIFEST_FILE), `${JSON.stringify({ entries: this.entries }, null, 2)}\n`);
  }
}
