/**
 * Copyright 2026 Chris Kirby
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Headscale scope convergence — the mechanism behind E1 §7 gate 2
 * ("headscale's OBSERVED scope equals the daemon's OBSERVED scope").
 *
 * Headscale follows the daemon's `daemon.service_scope` (E1 spec §3.2), but
 * nothing structural ties the two units together: `myco service install`
 * historically transitioned only the daemon's own label, so converging the
 * daemon to boot would strand headscale at login — the exact asymmetry the
 * re-scope exists to abolish, silently restored. This module is the
 * propagation: `classifyHeadscaleScope` is the shared READ (consumed by the
 * doctor row and the CLI), `convergeHeadscaleScope` is the CLI-driven WRITE
 * (`transitionServiceScope` is CLI-only by construction — its rollback
 * re-elevates via `sudo -n`, which cannot prompt; see gotcha-270e6131).
 */
import fs from 'node:fs';
import path from 'node:path';

import { loadMachineConfig } from '@myco/config/loader.js';
import { DEFAULT_LAUNCH_DAEMONS_DIR, DEFAULT_SYSTEMD_SYSTEM_DIR } from '@myco/service/boot-backend.js';
import {
  boundedServiceRunner,
  getScopedServiceManager,
  resolveObservedScope,
  transitionServiceScope,
} from '@myco/service/scoped.js';
import type { ServiceScope } from '@myco/service/types.js';
import { resolveHostControlDir } from '@myco/grove/paths.js';

import { headscaleLayout } from './headscale-config.js';
import { readHostState } from './state.js';
import { HEADSCALE_SERVICE_LABEL, buildOverlayServiceSpec } from './system-service.js';

export type HeadscaleScopeVerdict =
  /** Host serving is off — headscale scope is nobody's concern. */
  | 'not-serving'
  /** Unit observed in the domain the daemon's scope calls for. */
  | 'converged'
  /** Serving enabled but no unit in any domain — `myco host enable` is the fix. */
  | 'missing'
  /** Unit in the wrong domain, but a Myco invoking-user cell — transitionable. */
  | 'drift'
  /** A legacy boot×root unit (pre-1.3.1). No migration exists (E1 §3.3 rev 5):
   *  the fix is `myco host disable` + `myco host enable`, and the teardown
   *  half needs sudo on BOTH platforms. */
  | 'legacy-root'
  /** Units in BOTH domains — the dangerous state; disable-then-enable. */
  | 'both';

export interface HeadscaleScopeReport {
  verdict: HeadscaleScopeVerdict;
  observed: 'login' | 'boot' | 'both' | 'none';
  /** The domain `daemon.service_scope` calls for. */
  targetDomain: 'login' | 'boot';
}

/** Test seams: unit-dir overrides flow through to the observation and the
 *  legacy-root classification, so verdicts are provable without touching
 *  /Library/LaunchDaemons or /etc/systemd/system. */
export interface HeadscaleScopeOptions {
  platform?: NodeJS.Platform;
  loginUnitDir?: string;
  bootUnitDir?: string;
}

/** The headscale unit's SYSTEM-domain path. Exported: `hostDisable` routes
 *  its teardown by ACTUAL unit location — never by semantic scope, which
 *  reads the Linux linger cell (a USER unit) as 'boot' and would demand
 *  sudo for a system unit that does not exist. */
export function headscaleSystemUnitPath(platform: NodeJS.Platform, bootUnitDir?: string): string {
  const dir = bootUnitDir ?? (platform === 'darwin' ? DEFAULT_LAUNCH_DAEMONS_DIR : DEFAULT_SYSTEMD_SYSTEM_DIR);
  return path.join(dir, platform === 'darwin' ? `${HEADSCALE_SERVICE_LABEL}.plist` : `${HEADSCALE_SERVICE_LABEL}.service`);
}

/** Does the system-domain unit (if any) run as the invoking user?
 *  darwin: the boot×invoking-user cell emits `UserName` (launchd-plist.ts);
 *  the legacy root cell never does. The match is anchored to the renderer's
 *  TOP-LEVEL two-space indentation — EnvironmentVariables entries render at
 *  four spaces, so an env var named `UserName` can never false-positive a
 *  legacy root cell into "converged". linux: the boot×invoking-user cell is
 *  a USER unit + linger — a file in /etc/systemd/system is always root-cell. */
function bootUnitRunsAsUser(platform: NodeJS.Platform, bootUnitDir?: string): boolean {
  if (platform !== 'darwin') return false;
  try {
    return /^ {2}<key>UserName<\/key>$/m.test(
      fs.readFileSync(headscaleSystemUnitPath(platform, bootUnitDir), 'utf-8'),
    );
  } catch {
    return false;
  }
}

/** Is the system-domain unit the LEGACY root cell (pre-1.3.1)? Exported for
 *  enable's refusal copy — legacy-root and transitionable drift get
 *  different remedies, and prescribing teardown for drift destroys the
 *  team's control-plane state for a condition `myco service install` fixes. */
export function isLegacyRootHeadscaleUnit(platform: NodeJS.Platform, bootUnitDir?: string): boolean {
  return fs.existsSync(headscaleSystemUnitPath(platform, bootUnitDir))
    && !linuxUserBootCell(platform, bootUnitDir)
    && !bootUnitRunsAsUser(platform, bootUnitDir);
}

