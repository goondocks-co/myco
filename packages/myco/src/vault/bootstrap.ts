import fs from 'node:fs';
import path from 'node:path';
import { resolveVaultDir } from './resolve.js';
import {
  daemonVariantFromEnvValue,
  resolveMycoHome,
  PROJECT_MANIFEST_FILENAME,
  SERVICE_DEV_DIRNAME,
} from '../grove/paths.js';
import { listGroves, getDefaultGroveId, listRegisteredProjects, loadGroveRecord } from '../grove/registry.js';

/**
 * Resolve the bootstrap vault directory for daemon startup.
 *
 * Priority:
 *  1. **When `MYCO_SERVICE_VARIANT` is set** (i.e. the daemon is the
 *     global, multi-tenant daemon under a service supervisor — launchd,
 *     systemd — with a known variant), there is NO bootstrap project at
 *     all. The global daemon's home is `MYCO_HOME` (`~/.myco`); it serves
 *     every tenant through the per-request `MycoRequestContext` and never
 *     anchors to a "current project". Return `null` so the startup path
 *     materializes the phantom `MYCO_HOME`-scoped home and runs unbound.
 *
 *     This deliberately ignores both the cwd AND the registry. The cwd is
 *     irrelevant (a hook lazy-spawn from inside an unrelated project must
 *     not bind the daemon to it). The registry is irrelevant too: picking
 *     the *first registered project* as an anchor — the old behavior — is
 *     exactly the bug-attractor every tenant-scope leak we just fixed
 *     leaked *to*. An arbitrary project-shaped anchor has no business
 *     standing in for "the daemon's project" because the global daemon has
 *     no project. Per-request handlers carry their own caller-supplied
 *     tenancy (and tenant routes reject synthesized contexts), so the
 *     anchor is no longer needed for routing — only the home is, and the
 *     home resolves from the variant + `MYCO_HOME`, never from a project.
 *
 *  2. The cwd-walking `resolveVaultDir()` result, IF its parent contains
 *     a `project.toml`. Preserves the existing behavior for variant-less
 *     ad-hoc invocations (lazy spawn via `ensureRunning`, `myco daemon`
 *     run by hand from a project directory).
 *
 *  3. The first registered project in a Grove matching the current
 *     service variant — variant-less callers only (ad-hoc `myco daemon`
 *     from a non-project cwd that still wants the local registry's first
 *     project). Dev variant scans for a Grove with
 *     `served_by = "service-dev"`; prod variant (or unset) uses the
 *     default Grove from the registry.
 *
 * Returns `null` when the global variant is set (always — home-scoped), or
 * when no enclosing project AND no registered project is found. The
 * daemon's startup path falls back to a phantom MYCO_HOME-scoped scratch
 * dir so the API can come up and serve tenant requests by their own
 * request context (Decisions 3 and 14 of the global-symbiont-install plan).
 */
export function resolveBootstrapVaultDir(cwd: string = process.cwd()): string | null {
  const variant = process.env.MYCO_SERVICE_VARIANT?.trim();
  const sandboxMode = (process.env.MYCO_LAUNCH_AGENTS_DIR?.trim() ?? '') !== '';
  const cwdVault = resolveVaultDir(cwd);

  // The global, multi-tenant daemon has no bootstrap project. Its home is
  // MYCO_HOME and every request carries its own tenancy. Returning null
  // routes startup through the phantom-home path; the daemon never anchors
  // to an arbitrary registered project (the bug-attractor for tenant-scope
  // leaks). This intentionally ignores the registry — the previous
  // `firstProjectVaultFromRegistry()` anchor is gone from the global path.
  if (variant) {
    return null;
  }

  // Sandbox mode (MYCO_LAUNCH_AGENTS_DIR set) skips cwd-walk too.
  // A sandbox daemon's cwd is typically inside the developer's real
  // checkout (the smoke test starts the daemon from a project tree),
  // and cwd-walk would let it escape its sandbox by binding to the
  // real project's vault — defeating the whole point of running
  // sandboxed. Force the registry path; sandbox HOME's registry is
  // empty, so this falls through to phantom-bootstrap.
  if (sandboxMode) {
    return firstProjectVaultFromRegistry();
  }

  // Variant-less, production: original cwd-walk-first behavior.
  if (hasProjectManifest(cwdVault)) return cwdVault;

  const fromRegistry = firstProjectVaultFromRegistry();
  if (fromRegistry) return fromRegistry;

  // Greenfield: no enclosing project, no registered project. The daemon
  // bootstraps in vault-less mode and waits for a hook to register the
  // first project. See `resolveBootstrapVaultDirOrPhantom` for the
  // phantom scratch-dir fallback that daemon-internal scaffolding
  // (logger, machine id, secrets) keeps using.
  return null;
}

