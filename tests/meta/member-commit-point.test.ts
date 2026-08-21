/**
 * Meta gate: only the committer writes session state.
 *
 * A hook that persists its own de-dup receipt — a prompt hash, a plan hash, an
 * attachment key, the transcript's parsed size — makes a crash before the
 * append a permanent loss: nothing re-derives an event whose receipt is
 * already on disk. `runMemberHook` closes that window by writing the events
 * and the receipts together (`MemberSpool.appendAndRecord`), and handlers hand
 * their mutation back as `HookOutcome.record`.
 *
 * That property lives in the shape of the hooks, so a new hook file can
 * reintroduce it silently. This gate makes the import itself the thing that
 * fails: no module under `src/hooks/**` may reach a session-state WRITER.
 * Reading is fine — a handler decides what to emit by reading what is already
 * recorded.
 */
import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const HOOKS_DIR = path.join(REPO_ROOT, 'packages', 'myco', 'src', 'hooks');

/** Names that write the session-state file; `readSessionState` and friends are deliberately absent. */
const WRITERS = ['updateSessionState', 'writeSessionStateUnlocked', 'removeSessionState'];

function listTs(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listTs(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

describe('the commit point owns the receipts', () => {
  it('no hook imports a session-state writer', () => {
    const files = listTs(HOOKS_DIR);
    expect(files.length).toBeGreaterThan(10);
    const offenders: string[] = [];
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf-8');
      for (const match of source.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"][^'"]*session-state\.js['"]/g)) {
        const imported = match[1].split(',').map((name) => name.trim().split(/\s+as\s+/)[0].replace(/^type\s+/, ''));
        for (const name of imported) {
          if (WRITERS.includes(name)) offenders.push(`${path.relative(REPO_ROOT, file)} imports ${name}`);
        }
      }
    }
    expect(
      offenders,
      'A hook that writes session state writes a de-dup receipt for an event that may never be appended, '
      + 'and nothing re-derives an event whose receipt is on disk. Return the mutation as `HookOutcome.record` '
      + 'instead — `runMemberHook` applies it with the append, under one hold of the buffer lock.\n\n'
      + offenders.join('\n'),
    ).toEqual([]);
  });
});
