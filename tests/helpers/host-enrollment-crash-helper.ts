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

const [teamHome, hostId, boundary, label, bearer] = process.argv.slice(2);
if (!teamHome || !hostId || !boundary || !label || !bearer) process.exit(64);
process.env.MYCO_TEAM_HOME = teamHome;

const originalRename = fs.renameSync.bind(fs);
fs.renameSync = ((source: fs.PathLike, destination: fs.PathLike): void => {
  originalRename(source, destination);
  const sourcePath = String(source);
  const destinationPath = String(destination);
  const destinationName = path.basename(destinationPath);
  const sourceName = path.basename(sourcePath);
  const matches = boundary === 'ledger' && destinationPath.includes('/host-generations/')
    || boundary === 'claim' && destinationName === 'proxy-port-claim.json'
    || boundary === 'intent' && destinationName === 'enrollment-intent.json'
    || (boundary === 'bearer' || boundary === 'pause_bearer')
      && destinationPath.includes('/bearers/')
    || boundary === 'pointer' && destinationName === 'host.json'
    || boundary === 'intent_cleanup'
      && sourceName === 'enrollment-intent.json'
      && destinationName.startsWith('.myco-remove-')
    || boundary === 'claim_cleanup'
      && sourceName === 'proxy-port-claim.json'
      && destinationName.startsWith('.myco-remove-');
  if (matches) {
    if (boundary === 'pause_bearer') process.kill(process.pid, 'SIGSTOP');
    else process.exit(86);
  }
}) as typeof fs.renameSync;

const {
  advanceHostEnrollmentPhase,
  persistEnrollmentMembership,
  reserveHostProxyPort,
} = await import('@myco/host/registry.js');

const reservation = reserveHostProxyPort(hostId);
advanceHostEnrollmentPhase(reservation, 'enrolling');
persistEnrollmentMembership(
  {
    host_id: hostId,
    label,
    overlay_address: '100.64.0.1:7433',
    protocol_version: HOST_PROTOCOL_VERSION,
    created_at: '2026-07-24T00:00:00.000Z',
  },
  bearer,
  reservation,
);