/**
 * Filesystem location of the phantom bootstrap vault used in greenfield
 * mode. Lives under MYCO_HOME so it never collides with a real project
 * vault and so its contents (machine_id cache, secrets fallbacks) move
 * with the rest of Myco's user state.
 *
 * The dir is created on first use. It is NOT a real Myco vault:
 *  - it has no `project.toml`, so `loadProjectManifest()` returns null;
 *  - it has no SQLite database, so any read scoped to it is empty;
 *  - any handler that requires a Grove binding will refuse to run.
 *
 * This is intentional. Project-scoped queries return empty until a
 * real project registers via the hook-driven auto-Grove-create flow;
 * the registry watcher then triggers a daemon restart so the next
 * boot finds the project through `firstProjectVaultFromRegistry()`.
 */
const PHANTOM_BOOTSTRAP_DIRNAME = '_unbound-bootstrap';

export function resolvePhantomBootstrapVaultDir(mycoHome = resolveMycoHome()): string {
  // Per-variant scratch vault: the dev daemon (service-dev) and the prod
  // daemon (service) anchor to separate dirs, so one daemon's boot-time
  // manifest cleanup never mutates the vault the other is running against.
  const variant = daemonVariantFromEnvValue(process.env.MYCO_SERVICE_VARIANT);
  const dirname = variant === SERVICE_DEV_DIRNAME
    ? `${PHANTOM_BOOTSTRAP_DIRNAME}-dev`
    : PHANTOM_BOOTSTRAP_DIRNAME;
  return path.join(mycoHome, dirname);
}

/**
 * Either the resolved bootstrap vault (when a project exists) or the
 * phantom MYCO_HOME-scoped scratch dir (greenfield). Callers that
 * cannot deal with a `null` vault — daemon scaffolding for the logger,
 * machine id, secrets, daemon-state — use this helper. Callers that
 * MUST refuse to operate without a real vault (Grove-scoped DB
 * handlers, manifest readers) use `resolveBootstrapVaultDir()`
 * directly and short-circuit on null.
 */
export function resolveBootstrapVaultDirOrPhantom(cwd: string = process.cwd()): {
  vaultDir: string;
  isPhantom: boolean;
} {
  const resolved = resolveBootstrapVaultDir(cwd);
  if (resolved) return { vaultDir: resolved, isPhantom: false };
  const phantom = resolvePhantomBootstrapVaultDir();
  fs.mkdirSync(phantom, { recursive: true });
  // The phantom dir holds machine id, secrets, log dir, and a config-empty
  // myco.yaml — no `[project] id`. Remove any stale manifest an older build
  // left behind.
  removeStalePhantomProjectManifest(phantom);
  ensurePhantomMycoYaml(phantom);
  return { vaultDir: phantom, isPhantom: true };
}

/**
 * Delete any `project.toml` a previous daemon build wrote into the phantom
 * vault. Best-effort.
 */
function removeStalePhantomProjectManifest(phantomVaultDir: string): void {
  const manifestPath = path.join(phantomVaultDir, PROJECT_MANIFEST_FILENAME);
  try {
    fs.rmSync(manifestPath, { force: true });
  } catch {
    // Best-effort.
  }
}

