/** Compiled production runner verbs with a file-backed service-manager fixture. */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { run } from '@myco/cli/runner.js';
import { setPluginVersion } from '@myco/version.js';
import { installService, uninstallService, startService, statusOfService, stopService } from '@myco/server/service.js';
import { recordingPlatform } from '../../helpers/fake-service-manager.js';

declare const MYCO_UPDATE_FIXTURE_VERSION: string;
setPluginVersion(MYCO_UPDATE_FIXTURE_VERSION);
if (process.argv[2] === '--version') {
  console.log(MYCO_UPDATE_FIXTURE_VERSION);
} else {
  const home = process.env.MYCO_HOME!;
  const cwd = process.cwd();
  const stateFile = path.join(home, 'fixture-service-state.json');
  const platform = recordingPlatform();
  if (fs.existsSync(stateFile)) {
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as { loaded: string[]; running: string[] };
    state.loaded.forEach(label => platform.loaded.add(label));
    state.running.forEach(label => platform.running.add(label));
  }
  const save = () => {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ loaded: [...platform.loaded], running: [...platform.running], commands: platform.commands }));
  };
  const pidFile = path.join(home, 'fixture-pids');
  const notePid = (pid: number | undefined) => { if (pid !== undefined) fs.appendFileSync(pidFile, `${pid}\n`); };
  const binaryPath = process.env.MYCO_UPDATE_FIXTURE_BINARY!;
  const stopped = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => stopped.abort());
  const timeout = setTimeout(() => stopped.abort(), 4000);
  const originalFetch = globalThis.fetch;
  const serverUrl = process.env.MYCO_UPDATE_FIXTURE_SERVER!;
  const ok = await run(process.argv.slice(3), {
    mycoHome: home, home: process.env.HOME!, platform: 'darwin', binaryPath,
    runner: platform.runner, lockDir: path.join(home, 'locks'), ownDeploymentUrls: async () => [],
    detect: () => [], harnessDirs: () => [], signal: stopped.signal, sleep: async () => {},
    machineId: 'fixture-machine', hostname: () => 'mini',
    update: {
      installGuardian: spec => { const outcome = installService(spec, { platform: 'darwin', runner: platform.runner }); save(); return outcome; },
      removeGuardian: spec => { uninstallService(spec, { platform: 'darwin', runner: platform.runner }); save(); },
      fetch: ((input: RequestInfo | URL, init?: RequestInit) => originalFetch(`${serverUrl}/releases${new URL(String(input)).search}`, init)) as unknown as typeof fetch,
      spawnHelper: async (binary, statePath) => {
        save();
        await new Promise<void>((resolve, reject) => {
          const child = spawn(binary, ['runner', '__apply-update', statePath], { cwd, env: process.env, detached: true, stdio: 'ignore' });
          notePid(child.pid);
          child.once('error', reject);
          child.once('spawn', () => { child.unref(); resolve(); });
        });
      },
    },
    updateHelper: {
      removeGuardian: spec => { uninstallService(spec, { platform: 'darwin', runner: platform.runner }); save(); },
      stop: spec => { stopService(spec, { platform: 'darwin', runner: platform.runner }); save(); },
      stopped: spec => !statusOfService(spec, { platform: 'darwin', runner: platform.runner }).running,
      start: spec => {
        const result = startService(spec, { platform: 'darwin', runner: platform.runner });
        save();
        const child = spawn(binaryPath, ['runner', 'run', '--server', serverUrl], { cwd, env: process.env, stdio: 'ignore' });
        notePid(child.pid); child.unref();
        return result;
      },
    },
  });
  clearTimeout(timeout);
  save();
  process.exitCode = ok ? 0 : 1;
}
