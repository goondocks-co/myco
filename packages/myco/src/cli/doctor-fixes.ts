/**
 * Doctor fix registry — the single dispatch surface for `myco doctor --fix`.
 *
 * Each fixable check emitted by `cli/doctor.ts` carries a `fixId` naming
 * the fixer that repairs it (plus optional structured `fixData`). `fix()`
 * groups non-ok checks by `fixId` and invokes each present fixer exactly
 * once with its matched checks. A check without a `fixId` is never
 * dispatched — string-matching on check details is not a dispatch path.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DaemonStateAuthority } from '../daemon/daemon-state-authority.js';
import type { DoctorCheck } from './doctor.js';

/**
 * Shell rc files the POSIX installer appends its PATH export to, in its order.
 *
 * `.zshenv`, NOT `.zshrc`: zsh reads `.zshenv` for EVERY shell and `.zshrc`
 * only for interactive ones, so a `.zshrc` entry leaves `myco` unresolvable in
 * the non-interactive shells coding agents spawn. `.zshenv` is `create: true`
 * because it is the only zsh file that reaches those shells and is absent by
 * default; the rest are appended only when they already exist, so doctor never
 * invents a shell config the user does not use.
 */
const RC_TARGETS = [
  { name: '.zshenv', create: true },
  { name: '.bashrc', create: false },
  { name: '.profile', create: false },
] as const;

/** A PATH prepend that repeated sourcing cannot duplicate. */
function pathExportBlock(binDir: string): string {
  return [
    '',
    '# Added by Myco (myco doctor --fix).',
    'case ":$PATH:" in',
    `  *":${binDir}:"*) ;;`,
    `  *) export PATH="${binDir}:$PATH" ;;`,
    'esac',
    '',
  ].join('\n');
}

export type DoctorFixerId =
  | 'daemon-stale'
  | 'daemon-malformed'
  | 'smoke-launcher-scrub'
  | 'migration-retry'
  | 'service-reinstall'
  | 'symbiont-global-refresh'
  | 'path-bindir'
  | 'runtime-pin';

export interface DoctorFixContext {
  vaultDir: string;
  authority: DaemonStateAuthority;
}

