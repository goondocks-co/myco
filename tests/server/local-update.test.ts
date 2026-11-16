import { expect, it } from 'bun:test';
import { run } from '@myco/cli/server.js';
import { Database } from 'bun:sqlite';
import { SERVER_SCHEMA_VERSION } from '@myco-server-worker/constants.js';
import { installService, servicePaths } from '@myco/server/service.js';
import { updateLocalService } from '@myco/server/local-update.js';
import { LocalVolume } from '@myco/server/local-volume.js';
import { startLocalService } from '@myco/server/local-lifecycle.js';
import { fixture, installLocalLifecycle } from './fixtures/local-lifecycle.js';
installLocalLifecycle();

it('admits a native update before stopping and proves serving after completion', async () => {
  const f = fixture();
  installService(f.spec, f.deps.service);
  const backup = new LocalVolume(f.paths).reading(async () => {
    await expect(updateLocalService(f.home, f.deps)).rejects.toThrow('refused before stopping');
    expect(f.platform.running.has(f.spec.unit.label)).toBe(true);
  });
  await backup;
  const sqlite = new Database(f.paths.databasePath);
  try {
    sqlite.query("UPDATE schema_meta SET value = '101' WHERE key = 'version'").run();
    await expect(updateLocalService(f.home, f.deps)).rejects.toThrow('thin_learning_stepping_stone_required');
    expect(f.platform.running.has(f.spec.unit.label)).toBe(true);
  } finally {
    sqlite.query("UPDATE schema_meta SET value = ? WHERE key = 'version'").run(String(SERVER_SCHEMA_VERSION));
    sqlite.close();
  }
  const selectedHome = process.env.MYCO_HOME;
  try {
    process.env.MYCO_HOME = f.home;
    await run(['update', '--target', 'local'], { local: f.deps });
    await run(['install', '--target', 'local'], { local: f.deps });
    expect(f.platform.running.has(f.spec.unit.label)).toBe(true);
  } finally {
    if (selectedHome === undefined) delete process.env.MYCO_HOME;
    else process.env.MYCO_HOME = selectedHome;
  }
});

it('restores the previous service after a migration failure leaves its schema unchanged', async () => {
  const f = fixture();
  const sqlite = new Database(f.paths.databasePath);
  sqlite.exec('PRAGMA journal_mode = WAL');
  sqlite.query("UPDATE schema_meta SET value = ? WHERE key = 'version'").run(String(SERVER_SCHEMA_VERSION - 1));
  sqlite.exec('BEGIN IMMEDIATE');
  try {
    installService(f.spec, f.deps.service);
    await expect(updateLocalService(f.home, f.deps)).rejects.toThrow('the previous service is answering again');
    expect(f.platform.running.has(f.spec.unit.label)).toBe(true);
  } finally { sqlite.exec('ROLLBACK'); sqlite.close(); }
});

it('waits for the listener owned by the service and names registration separately', async () => {
  const f = fixture();
  const messages: string[] = [];
  let clock = 0;
  const deps = { ...f.deps, log: (line: string) => messages.push(line), now: () => clock, sleep: async (ms: number) => { clock += ms; },
    fetchImpl: Object.assign(async () => new Response('', { status: 503 }), { preconnect() {} }) };
  await expect(startLocalService(f.spec, 'http://127.0.0.1:8787', deps, 'install')).rejects.toThrow('did not answer');
  expect(messages).toContain('Deployment service registered; waiting for its listener.');
  await startLocalService(f.spec, 'http://127.0.0.1:8787', f.deps);
  const runner = f.platform.runner;
  await expect(startLocalService(f.spec, 'http://127.0.0.1:8787', { ...deps, fetchImpl: f.deps.fetchImpl,
    service: { platform: 'darwin', runner: (command, args) => {
      const result = runner(command, args);
      return { ...result, stdout: result.stdout?.replace(String(process.pid), '4242') };
    } },
  })).rejects.toThrow('did not answer');
}, 60_000);

it('names forward recovery when a stopped update has advanced the schema', async () => {
  const f = fixture();
  installService(f.spec, f.deps.service);
  const runner = f.platform.runner;
  await expect(updateLocalService(f.home, { ...f.deps, service: { platform: 'darwin', runner: (command, args) => {
    const result = runner(command, args);
    if (args[0] === 'unload') {
      const sqlite = new Database(f.paths.databasePath);
      try { sqlite.query("UPDATE schema_meta SET value = ? WHERE key = 'version'").run(String(SERVER_SCHEMA_VERSION + 1)); }
      finally { sqlite.close(); }
      throw new Error('update interrupted');
    }
    return result;
  } } })).rejects.toThrow('schema advanced');
  expect(f.platform.running.has(f.spec.unit.label)).toBe(false);
});

it('reports a completed schema update and an unanswered service without suggesting data recovery', async () => {
  const f = fixture();
  const sqlite = new Database(f.paths.databasePath);
  try { sqlite.query("UPDATE schema_meta SET value = ? WHERE key = 'version'").run(String(SERVER_SCHEMA_VERSION - 1)); }
  finally { sqlite.close(); }
  installService(f.spec, f.deps.service);
  let clock = 0;
  const failure = await updateLocalService(f.home, { ...f.deps,
    now: () => clock, sleep: async ms => { clock += ms; },
    fetchImpl: Object.assign(async () => new Response('', { status: 503 }), { preconnect() {} }),
  }).catch(error => error);
  expect(failure.message).toContain(`schema updated to ${SERVER_SCHEMA_VERSION}; the service did not answer`);
  expect(failure.message).toContain(servicePaths(f.spec, 'darwin').errLog);
  expect(failure.message).toContain('myco server status --target local, then myco server install --target local');
  expect(failure.message).not.toContain('restore');
  expect(failure.message).not.toContain('artifact');
});
