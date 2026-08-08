import fs from 'node:fs';
import path from 'node:path';

import type { ServiceSpec } from './types.js';

/**
 * Create the directories the supervisor redirects the daemon's output into.
 *
 * Every supervisor pins stdout/stderr to absolute paths and none of them create
 * the parent directory: systemd fails the unit outright with `status=209/STDOUT`
 * before the daemon runs at all. Two paths reach a crash-looping service that
 * way — a home whose log directory is removed after install, and a re-install
 * whose unit file is unchanged, which returns early.
 *
 * Measured on the rig: a member whose `~/.myco` was deleted and restored
 * crash-looped 41 times while `myco service start` reported "Started".
 *
 * Its OWN module rather than a `spec-builder` export, so a service manager
 * depends on directory creation without depending on spec construction. That is
 * also what keeps it out of reach of the whole-module stubs some tests install
 * over `spec-builder`, where a missing export breaks the importer at load.
 *
 * Idempotent and cheap, so callers run it unguarded.
 */
export function ensureServiceLogDirs(spec: Pick<ServiceSpec, 'stdoutPath' | 'stderrPath'>): void {
  fs.mkdirSync(path.dirname(spec.stdoutPath), { recursive: true });
  fs.mkdirSync(path.dirname(spec.stderrPath), { recursive: true });
}