export const DOCTOR_FIXERS: Record<DoctorFixerId, (ctx: DoctorFixContext, matched: DoctorCheck[]) => Promise<string[]>> = {
  // Fix stale daemon.json — re-read under the authority and only unlink
  // if the recorded pid still matches the pid we observed as dead. If a
  // concurrent successor wrote into the gap, the unlink is a no-op and
  // the file is preserved.
  'daemon-stale': async (ctx, matched) => {
    const actions: string[] = [];
    for (const check of matched) {
      const stalePid = typeof check.fixData?.stalePid === 'number' ? check.fixData.stalePid : NaN;
      if (!Number.isFinite(stalePid)) continue;
      const outcome = ctx.authority.deleteIfOwnedBy(stalePid, { reason: 'doctor:stale' });
      actions.push(
        outcome === 'deleted'
          ? `Removed stale daemon state (PID ${stalePid})`
          : `Daemon state already refreshed by a successor (was PID ${stalePid}) — no action`,
      );
    }
    return actions;
  },

  // Fix malformed daemon.json — by definition the file was unparseable
  // when the check ran. The authority re-reads under the same
  // discipline: if a successor refreshed the file between detection
  // and fix, leave it alone.
  'daemon-malformed': async (ctx) => {
    const outcome = ctx.authority.deleteIfMalformed({ reason: 'doctor:malformed' });
    return [
      outcome === 'deleted'
        ? 'Removed malformed daemon state'
        : 'Daemon state already refreshed by a successor — no action',
    ];
  },

  // Scrub stale escaped smoke-launcher hook groups from global agent
  // config files via the global-config migration pass.
  'smoke-launcher-scrub': async () => {
    const actions: string[] = [];
    try {
      const { runGlobalConfigMigration } = await import('../grove/global-config-migration.js');
      const result = runGlobalConfigMigration();
      const repaired = result.outcomes.filter((outcome) => outcome.entriesRemoved > 0 && !outcome.error);
      const failed = result.outcomes.filter((outcome) => outcome.entriesRemoved > 0 && outcome.error);
      for (const outcome of repaired) {
        actions.push(`Scrubbed ${outcome.entriesRemoved} stale smoke-launcher hook group(s) from ${outcome.filePath}`);
      }
      for (const outcome of failed) {
        actions.push(`Failed to scrub stale smoke-launcher hooks from ${outcome.filePath}: ${outcome.error}`);
      }
      if (repaired.length === 0 && failed.length === 0) {
        actions.push('No stale smoke-launcher hooks remained to scrub');
      }
    } catch (err) {
      actions.push(`Smoke-launcher scrub failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return actions;
  },

  // Migration retry — re-run the project-local → global walker. The
  // walker is the same code path the daemon's first-start bootstrap
  // uses; the audit-log writer deduplicates so previously-erroring
  // projects that now succeed have their error rows dropped, and
  // projects still failing get their error rows refreshed in place.
  //
  // Walks the full set rather than per-project so the audit log stays
  // consistent — a project that succeeds this pass has its prior error
  // row removed, not preserved alongside the new outcome.
  'migration-retry': async (_ctx, matched) => {
    const actions: string[] = [];
    try {
      const { runGlobalInstallMigrationPass } = await import('../grove/global-install-migration.js');
      const { recordMigrationPass } = await import('../db/queries/migration-log.js');
      const { getDatabase } = await import('../db/client.js');
      const beforeRoots = new Set<string>();
      for (const check of matched) {
        const root = check.fixData?.projectRoot;
        if (typeof root === 'string' && root.length > 0) beforeRoots.add(root);
      }
      const result = runGlobalInstallMigrationPass();
      recordMigrationPass(getDatabase(), result);
      const errorsByRoot = new Map<string, string>();
      for (const outcome of result.outcomes) {
        if (outcome.error) errorsByRoot.set(outcome.projectRoot, outcome.error);
      }
      for (const root of beforeRoots) {
        if (errorsByRoot.has(root)) {
          actions.push(`Retried migration for ${root}: still failing: ${errorsByRoot.get(root)}`);
        } else {
          actions.push(`Retried migration for ${root}: succeeded`);
        }
      }
    } catch (err) {
      actions.push(`Migration retry failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return actions;
  },

  // Reinstall the daemon service unit. Covers both Service failure
  // modes — not installed, and installed-but-executable-missing. Runs
  // once even when both checks matched.
  'service-reinstall': async () => {
    const { resolveServiceExecutable, assertSafeServiceMutation } = await import('./service.js');
    const { buildServiceSpec } = await import('../service/spec-builder.js');
    const { getServiceManager } = await import('../service/manager.js');
    const { serviceLabel } = await import('../service/labels.js');
    const { resolveMycoHome } = await import('../grove/paths.js');

    const mycoHome = resolveMycoHome();
    const refusal = assertSafeServiceMutation({ action: 'install' }, process.execPath, mycoHome);
    if (refusal) return [refusal];

    // Spec R-M3: the dangerous shape is a BOOT-observed unit — reinstalling
    // the login unit beside it gives two supervisors one daemon. Keyed on
    // OBSERVED state (config intent alone would miss intent-login+observed-boot).
    {
      const { resolveObservedScope } = await import('../service/scoped.js');
      const { serviceLabel: resolveLabel } = await import('../service/labels.js');
      const observed = await resolveObservedScope(resolveLabel(mycoHome));
      if (observed === 'boot' || observed === 'both') {
        return [
          `Refusing service-reinstall: the ${observed === 'both' ? 'boot AND login units' : 'boot unit'} `
          + 'own this daemon. Use `myco service install` to converge scope instead.',
        ];
      }
    }

    // The 'executable missing' check fires precisely when the recorded
    // command is gone, and buildServiceSpec throws on a missing path —
    // fall back to the running binary.
    let executable = resolveServiceExecutable(mycoHome);
    if (!fs.existsSync(executable)) executable = process.execPath;

    let spec: import('../service/types.js').ServiceSpec;
    try {
      spec = buildServiceSpec({ mycoHome, executable });
    } catch (err) {
      return [err instanceof Error ? err.message : String(err)];
    }
    const mgr = getServiceManager();
    const label = serviceLabel(mycoHome);
    // A throwing manager must surface as a failed action, not escape
    // fix() — an uncaught throw would discard the other fixers' action
    // reports and skip the post-fix recheck.
    try {
      await mgr.install(spec, { force: true });
      await mgr.start(label);
    } catch (err) {
      return [`Service reinstall failed: ${err instanceof Error ? err.message : String(err)}`];
    }
    return [`Reinstalled ${label} service and started it`];
  },

  // Re-run global symbiont detection, which rewrites every Myco-owned
  // hook group in every detected agent's global config. Foreign hook
  // groups are untouched — a partial fix is expected for files mixing
  // Myco-owned and foreign groups.
  'symbiont-global-refresh': async () => {
    const { runSymbiontDetection } = await import('./bootstrap.js');
    runSymbiontDetection();
    return ['Re-ran global symbiont config refresh (rewrites Myco-owned hook groups)'];
  },

  // Append the managed bin dir to PATH in the user's shell rc files — the
  // same idempotent edit `install.sh` performs when the dir isn't already on
  // PATH. Existence-gated per file (never creates an rc file the user's shell
  // may not read) and content-gated on the dir string, so re-running is inert.
  'path-bindir': async (_ctx, matched) => {
    const actions: string[] = [];
    const binDirs = new Set<string>();
    for (const check of matched) {
      const dir = check.fixData?.binDir;
      if (typeof dir === 'string' && dir.length > 0) binDirs.add(dir);
    }
    for (const binDir of binDirs) {
      let appended = 0;
      let alreadyPresent = 0;
      for (const target of RC_TARGETS) {
        const rcPath = path.join(os.homedir(), target.name);
        try {
          const exists = fs.existsSync(rcPath);
          if (!exists && !target.create) continue;
          if (exists && fs.readFileSync(rcPath, 'utf8').includes(binDir)) {
            alreadyPresent += 1;
            continue;
          }
          fs.appendFileSync(rcPath, pathExportBlock(binDir));
          actions.push(`Added ${binDir} to PATH in ${rcPath}`);
          appended += 1;
        } catch (err) {
          actions.push(`Could not update ${rcPath}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (appended > 0) {
        actions.push(`Restart your shell or run: export PATH="${binDir}:$PATH"`);
      } else if (alreadyPresent > 0) {
        actions.push(`${binDir} is already exported in a shell rc file — restart your shell to pick it up`);
      } else {
        actions.push(`No shell rc file found to update — add ${binDir} to PATH manually`);
      }
    }
    return actions;
  },

  // Write the machine runtime pin. This is what makes `myco` resolvable
  // WITHOUT PATH for the hook guard, the Pi extension's tool dispatch, and the
  // npm shim's redirect — the consumers that GUI-launched agents (minimal
  // launchd PATH) and non-interactive shells would otherwise fail.
  'runtime-pin': async (_ctx, matched) => {
    const actions: string[] = [];
    for (const check of matched) {
      const pinPath = check.fixData?.pinPath;
      const managedBinary = check.fixData?.managedBinary;
      if (typeof pinPath !== 'string' || typeof managedBinary !== 'string') continue;
      try {
        fs.mkdirSync(path.dirname(pinPath), { recursive: true });
        fs.writeFileSync(pinPath, `${managedBinary}\n`, { mode: 0o644 });
        // The readers refuse a group/other-writable pin (it is exec'd as the
        // user's `myco`), and writeFileSync's mode is masked by umask — so set
        // the mode explicitly rather than trusting the create flags.
        fs.chmodSync(pinPath, 0o644);
        actions.push(`Wrote runtime pin ${pinPath} -> ${managedBinary}`);
      } catch (err) {
        actions.push(`Could not write ${pinPath}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return actions;
  },
};
