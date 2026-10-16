import fs from 'node:fs';
import path from 'node:path';

export interface FilesystemWitness {
  at: string;
  kind: 'root' | 'ancestor' | 'directory' | 'file';
  stamp: string;
}

function stamp(at: string, kind: FilesystemWitness['kind']): string {
  const stat = kind === 'directory' ? fs.statSync(at, { bigint: true }) : fs.lstatSync(at, { bigint: true });
  const identity = [stat.dev, stat.ino];
  return (kind === 'root' ? identity : (kind === 'ancestor' || kind === 'directory')
    ? [...identity, stat.mtimeNs, stat.ctimeNs]
    : [...identity, stat.size, stat.mode, stat.mtimeNs, stat.ctimeNs]).join(':');
}

/** File metadata and root topology validate derived identity indexes. */
export function filesystemWitnesses(roots: readonly string[], files: readonly string[] = [], directories: readonly string[] = []): FilesystemWitness[] {
  const paths = new Map<string, FilesystemWitness['kind']>();
  const physical = roots.flatMap(root => {
    try { return [root, fs.realpathSync.native(root)]; } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return [root];
      throw error;
    }
  });
  for (const root of physical) {
    if (!paths.has(root)) paths.set(root, 'root');
    for (let parent = path.dirname(root); ; parent = path.dirname(parent)) {
      paths.set(parent, 'ancestor');
      if (path.dirname(parent) === parent) break;
    }
  }
  for (const directory of directories) paths.set(directory, 'ancestor');
  for (const file of files) paths.set(file, 'file');
  return [...paths].flatMap(([at, kind]) => {
    try { return [{ at, kind, stamp: stamp(at, kind) }]; } catch (error) {
      if (kind !== 'file' && ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return [];
      throw error;
    }
  });
}

/** A changed or unreadable witness invalidates derived state. */
export function filesystemWitnessesCurrent(witnesses: readonly FilesystemWitness[]): boolean {
  try { return witnesses.every(witness => stamp(witness.at, witness.kind) === witness.stamp); } catch { return false; }
}

/** Root and ancestor identities detect replacement of any repository path component. */
export function rootTopologyWitnesses(roots: readonly string[]): FilesystemWitness[] {
  const paths = new Set<string>();
  for (const root of roots) {
    for (let at = root; ; at = path.dirname(at)) {
      paths.add(at);
      if (path.dirname(at) === at) break;
    }
  }
  return [...paths].map(at => ({ at, kind: 'root', stamp: stamp(at, 'root') }));
}
