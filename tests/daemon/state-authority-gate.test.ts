/**
 * CI gate: forbid raw `fs.unlinkSync` / `fs.rmSync` / `fs.promises.unlink`
 * of the daemon-state path outside `daemon-state-authority.ts`.
 *
 * This is the always-on enforcement for the structural invariant the
 * authority module encapsulates: only one path in the codebase may
 * delete `daemon.json`, and that path requires a `reason` and an
 * owner-pid check. Any future caller that grows a raw unlink against
 * the state file is caught here.
 *
 * Sibling files under the service directory (`daemon.lock`,
 * `intent.*.toml`, `update.in-progress`, `update-error.json`) are
 * intentionally not covered — their lifecycle is owned by separate
 * primitives. This gate is narrowly scoped to `daemon.json`.
 */
import { describe, test, expect } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..', '..');
const SEARCH_ROOTS = [
  join(REPO_ROOT, 'packages/myco/src'),
  join(REPO_ROOT, 'packages/myco-shared/src'),
];
const AUTHORITY_FILE = join(REPO_ROOT, 'packages/myco/src/daemon/daemon-state-authority.ts');

const DELETE_OP =
  /\b(fs\.unlinkSync|fs\.rmSync|fs\.promises\.unlink|fs\.promises\.rm|unlinkSync|rmSync)\b/;
const DAEMON_STATE_REF =
  /(daemon\.json|daemonStatePath|statePath|DAEMON_STATE_FILENAME)/;

function walkTs(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) walkTs(full, acc);
    else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) acc.push(full);
  }
  return acc;
}

function isCommentLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

describe('daemon-state authority gate', () => {
  test('no production code outside the authority module unlinks daemon.json', () => {
    const offenders: string[] = [];
    for (const root of SEARCH_ROOTS) {
      for (const file of walkTs(root)) {
        if (file === AUTHORITY_FILE) continue;
        const text = readFileSync(file, 'utf-8');
        if (!DELETE_OP.test(text)) continue;
        const lines = text.split('\n');
        lines.forEach((line, idx) => {
          if (!DELETE_OP.test(line)) return;
          if (!DAEMON_STATE_REF.test(line)) return;
          if (isCommentLine(line)) return;
          offenders.push(`${file.slice(REPO_ROOT.length + 1)}:${idx + 1}: ${line.trim()}`);
        });
      }
    }

    if (offenders.length > 0) {
      const message = [
        'Unauthorized raw unlink of daemon.json detected outside daemon-state-authority.ts:',
        ...offenders.map((o) => `  ${o}`),
        '',
        'Route deletions through DaemonStateAuthority.deleteIfOwnedBy() or .deleteForUninstall().',
        'See packages/myco/src/daemon/daemon-state-authority.ts for the contract.',
      ].join('\n');
      throw new Error(message);
    }

    expect(offenders).toEqual([]);
  });
});