/**
 * Write a minimal `myco.yaml` into the phantom vault. The loader throws
 * (`packages/myco/src/config/loader.ts` `loadConfigInternal`) when this
 * file is missing — without it the daemon dies on its first
 * `loadMergedConfig` call. A bare `version: 3` doc parses cleanly and
 * the `MycoConfigSchema` defaults fill every other section, so the
 * phantom vault behaves as a config-empty project (no symbionts, no
 * scheduled tasks, no embedding provider) until the registry watcher
 * triggers a restart against a real vault.
 */
function ensurePhantomMycoYaml(phantomVaultDir: string): void {
  const configPath = path.join(phantomVaultDir, 'myco.yaml');
  if (fs.existsSync(configPath)) return;
  fs.writeFileSync(configPath, 'version: 3\n', { mode: 0o600 });
}

function hasProjectManifest(vaultDir: string): boolean {
  return fs.existsSync(path.join(vaultDir, PROJECT_MANIFEST_FILENAME));
}

/**
 * Pick the first on-disk registered project for the local registry.
 *
 * NOT part of the global daemon's startup path anymore: a daemon with
 * `MYCO_SERVICE_VARIANT` set never anchors to a project (it runs phantom
 * from `MYCO_HOME` and serves tenants by request context). The only
 * surviving callers are:
 *   - the variant-less ad-hoc path (`myco daemon` from a non-project cwd
 *     that still wants the local registry's first prod project), and
 *   - the sandbox-mode branch, whose isolated HOME has an empty registry
 *     so this always returns null → phantom-bootstrap.
 *
 * The `served_by` filter is retained for the variant-less prod default —
 * it must not silently bind a dev-served default Grove.
 */
function firstProjectVaultFromRegistry(): string | null {
  const mycoHome = resolveMycoHome();
  const targetServedBy = daemonVariantFromEnvValue(process.env.MYCO_SERVICE_VARIANT);

  if (targetServedBy === SERVICE_DEV_DIRNAME) {
    // Dev variant: find any Grove whose grove.toml says served_by = "service-dev".
    for (const grove of listGroves(mycoHome, { servedBy: 'service-dev' })) {
      const vault = firstVaultFromGrove(grove.id, mycoHome);
      if (vault) return vault;
    }
    return null;
  }

  // Prod variant (or unset): prefer the default Grove unless it is
  // explicitly served by the dev daemon, then fall through to any
  // other prod Grove. The served_by filter exists to close the
  // cross-variant escape hatch: a user who set a dev Grove as
  // default_grove_id and then installed the prod daemon must NOT
  // have the prod daemon silently bind to the dev Grove. That's
  // the exact cross-variant violation the variant-pinned design
  // exists to prevent.
  //
  // Groves without a grove.toml at all can't be bound either way —
  // `listRegisteredProjects` short-circuits on a missing record —
  // so the loadGroveRecord check below also filters them out, which
  // matches the pre-fix behavior (a Grove with no grove.toml never
  // contributed projects, the prior "legacy carve-out" comment was
  // misleading).
  const defaultId = getDefaultGroveId(mycoHome);
  if (defaultId) {
    const defaultRecord = loadGroveRecord(defaultId, mycoHome);
    if (defaultRecord && defaultRecord.served_by !== 'service-dev') {
      const vault = firstVaultFromGrove(defaultId, mycoHome);
      if (vault) return vault;
    }
  }
  for (const grove of listGroves(mycoHome, { servedBy: 'service' })) {
    if (grove.id === defaultId) continue; // already tried above
    const vault = firstVaultFromGrove(grove.id, mycoHome);
    if (vault) return vault;
  }
  return null;
}

function firstVaultFromGrove(groveId: string, mycoHome: string): string | null {
  for (const project of listRegisteredProjects(groveId, mycoHome)) {
    if (!project.root || !fs.existsSync(project.root)) continue;
    const vault = path.join(project.root, '.myco');
    if (hasProjectManifest(vault)) return vault;
  }
  return null;
}
