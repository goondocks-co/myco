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

import {
  resolveMycoHome,
  resolveServiceDir,
} from '../grove/paths.js';
import { waitForProcessExit } from '@goondocks/myco-shared';

const WINDOWS_TERMINATION_CONFIRM_TIMEOUT_MS = 10_000;
const WINDOWS_TERMINATION_CONFIRM_POLL_MS = 100;

export interface DaemonTerminationDeps {
  platform?: NodeJS.Platform;
  withExternalMcpContainment?: <T>(continuation: () => Promise<T>) => Promise<T>;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  confirmTermination?: (pid: number) => Promise<void>;
}

export class DaemonTerminationUnconfirmedError extends Error {
  constructor(pid: number) {
    super(`Daemon process ${pid} remained alive after hard termination`);
    this.name = 'DaemonTerminationUnconfirmedError';
  }
}

async function confirmWindowsTermination(pid: number): Promise<void> {
  if (pid === process.pid) return;
  if (await waitForProcessExit(
    pid,
    WINDOWS_TERMINATION_CONFIRM_TIMEOUT_MS,
    WINDOWS_TERMINATION_CONFIRM_POLL_MS,
  )) {
    return;
  }
  throw new DaemonTerminationUnconfirmedError(pid);
}

/**
 * Confirm persistent external MCP exposure is retired before an uncatchable
 * Windows process termination.
 */
export async function containExternalMcpBeforeHardKill(
  mycoHome: string = resolveMycoHome(),
): Promise<void> {
  await withExternalMcpContainment(async () => {}, mycoHome);
}

export async function withExternalMcpContainment<T>(
  continuation: () => Promise<T>,
  mycoHome: string = resolveMycoHome(),
): Promise<T> {
  const [
    { ExternalMcpContainmentAuthority },
    { defaultFunnelOffRunner },
    { teamFunnelContainmentSockets },
  ] = await Promise.all([
    import('../daemon/external-mcp-containment.js'),
    import('../daemon/external-listener.js'),
    import('../team-host/funnel.js'),
  ]);
  const authority = new ExternalMcpContainmentAuthority({
    mycoHome,
    stateDir: resolveServiceDir(mycoHome),
    listener: {
      isBound: false,
      boundTarget: null,
      async unbind() {},
      async bind() {
        return { ok: false, error: 'the termination authority never activates' };
      },
    },
    runFunnelOff: defaultFunnelOffRunner,
    // A host that is going down must stop answering its public URL, exactly as
    // external MCP does — `shutdown` quiesces serving without disavowing the
    // config, so the next boot republishes.
    additionalFunnelSockets: () => teamFunnelContainmentSockets({ mycoHome, intent: 'quiesce' }),
  });
  return await authority.containWhile('shutdown', async () => await continuation());
}

/** Prepare a platform termination without delivering a signal. */
export async function prepareDaemonTermination(
  deps: DaemonTerminationDeps = {},
): Promise<void> {
  if ((deps.platform ?? process.platform) !== 'win32') return;
  await (deps.withExternalMcpContainment ?? withExternalMcpContainment)(
    async () => {},
  );
}

/**
 * Terminate a daemon process. Windows signals are hard kills, so containment
 * must succeed before either SIGTERM or SIGKILL reaches the process.
 */
export async function terminateDaemonProcess(
  pid: number,
  signal: NodeJS.Signals,
  deps: DaemonTerminationDeps = {},
): Promise<void> {
  const terminate = async () => {
    (deps.kill ?? ((targetPid, targetSignal) => {
      process.kill(targetPid, targetSignal);
    }))(pid, signal);
    if ((deps.platform ?? process.platform) === 'win32') {
      await (deps.confirmTermination ?? confirmWindowsTermination)(pid);
    }
  };
  if ((deps.platform ?? process.platform) !== 'win32') {
    await terminate();
    return;
  }
  await (deps.withExternalMcpContainment ?? withExternalMcpContainment)(terminate);
}
