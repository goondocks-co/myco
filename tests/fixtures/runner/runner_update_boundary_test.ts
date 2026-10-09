import { expect, it } from 'bun:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRunnerUpdateController, readRunnerUpdateState, withRunnerUpdateState, strictRunnerReleaseProbe } from '@myco/runner/update.js';
import { run as runner } from '@myco/cli/runner.js';
import { writeInstallMarker } from '@myco/install/managed-binary.js';
import { installService, uninstallService, startService, statusOfService, stopService } from '@myco/server/service.js';
import { installWorkerService, workerServiceSpec } from '@myco/runner/service.js';
import { recordingPlatform } from '../../helpers/fake-service-manager.js';

it('runner update and rollback require the service-manager stub', async () => {
  const home = process.env.MYCO_HOME!, serverUrl = 'https://update-boundary.invalid';
  const binaryPath = path.join(home, 'bin', 'myco');
  const source = path.join(home, 'release');
  fs.mkdirSync(path.dirname(binaryPath), { recursive: true });
  fs.writeFileSync(binaryPath, '#!/bin/sh\nprintf "2.0.0-alpha.2\\n"\n', { mode: 0o755 });
  fs.writeFileSync(source, '#!/bin/sh\nprintf "2.0.0-alpha.3\\n"\n', { mode: 0o755 });
  writeInstallMarker(home, { bin: binaryPath, channel: 'alpha', source: 'curl' });
  const spec = workerServiceSpec({ serverUrl, binaryPath, mycoHome: home, home: process.env.HOME!, platform: 'darwin', executor: 'runner' }, []);
  const platform = recordingPlatform();
  const stub = process.env.MYCO_RUNNER_SERVICE_STUB === '1' ? platform.runner : undefined;
  const guardian = process.env.MYCO_RUNNER_UPDATE_GUARDIAN === '1';
  installWorkerService({ serverUrl, binaryPath, mycoHome: home, home: process.env.HOME!, platform: 'darwin', executor: 'runner' }, [], { runner: platform.runner });
  const asset = 'myco-darwin-arm64';
  const sum = crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex');
  const controller = createRunnerUpdateController({ home, serverUrl, binaryPath, currentVersion: '2.0.0-alpha.2', platform: 'darwin', serviceSpec: spec, log: () => {}, deps: {
    installGuardian: guardian ? spec => installService(spec, { platform: 'darwin', runner: stub }) : () => ({ unitFile: 'fixture', loaded: true, running: true, changed: true }),
    removeGuardian: guardian ? spec => { uninstallService(spec, { platform: 'darwin', runner: stub }); } : () => {},
    serviceInstalled: () => true, targetTriple: () => 'darwin-arm64', spawnHelper: async () => {},
    fetch: (async () => Response.json([{ tag_name: 'myco/v2.0.0-alpha.3', prerelease: true, assets: [
      { name: asset, browser_download_url: 'http://fixture.invalid/binary' }, { name: 'SHA256SUMS', browser_download_url: 'http://fixture.invalid/sums' },
    ] }])) as unknown as typeof fetch,
    stageDeps: { download: async (url, dest) => { if (url.endsWith('/binary')) fs.copyFileSync(source, dest); else fs.writeFileSync(dest, `${sum}  ${asset}\n`); },
      computeSha256: async file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') },
    probe: (file, version) => strictRunnerReleaseProbe(file, version, 'linux'),
  } });
  expect(await controller.idle()).toBe('restart');
  const rollback = process.env.MYCO_RUNNER_UPDATE_ROLLBACK === '1';
  let starts = 0;
  expect(await runner(['__apply-update', path.join(home, 'runner', 'update.json')], { updateHelper: {
    removeGuardian: () => {},
    alive: () => false, wait: async () => {}, now: (() => { let tick = 0; return () => tick += 1000; })(),
    probe: (file, version) => strictRunnerReleaseProbe(file, version, 'linux'),
    stop: spec => stopService(spec, { platform: 'darwin', runner: stub }),
    stopped: spec => !statusOfService(spec, { platform: 'darwin', runner: stub }).running,
    start: spec => {
      const result = startService(spec, { platform: 'darwin', runner: stub });
      if (rollback && ++starts === 1) return { ...result, running: false };
      if (!rollback) withRunnerUpdateState(home, state => { if (state.transaction) state.transaction.phase = 'healthy'; });
      return result;
    },
  } })).toBe(true);
  expect(readRunnerUpdateState(home).lastResults?.[serverUrl]?.result).toBe(rollback ? 'rolled_back' : 'updated');
});
