/**
 * What a cutover keeps so every change it makes can be undone by hand, in
 * one folder of the 2.0 home and never beside the files, so a project's
 * working tree gains nothing.
 *
 * `<2.0 home>/backups/cutover-<stamp>/` mirrors each original's absolute path
 * for every file the cutover rewrites, removes or replaces (agent settings,
 * the 1.4 service unit, the claim files), each copy with the original's mode.
 * `manifest.json` lists every entry: a copy with its sha256, a file the
 * cutover created, or a link it removed or repointed with where it pointed.
 * `restore.md` holds the commands that undo them. A copy of a file the run
 * leaves unchanged is dropped once every change is made.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { writePrivateFileAtomic } from './store.js';

export type BackupEntry =
  | { original: string; backup: string; sha256: string }
  | { original: string; created: true }
  | { original: string; link: string };

export const MANIFEST_FILE = 'manifest.json';
export const RESTORE_FILE = 'restore.md';
const FOLDER_PREFIX = 'cutover-';

const sha256 = (bytes: Buffer): string => crypto.createHash('sha256').update(bytes).digest('hex');
const quote = (p: string): string => `'${p.replaceAll("'", "'\\''")}'`;

/** Where a cutover run's backups go. */
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
  return folders.some((folder) => readManifest(path.join(root, folder))
    .some((e) => 'sha256' in e && e.original === file && e.sha256 === digest && fs.existsSync(e.backup)));
}

/** What a backup folder undoes: a cutover from 1.4, or a member provisioning of this machine's agents. */
export type BackupPurpose = 'cutover' | 'provision';

/** The commands that undo a cutover's (or a provisioning's) changes, newest first. */
export function restoreRecipe(entries: readonly BackupEntry[], purpose: BackupPurpose = 'cutover'): string {
  const lines = [...entries].reverse().map((e) => {
    if ('backup' in e) return `cp -p ${quote(e.backup)} ${quote(e.original)}`;
    if ('link' in e) return `ln -sfn ${quote(e.link)} ${quote(e.original)}`;
    return `rm -f ${quote(e.original)}`;
  });
  if (purpose === 'provision') {
    return ['# Undo a Myco agent setup', '', 'Run, from any directory:', '', '```sh', ...lines, '```', ''].join('\n');
  }
  return [
    '# Undo a Myco cutover',
    '',
    'Stop anything using Myco 2.0 on this machine, then run, from any directory:',
    '',
    '```sh',
    ...lines,
    '```',
    '',
    'Then start the Myco 1.4 service again from its restored unit file, for example',
    '`launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/co.goondocks.myco.plist` on macOS.',
    'The 1.4 vaults were never changed; the Deployment keeps what was imported.',
    '',
  ].join('\n');
}

export class CutoverBackup {
  private readonly entries: BackupEntry[] = [];

  constructor(readonly dir: string, private readonly purpose: BackupPurpose = 'cutover') {}

  /** The copy's path: the original's absolute path, mirrored under the folder. */
  pathFor(original: string): string {
    return path.join(this.dir, path.resolve(original).replace(/^[A-Za-z]:/, '').replace(/^[\\/]+/, ''));
  }

  /** Copy `original`, keeping its mode, and record it. */
  take(original: string): BackupEntry {
    const backup = this.pathFor(original);
    fs.mkdirSync(path.dirname(backup), { recursive: true, mode: 0o700 });
    fs.copyFileSync(original, backup, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(backup, fs.statSync(original).mode & 0o7777);
    return this.record({ original, backup, sha256: sha256(fs.readFileSync(backup)) });
  }

  /** Record a file the cutover creates, so undoing it removes the file. */
  created(original: string): BackupEntry {
    return this.record({ original, created: true });
  }

  /** Record a link the cutover removes or repoints, with where it pointed. */
  link(original: string, target: string): BackupEntry {
    return this.record({ original, link: target });
  }

  /** Drop the copies of files still holding the bytes they were copied with; answer the entries kept. */
  pruneUnchanged(): BackupEntry[] {
    const kept = this.entries.filter((entry) => {
      if (!('sha256' in entry)) return true;
      let current: string | null = null;
      try { current = sha256(fs.readFileSync(entry.original)); } catch { /* a removed original keeps its copy */ }
      if (current !== entry.sha256) return true;
      fs.rmSync(entry.backup, { force: true });
      return false;
    });
    this.entries.splice(0, this.entries.length, ...kept);
    if (kept.length === 0) fs.rmSync(this.dir, { recursive: true, force: true });
    else this.write();
    return kept;
  }

  get all(): readonly BackupEntry[] {
    return this.entries;
  }

  private record(entry: BackupEntry): BackupEntry {
    this.entries.push(entry);
    this.write();
    return entry;
  }

  private write(): void {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writePrivateFileAtomic(path.join(this.dir, MANIFEST_FILE), `${JSON.stringify({ entries: this.entries }, null, 2)}\n`);
    writePrivateFileAtomic(path.join(this.dir, RESTORE_FILE), restoreRecipe(this.entries, this.purpose));
  }
}
