/*
 * Copyright 2026 Myco Contributors
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
import fs from 'node:fs';
import path from 'node:path';

import { HOST_PROTOCOL_VERSION } from '@myco/constants.js';
import {
  joinHost,
  leaveHost,
  type EnrollmentClient,
  type MemberOverlayDeps,
} from '@myco/host/member-overlay.js';
import { TAILSCALE_VERSION, type CommandRunner } from '@myco/host/overlay-binaries.js';
import { FakeServiceManager } from './fake-service-manager.js';

const [teamHome, hostId, mode, readyPath, releasePath, resultPath, preferredPortRaw] = process.argv.slice(2);
if (!teamHome || !hostId || !mode || !readyPath || !releasePath || !resultPath) {
  process.stderr.write('host join proxy reservation helper: required args missing\n');
  process.exit(64);
}

process.env.MYCO_TEAM_HOME = teamHome;
process.env.HOME = teamHome;
const brewDir = path.join(teamHome, 'brew');
fs.mkdirSync(brewDir, { recursive: true });
fs.writeFileSync(path.join(brewDir, 'tailscale'), 'tailscale\n', { mode: 0o755 });
fs.writeFileSync(path.join(brewDir, 'tailscaled'), 'tailscaled\n', { mode: 0o755 });

const runner: CommandRunner = {
  async run(command, args) {
    if (command === 'brew' && args[0] === 'list') {
      return { stdout: 'tailscale\n', exitCode: 0 };
    }
    if (args.length === 1 && args[0] === 'version') {
      return { stdout: `${TAILSCALE_VERSION}\n`, exitCode: 0 };
    }
    return { stdout: '', exitCode: 0 };
  },
};

const enrollmentClient: EnrollmentClient = {
  async enroll(context) {
    fs.writeFileSync(readyPath, JSON.stringify({ proxyPort: context.proxyPort }));
    if (mode === 'crash') process.exit(86);
    while (!fs.existsSync(releasePath)) await Bun.sleep(10);
    return {
      host_id: hostId,
      label: hostId,
      overlay_address: '100.64.0.1:7433',
      protocol_version: HOST_PROTOCOL_VERSION,
      bearer: `bearer-${hostId}`,
    };
  },
};

const serviceManager = new FakeServiceManager();
const deps: MemberOverlayDeps = {
  platform: 'darwin',
  arch: 'arm64',
  runner,
  serviceManager,
  brewBinDirs: [brewDir],
  waitForSocket: async () => mode !== 'handled-failure',
  resolveMemberOverlayIp: async () => '100.64.0.5',
  checkHostReachable: async () => true,
  enrollmentClient,
  logger: () => {},
  proxyPort: preferredPortRaw ? Number(preferredPortRaw) : undefined,
};

try {
  const result = mode === 'leave'
    ? await leaveHost(hostId, deps)
    : await joinHost(
      { hostRef: hostId, key: 'one-time-key', serverUrl: 'https://host:8080' },
      deps,
    );
  fs.writeFileSync(resultPath, JSON.stringify({
    ok: true,
    result,
    uninstallCalls: serviceManager.uninstallCalls,
  }));
} catch (error) {
  fs.writeFileSync(resultPath, JSON.stringify({
    ok: false,
    message: error instanceof Error ? error.message : String(error),
    uninstallCalls: serviceManager.uninstallCalls,
  }));
  process.exitCode = 1;
}
