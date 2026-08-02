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
 * Team Host's view of the BOOT-scope privileged service mechanics.
 *
 * The mechanics themselves live in `@myco/service/boot-backend.js` (Overlay
 * Coexistence spec §13.6: the privileged installer IS the boot-scope backend
 * behind the scoped facade, not a Team-Host-private parallel path). This
 * module keeps the Team-Host-facing names — `SystemServiceContext`, the
 * overlay spec builder, the headscale label — stable for its callers
 * (`team-host/overlay.ts`) and test seams.
 *
 * `SystemServiceContext.runner` is `team-host`'s `CommandRunner`, which is
 * structurally identical to the service layer's `ServiceCommandRunner` seam —
 * no adapter needed, and the service layer never imports the tailscale
 * provisioning module.
 */
import path from 'node:path';

import type { ServiceSpec } from '@myco/service/types.js';
import type { BootServiceContext } from '@myco/service/boot-backend.js';

export {
  DEFAULT_LAUNCH_DAEMONS_DIR,
  DEFAULT_SYSTEMD_SYSTEM_DIR,
  systemUnitPath,
  isSystemServiceInstalled,
  checkRootAvailable,
  installSystemService,
  uninstallSystemService,
  restartSystemService,
} from '@myco/service/boot-backend.js';

/** Team-Host-facing alias of the boot backend's context. */
export type SystemServiceContext = BootServiceContext;

// ---------------------------------------------------------------------------
// ServiceSpec builder for a supervised overlay binary
// ---------------------------------------------------------------------------

/**
 * Build a {@link ServiceSpec} for an overlay binary supervised as a root
 * service. Distinct from `@myco/service`'s `buildServiceSpec` (which is
 * daemon-self-specific: it hardcodes `args:['daemon']`, MYCO_HOME env, and
 * dev-build guards). This is the generic form for an arbitrary managed
 * binary. `description` is REQUIRED here — these are the only non-daemon
 * units, and without it systemd would report them as "Myco daemon (prod)".
 */
export function buildOverlayServiceSpec(input: {
  label: string;
  executable: string;
  args: string[];
  workingDir: string;
  logDir: string;
  description: string;
  env?: Record<string, string>;
}): ServiceSpec {
  return {
    label: input.label,
    variant: 'prod',
    executable: input.executable,
    args: input.args,
    workingDir: input.workingDir,
    env: input.env ?? {},
    stdoutPath: path.join(input.logDir, `${input.label}.out.log`),
    stderrPath: path.join(input.logDir, `${input.label}.err.log`),
    runAtLoad: true,
    keepAlive: true,
    throttleSeconds: 10,
    scope: { startAt: 'boot', runAs: 'root' },
    description: input.description,
  };
}

/** Stable label for the supervised headscale control plane. */
export const HEADSCALE_SERVICE_LABEL = 'co.goondocks.myco-headscale';
