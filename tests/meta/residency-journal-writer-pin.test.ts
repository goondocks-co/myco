/**
 * Only the daemon writes residency journals. The stamp/clear read-modify-write
 * in the drain is race-free ONLY under in-daemon serialization (single-flight
 * kicker + synchronous abort route); an out-of-process writer (a CLI command,
 * a hook) would silently reintroduce the resurrection race where a stamp
 * recreates a journal an abort just deleted. This pin holds the mutating
 * import surface to the daemon-side modules that legitimately own it.
 */
import { describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MUTATORS = [
  'writeResidencyJournal',
  'startResidencyJournal',
  'advanceResidencyPhase',
  'stampResidencyFailure',
  'clearResidencyFailure',
  'clearResidencyJournal',
  'clearResidencyStaging',
];

/** Daemon-side modules that own journal mutation. Shrink-only: adding a file
 *  here is a review obligation, and `cli/`, `hooks/`, `tools/` may NEVER
 *  appear — they run out-of-process. Honest limitation: this pins NAMES, not
 *  reachability — an allowlisted module re-exporting a mutator to an
 *  out-of-process caller would pass; the review obligation on this list is
 *  what covers that residue. */
const ALLOWED_MUTATOR_FILES = new Set([
  'packages/myco/src/host/residency-journal.ts',
  'packages/myco/src/host/residency-drain.ts',
  'packages/myco/src/host/residency-transition.ts',
]);

describe('residency journal writer pin', () => {
  test('journal mutators are referenced only from the daemon-side owner modules', () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
    const pattern = MUTATORS.join('|');
    let out = '';
    try {
      out = execSync(
        `grep -rlE '\\b(${pattern})\\b' --include='*.ts' --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=target --exclude-dir=tests packages 2>/dev/null`,
        { cwd: repoRoot, encoding: 'utf-8' },
      );
    } catch (err) {
      out = (err as { stdout?: string }).stdout ?? '';
    }
    const offenders = out.split('\n').filter(Boolean).filter((f) => !ALLOWED_MUTATOR_FILES.has(f));
    expect(offenders).toEqual([]);
  });

});
