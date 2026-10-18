/**
 * The runtime pin: which binary, and which home, a project's Myco runs under.
 *
 * A project pins them in `.myco/runtime.command` and `.myco/runtime.home`, and a machine in `~/.myco/runtime.command`
 * and `~/.myco/runtime.home`; the project's pin wins. The hook preamble reads the binary pin on every hook, so this
 * module stays a leaf: it reads files, and loads no configuration, no daemon and no store.
 */
import path from 'node:path';
import { MACHINE_RUNTIME_COMMAND_FILENAME } from '../constants/update.js';
import { resolveMycoHome } from '../paths/home.js';
import { readLayeredPin } from './binary-resolution.js';

/**
 * `~/.myco/runtime.command` — single source of truth for which `myco`
 * binary the launcher (`myco-run.cjs`, `myco-cli.cjs`, `bin/myco.cjs`)
 * should exec. Absent file means "use whatever PATH resolves `myco` to."
 *
 * Machine-scoped because the daemon itself is now machine-scoped: there
 * is exactly one daemon per machine, and the runtime that backs it is a
 * machine-level choice, not a per-project one.
 */
export function resolveMachineRuntimeCommandPath(mycoHome = resolveMycoHome()): string {
  return path.join(mycoHome, MACHINE_RUNTIME_COMMAND_FILENAME);
}

/**
 * Resolve the runtime pin from a launch cwd, used by the standalone launch
 * preamble. The project-scope pin is found by a pure filesystem upward walk
 * for `<dir>/.myco/runtime.command` (first non-empty wins, stopping at the
 * filesystem root); the machine-scope `~/.myco/runtime.command` is the
 * fallback.
 *
 * The walk must stay a filesystem walk — not a git-vault resolution — because
 * a git worktree's vault resolves to the MAIN repo root, which would skip a
 * worktree-local runtime override and route hooks to the wrong binary.
 */
export function resolveRuntimePinForCwd(cwd: string): string | null {
  return readLayeredPin({ kind: 'walk-up', from: cwd })?.pin ?? null;
}
