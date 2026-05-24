import fs from 'node:fs';
import path from 'node:path';
import { resolveVaultDir } from './resolve.js';
import {
  resolveMycoHome,
  PROJECT_MANIFEST_FILENAME,
  SERVICE_DEV_DIRNAME,
} from '../grove/paths.js';
import { listGroves, getDefaultGroveId, listRegisteredProjects, loadGroveRecord } from '../grove/registry.js';
import { serviceVariantToDirName } from '../service/labels.js';
import { createProjectId } from '../grove/ids.js';

/**
 * Resolve the bootstrap vault directory for daemon startup.
 *
 * Priority:
 *  1. **When `MYCO_SERVICE_VARIANT` is set** (i.e. the daemon is under a
 *     service supervisor — launchd, systemd — with a known variant), use
 *     the variant-aware registry path **first**. The cwd at spawn time is
 *     irrelevant: we already know which Grove this daemon serves.
 *
 *     This guards against a previously-observed failure: a lazy-spawn
 *     triggered by a hook or MCP tool whose cwd is inside an unrelated
 *     project would bootstrap the daemon to that project's vault — even
 *     if that project's Grove is served by a *different* variant. The
 *     dashboard then refuses every request with "Cross-Grove access is
 *     forbidden" (API 500). Before this guard, the only thing that hid
 *     the race was the daemon's 87-second shutdown latency; once that
 *     was fixed, the wrong-cwd respawn won the port consistently.
 *
 *  2. The cwd-walking `resolveVaultDir()` result, IF its parent contains
 *     a `project.toml`. Preserves the existing behavior for variant-less
 *     ad-hoc invocations (lazy spawn via `ensureRunning`, `myco daemon`
 *     run by hand from a project directory).
 *
 *  3. The first registered project in a Grove matching the current
 *     service variant. Dev variant scans for a Grove with
 *     `served_by = "service-dev"`; prod variant (or unset) uses the
 *     default Grove from the registry.
 *
 * Returns `null` when no enclosing project AND no registered project
 * matching this daemon's variant is found. The daemon's startup path
 * falls back to a phantom MYCO_HOME-scoped scratch dir so the API can
 * come up and hooks can register the first project (Decisions 3 and 14
 * of the global-symbiont-install plan).
 *
 * Variant-pinned (MYCO_SERVICE_VARIANT set) ALSO returns null in
 * greenfield. The production user path is `npm install -g` →
 * postinstall registers a service → launchd/systemd spawns the daemon
 * with the variant env set, before any project exists. Throwing here
 * would respawn-loop the supervisor before the first hook could
 * register a project. The variant safety invariant is preserved: the
 * rebind watcher calls back through here, and `firstProjectVaultFromRegistry()`
 * still filters by `served_by` so a dev daemon binds only to dev Groves
 * and a prod daemon binds only to prod Groves.
 */
export function resolveBootstrapVaultDir(cwd: string = process.cwd()): string | null {
  const variant = process.env.MYCO_SERVICE_VARIANT?.trim();
  const cwdVault = resolveVaultDir(cwd);

  // Variant-pinned daemons trust their variant, not their cwd. Skip the
  // cwd-walk: a hook lazy-spawn from inside an unrelated project must
  // not bootstrap onto that project's vault when the variant pins us
  // to a specific Grove. firstProjectVaultFromRegistry() already
  // honors MYCO_SERVICE_VARIANT so the rebind watcher binds to the
  // right Grove without further plumbing.
  if (variant) {
    return firstProjectVaultFromRegistry();
  }

  // Variant-less: original cwd-walk-first behavior.
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
export function resolvePhantomBootstrapVaultDir(mycoHome = resolveMycoHome()): string {
  return path.join(mycoHome, '_unbound-bootstrap');
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
  ensurePhantomProjectManifest(phantom);
  ensurePhantomMycoYaml(phantom);
  return { vaultDir: phantom, isPhantom: true };
}

/**
 * Write a minimal `project.toml` into the phantom vault so the daemon's
 * manifest-aware paths (`loadProjectManifest`, `requestContextFromEnvironment`)
 * have a non-null shape to work against. The id is a real Grove-era
 * project id (`proj_<32hex>`) so it satisfies `assertGroveProjectId`, but
 * the manifest has no `grove` block — the daemon's `assertGroveBound`
 * path is skipped in phantom mode, so the unbound state is intentional.
 *
 * Persisted across boots so the phantom id stays stable; the daemon
 * restarts to a real vault as soon as the first project registers via
 * the hook-driven auto-Grove-create flow.
 */
function ensurePhantomProjectManifest(phantomVaultDir: string): void {
  const manifestPath = path.join(phantomVaultDir, PROJECT_MANIFEST_FILENAME);
  if (fs.existsSync(manifestPath)) return;
  const projectId = createProjectId();
  const body = `[project]\nid = "${projectId}"\nname = "myco-bootstrap"\n`;
  fs.writeFileSync(manifestPath, body, { mode: 0o600 });
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

function firstProjectVaultFromRegistry(): string | null {
  const mycoHome = resolveMycoHome();
  const variant = process.env.MYCO_SERVICE_VARIANT?.trim();
  const targetServedBy = serviceVariantToDirName(variant === 'dev' ? 'dev' : 'prod');

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
