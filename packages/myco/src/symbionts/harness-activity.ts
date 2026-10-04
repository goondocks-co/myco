import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Database, constants } from 'bun:sqlite';
import { HARNESS_SILENT_MS } from '@goondocks/myco-shared/harness-health';
import type { SymbiontManifest } from '@myco/symbionts/manifest-schema.js';
import { enumerateSessionRecords, expandRoot } from '@myco/symbionts/transcript-discovery.js';
import { WorkerSessionEvidence } from '@myco/symbionts/worker-session-evidence.js';

type ActivitySource = NonNullable<SymbiontManifest['health']>['activityLocations'][number];
const ACTIVITY_BUSY_TIMEOUT_MS = 200;
const SQLITE_JOURNAL_MODE_OFFSET = 18;
const SQLITE_WAL_MODE = 2;

function requireWalSidecars(file: string): void {
  const fd = fs.openSync(file, 'r');
  try {
    const mode = Buffer.alloc(1);
    fs.readSync(fd, mode, 0, mode.length, SQLITE_JOURNAL_MODE_OFFSET);
    if (mode[0] === SQLITE_WAL_MODE) {
      for (const suffix of ['-wal', '-shm']) {
        const sidecar = fs.openSync(`${file}${suffix}`, 'r');
        fs.closeSync(sidecar);
      }
    }
  } finally { fs.closeSync(fd); }
}

function* fileSessions(source: Extract<ActivitySource, { kind: 'file' }>, manifest: SymbiontManifest, mycoHome: string): Iterable<{ id: string; at: number }> {
  const discovery = manifest.capture?.transcriptDiscovery;
  if (source.path === '@transcripts' && discovery === undefined) throw new Error('Activity references unavailable transcript layouts');
  const locations = source.path === '@transcripts'
    ? (discovery?.roots ?? []).flatMap((root) => discovery!.patterns.map((pattern) => path.join(expandRoot(root, process.env, mycoHome), pattern)))
    : [expandRoot(source.path, process.env, mycoHome)];
  for (const location of locations) {
    for (const { sessionId, filePath } of enumerateSessionRecords(location, discovery?.sessionIdPattern)) {
      try {
        const stat = fs.lstatSync(filePath);
        if (stat.isFile()) yield { id: sessionId, at: Math.trunc(stat.mtimeMs) };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
}

function* sqliteSessions(source: Extract<ActivitySource, { kind: 'sqlite' }>, cutoff: number, mycoHome: string): Iterable<{ id: string; at: number }> {
  const dataHome = source.dataHomeEnv === undefined ? undefined : process.env[source.dataHomeEnv] || source.dataHomeDefault!;
  const file = expandRoot(dataHome === undefined ? source.path : path.join(dataHome, source.path), process.env, mycoHome);
  requireWalSidecars(file);
  const uri = pathToFileURL(path.resolve(file));
  uri.search = 'mode=ro&immutable=0&readonly_shm=1';
  const db = new Database(uri.href, constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI);
  try {
    db.run(`PRAGMA busy_timeout = ${ACTIVITY_BUSY_TIMEOUT_MS}`);
    db.run('PRAGMA query_only = ON');
    for (const row of db.query<Record<string, unknown>, [number]>(source.query).iterate(cutoff)) {
      const id = row[source.sessionIdColumn];
      const at = row[source.timeColumn];
      if (typeof id !== 'string' || id.length === 0 || typeof at !== 'number' || !Number.isSafeInteger(at) || at < 0) throw new Error('Session activity query returned invalid identity or time');
      yield { id, at };
    }
  } finally { db.close(); }
}

/** Read only per-session identity and time; unavailable sources throw rather than imply idle activity. */
export function readHarnessActivity(manifest: SymbiontManifest, mycoHome: string, now: number): number | undefined {
  const workers = new WorkerSessionEvidence(mycoHome);
  const epoch = workers.epoch(manifest.name);
  if (workers.starting(manifest.name)) throw new Error('Worker session identity is not yet available');
  workers.prune(now);
  const cutoff = now - HARNESS_SILENT_MS;
  let newest: number | undefined;
  for (const source of manifest.health?.activityLocations ?? []) {
    const sessions = source.kind === 'sqlite' ? sqliteSessions(source, cutoff, mycoHome) : fileSessions(source, manifest, mycoHome);
    for (const { id, at } of sessions) {
      if (at >= cutoff && !workers.has(manifest.name, id)) newest = Math.max(newest ?? 0, at);
    }
  }
  if (workers.starting(manifest.name) || workers.epoch(manifest.name) !== epoch) throw new Error('Worker session identity changed during activity inspection');
  return newest;
}
