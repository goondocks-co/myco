/**
 * Durable marker for a schema-version boot refusal.
 *
 * When the daemon meets a vault written by a NEWER binary (rollback
 * residue, a shared home crossed by versions), it must not touch the
 * database — and it must not crash-loop either: it writes this marker and
 * exits 0, the deliberate step-aside shape every service supervisor
 * leaves down (launchd `SuccessfulExit=false`, systemd `on-failure`, the
 * Windows launcher's exit-0 break). With no daemon there is no /health
 * and no log drain, so this file is the machine-readable signal doctor
 * reads to explain why the local service is down.
 *
 * Lives in the MYCO_HOME-scoped daemon state dir — never a hardcoded
 * `~/.myco` — so a dogfood daemon's refusal cannot surface in the
 * production doctor and vice versa. Cleared on every successful boot.
 */

import fs from 'node:fs';
import path from 'node:path';
import { epochSeconds } from '@myco/constants.js';
import type { SchemaVersionTooNewError } from '@myco/db/schema.js';

export interface SchemaRefusalMarker {
  /** The vault's stamped schema version (what the newer binary wrote). */
  found: number;
  /** The refusing binary's supported SCHEMA_VERSION. */
  supported: number;
  /** The refusing binary's package version. */
  binary_version: string;
  /** Epoch seconds of the most recent refusal (refreshed per attempt). */
  refused_at: number;
}

const MARKER_FILENAME = 'schema-refusal.json';

export function schemaRefusalMarkerPath(stateDir: string): string {
  return path.join(stateDir, MARKER_FILENAME);
}

/** Atomic (temp + rename) so a reader never sees a torn marker. */
export function writeSchemaRefusalMarker(
  stateDir: string,
  marker: Omit<SchemaRefusalMarker, 'refused_at'>,
): SchemaRefusalMarker {
  const full: SchemaRefusalMarker = { ...marker, refused_at: epochSeconds() };
  fs.mkdirSync(stateDir, { recursive: true });
  const target = schemaRefusalMarkerPath(stateDir);
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(full, null, 2), 'utf-8');
  fs.renameSync(tmp, target);
  return full;
}

export function clearSchemaRefusalMarker(stateDir: string): void {
  fs.rmSync(schemaRefusalMarkerPath(stateDir), { force: true });
}

/**
 * The daemon boot response to a too-new vault: durable marker, one stderr
 * line, then the step-aside `exit(0)`. Pulled out of `main()` so the exit
 * is injectable — tests prove the marker content and the exit code
 * without a process death. Must stay cheap and idempotent: hook activity
 * restarts the daemon on demand, so this branch re-runs (refreshing the
 * marker) until the binary is upgraded.
 */
export function handleBootSchemaRefusal(
  err: SchemaVersionTooNewError,
  stateDir: string,
  binaryVersion: string,
  io: { exit: (code: number) => never; stderr: (line: string) => void },
): never {
  writeSchemaRefusalMarker(stateDir, {
    found: err.foundVersion,
    supported: err.supportedVersion,
    binary_version: binaryVersion,
  });
  io.stderr(
    `[myco] refusing to start: vault schema v${err.foundVersion} is newer than `
      + `this binary supports (v${err.supportedVersion}). The database has not been `
      + `modified. Upgrade Myco on this machine (\`myco upgrade\`), or see \`myco doctor\`.`,
  );
  return io.exit(0);
}

export function readSchemaRefusalMarker(stateDir: string): SchemaRefusalMarker | null {
  let raw: string;
  try {
    raw = fs.readFileSync(schemaRefusalMarkerPath(stateDir), 'utf-8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<SchemaRefusalMarker>;
    if (
      typeof parsed.found !== 'number'
      || typeof parsed.supported !== 'number'
      || typeof parsed.binary_version !== 'string'
      || typeof parsed.refused_at !== 'number'
    ) {
      return null;
    }
    return parsed as SchemaRefusalMarker;
  } catch {
    return null;
  }
}