/** Read-only classification — the doctor row and the CLI share this. */
export async function classifyHeadscaleScope(
  mycoHome: string,
  options: HeadscaleScopeOptions = {},
): Promise<HeadscaleScopeReport> {
  const platform = options.platform ?? process.platform;
  const config = loadMachineConfig(mycoHome);
  const targetDomain = config.daemon.service_scope === 'boot' ? 'boot' : 'login';
  if (!config.daemon.host_serve.enabled) {
    return { verdict: 'not-serving', observed: 'none', targetDomain };
  }
  const observed = await resolveObservedScope(HEADSCALE_SERVICE_LABEL, {
    platform, loginUnitDir: options.loginUnitDir, bootUnitDir: options.bootUnitDir,
  });
  if (observed === 'both') return { verdict: 'both', observed, targetDomain };
  if (observed === 'none') return { verdict: 'missing', observed, targetDomain };
  // A system-domain unit that is not the invoking-user cell is the legacy
  // root cell — never acceptable at ANY target (its admin socket is
  // root-owned, so every admin call would need the sudo the re-scope
  // removed) and never transitionable (no migration, E1 §3.3 rev 5). On
  // linux a system-domain unit is always the root cell.
  if (observed === 'boot' && isLegacyRootHeadscaleUnit(platform, options.bootUnitDir)) {
    return { verdict: 'legacy-root', observed, targetDomain };
  }
  if (observed === targetDomain) return { verdict: 'converged', observed, targetDomain };
  return { verdict: 'drift', observed, targetDomain };
}

/** The linux boot×invoking-user cell has no system-domain unit at all — its
 *  'boot' observation comes from the user unit's scope marker (or linger). */
function linuxUserBootCell(platform: NodeJS.Platform, bootUnitDir?: string): boolean {
  if (platform !== 'linux') return false;
  return !fs.existsSync(headscaleSystemUnitPath(platform, bootUnitDir));
}

/**
 * Carry the headscale unit to the daemon's scope. CLI-ONLY (sudo may prompt;
 * `transitionServiceScope`'s rollback re-elevates). Called by `myco service
 * install` after the daemon's own install/transition so the two units never
 * end up in different domains. Never throws for the advisory verdicts —
 * serving-off and already-converged are silent; missing/legacy/both print
 * guidance and leave the doctor row to keep nagging.
 */
export async function convergeHeadscaleScope(options: {
  mycoHome: string;
  platform?: NodeJS.Platform;
  log?: (message: string) => void;
}): Promise<HeadscaleScopeReport> {
  const platform = options.platform ?? process.platform;
  const log = options.log ?? ((m: string) => console.log(m));
  const report = await classifyHeadscaleScope(options.mycoHome, { platform });
  switch (report.verdict) {
    case 'not-serving':
    case 'converged':
      return report;
    case 'missing':
      log('NOTE: host serving is enabled but no headscale unit is installed — run `myco host enable` to converge.');
      return report;
    case 'legacy-root':
      log(
        'NOTE: headscale is still supervised as a legacy root service (pre-1.3.1). There is no in-place '
        + 'migration — run `myco host disable` then `myco host enable` to re-supervise it at the current '
        + 'scope (the teardown step needs sudo).',
      );
      return report;
    case 'both':
      log(
        'WARNING: headscale units exist in BOTH supervision domains — two supervisors over one database. '
        + 'Run `myco host disable` (removes both) then `myco host enable`.',
      );
      return report;
    case 'drift':
      break;
  }
  const state = readHostState();
  if (!state?.headscale_bin) {
    log('NOTE: headscale unit found but no host state records its binary — run `myco host disable` then `myco host enable`.');
    return report;
  }
  const layout = headscaleLayout(resolveHostControlDir());
  const targetScope: ServiceScope = { startAt: report.targetDomain, runAs: 'invoking-user' };
  const currentScope: ServiceScope = {
    startAt: report.observed === 'boot' ? 'boot' : 'login',
    runAs: 'invoking-user',
  };
  const spec = buildOverlayServiceSpec({
    label: HEADSCALE_SERVICE_LABEL,
    description: 'Myco Team Host control plane (headscale)',
    executable: state.headscale_bin,
    args: ['serve', '--config', layout.configPath],
    workingDir: layout.stateDir,
    logDir: path.join(layout.stateDir, 'logs'),
    scope: targetScope,
  });
  const from = getScopedServiceManager({ scope: currentScope, platform });
  const fromStatus = await from.status(HEADSCALE_SERVICE_LABEL);
  await transitionServiceScope({
    label: HEADSCALE_SERVICE_LABEL,
    spec,
    from: { manager: from, scope: currentScope, unitPath: fromStatus.unitPath ?? '' },
    to: { manager: getScopedServiceManager({ scope: targetScope, platform }), scope: targetScope },
    runner: boundedServiceRunner,
    platform,
    log,
  });
  log(`headscale followed the daemon to ${report.targetDomain} scope.`);
  return { ...report, verdict: 'converged', observed: report.targetDomain };
}
