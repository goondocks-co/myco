/**
 * The runtime pin: which binary, and which home, a project's Myco runs under.
 *
 * A project pins them in `.myco/runtime.command` and `.myco/runtime.home`, and a machine in `~/.myco/runtime.command`
 * and `~/.myco/runtime.home`; the project's pin wins. The hook preamble reads the binary pin on every hook, so this
 * module stays a leaf: it reads files, and loads no configuration, no daemon and no store.
 */
import path from 'node:path';
import { MACHINE_RUNTIME_COMMAND_FILENAME, MACHINE_RUNTIME_HOME_FILENAME } from '../constants/update.js';
import { readHomePin, readMachineHomePin, resolveMycoHome } from '../paths/home.js';
import { readLayeredPin, readTrustedPin } from './binary-resolution.js';

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
 * Read the layered `runtime.command` pin and return the trimmed binary
 * path the launcher should exec, or null when no pin applies (the global
 * PATH-resolved `myco` is the implicit default).
 *
 * When `vaultDir` is supplied, `<vaultDir>/runtime.command` is checked
 * first (project-scope pin written by `make dev-link`); the machine-scope
 * `~/.myco/runtime.command` is the fallback (written by the beta-channel
 * installer). The CJS entry points implement the same layering via the
 * shared `bin/binary-resolution.cjs` module.
 */
export function resolveRuntimeCommand(vaultDir?: string): string | null {
  if (vaultDir) {
    const projectPin = readTrustedPin(path.join(vaultDir, 'runtime.command'));
    if (projectPin) return projectPin;
  }
  return readTrustedPin(resolveMachineRuntimeCommandPath());
}

/**
 * Read the layered `runtime.home` pin — the sibling of `runtime.command` —
 * and return the absolute home it redirects MYCO_HOME to, or null when no pin
 * applies (the prod `~/.myco` is the implicit default).
 *
 * Mirrors `resolveRuntimeCommand`'s layering: when `vaultDir` is supplied,
 * `<vaultDir>/runtime.home` (the project-scope dogfood pin) is checked first,
 * then the machine-scope `~/.myco/runtime.home`. Both are the home resolver's
 * own readers (`paths/home.ts`), so a daemon asking whether a project is
 * pinned elsewhere applies the rule that resolves the home in the first place —
 * same trust check, same `~` expansion.
 */
export function resolveRuntimeHome(vaultDir?: string): string | null {
  if (vaultDir) {
    const project = readHomePin(path.join(vaultDir, MACHINE_RUNTIME_HOME_FILENAME));
    if (project) return project;
  }
  return readMachineHomePin()?.home ?? null;
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
 * worktree-local pin written by `make dev-link-worktree` and route dogfood
 * hooks to the wrong binary.
 */
export function resolveRuntimePinForCwd(cwd: string): string | null {
  return readLayeredPin({ kind: 'walk-up', from: cwd })?.pin ?? null;
}
