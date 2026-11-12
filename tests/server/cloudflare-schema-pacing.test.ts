import { expect, it } from 'bun:test';
import fs from 'node:fs';
import { Database } from 'bun:sqlite';
import { SERVER_SCHEMA_VERSION } from '@myco-server-worker/constants.js';
import { deploymentRecordPath, readDeploymentRecord, writeDeploymentRecord } from '@myco/server/cloudflare.js';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { migrationFileName } from '@myco-server-worker/db/migrate.js';
import { D1_OVERLOAD_RETRIES } from '@myco/server/cloudflare-migration-pacing.js';
import { BOOKMARK, OLD_WORKER, fixture } from './fixtures/cloudflare-schema-update.js';

const T = SERVER_SCHEMA_VERSION;
const liveVersion = (root: string) => {
  const db = new Database(`${root}/schema.sqlite`, { readonly: true });
  try { return Number((db.query("SELECT value FROM schema_meta WHERE key='version'").get() as { value: string }).value); }
  finally { db.close(); }
};

it('waits out an overloaded D1 between migration applies and completes the update without a rerun', async () => {
  await fixture({ schema: String(T - 4), liveSchema: true, overloadAt: [{ at: T - 2, reads: 1 }, { at: T - 1 }] }, async ({ root, home, update, reports }) => {
    const { summary, versionId } = await update();
    expect(summary).toMatchObject({ schema: 'applied', worker: 'applied', record: 'updated', schemaBefore: T - 4 });
    expect(versionId).toBe('22222222-2222-4333-8444-555555555555');
    expect(liveVersion(root)).toBe(T);
    expect(readDeploymentRecord(home)!.versionId).toBe(versionId);
    expect(readDeploymentRecord(home)!.schemaUpdates!.at(-1)).toMatchObject({ schemaBefore: T - 4, schemaAfter: T, appliedAt: expect.any(String) });
    const text = reports.join('\n');
    expect(text).toContain(`schema ${T - 3} of ${T}`);
    expect(text).toContain(`schema ${T - 2} of ${T}`);
    expect(text).toContain('reading the live schema');
    expect(text).not.toContain('Schema update stopped');
  });
});

it('stops a D1 that stays overloaded with the live schema, the Worker left serving and the next command', async () => {
  await fixture({ schema: String(T - 3), liveSchema: true, applyOverloads: D1_OVERLOAD_RETRIES + 1 }, async ({ root, home, update, calls, reports, waits }) => {
    await expect(update()).rejects.toThrow('stayed overloaded (code 7429)');
    expect(waits).toHaveLength(D1_OVERLOAD_RETRIES);
    expect(calls().some(({ args }) => args[0] === 'deploy')).toBe(false);
    expect(liveVersion(root)).toBe(T - 3);
    expect(readDeploymentRecord(home)!.versionId).toBe(OLD_WORKER);
    const text = reports.join('\n');
    expect(text).toContain(`Schema: stopped: D1 overloaded (target ${T}; live schema ${T - 3})`);
    expect(text).toContain('Worker: not attempted');
    expect(text).toContain(`Live schema ${T - 3} of ${T}`);
    expect(text).toContain(`The Worker was left on its old release`); expect(text).toContain(`version ${OLD_WORKER}`);
    expect(text).toContain('Next: wait a few minutes for D1\'s load to settle, then run: myco server update --target cloudflare');
    expect(text).not.toContain('outcome unknown'); expect(text).toContain(`It serves schema ${T - 3}, which is the live schema, so it keeps serving.`);
  });
});

it('names a migration that fails twice on an answering D1 and says the old Worker refuses the live schema', async () => {
  await fixture({ schema: String(T - 3), liveSchema: true, overloadAt: [{ at: T - 1 }, { at: T - 1 }, { at: T - 1 }] }, async ({ root, home, update, calls, reports, waits }) => {
    const file = migrationFileName(SCHEMA_STEPS.find((step) => step.version === T - 1)!);
    await expect(update()).rejects.toThrow(`migration ${file} failed twice`);
    expect(waits.length).toBeLessThan(D1_OVERLOAD_RETRIES);
    expect(calls().some(({ args }) => args[0] === 'deploy')).toBe(false);
    expect(liveVersion(root)).toBe(T - 2);
    expect(readDeploymentRecord(home)!.versionId).toBe(OLD_WORKER);
    const text = reports.join('\n');
    expect(text).toContain(`Schema: stopped: a migration exceeds D1 limits (target ${T}; live schema ${T - 2})`);
    expect(text).toContain(`Schema update stopped: migration ${file} failed twice`);
    expect(text).toContain(`It serves schema ${T - 3} only, so it refuses requests while the live schema is ${T - 2}.`);
    expect(text).toContain(`Next: a rerun stops at ${file} again.`); expect(text).toContain(`To put the database back on schema ${T - 3}, which the old Worker serves, restore bookmark ${BOOKMARK}`);
    expect(text).toContain(`wrangler d1 time-travel restore 'myco-server' --bookmark=${BOOKMARK}`);
  });
});

it('after two stopped updates against one Worker, recommends the bookmark at the schema that Worker serves', async () => {
  const second = '00000086-0000024c-00004c6d-8e61117bf38d7adb71b934ebbf891683';
  const repeated = Array.from({ length: 5 }, () => ({ at: T - 1 }));
  await fixture({ schema: String(T - 3), liveSchema: true, overloadAt: repeated }, async ({ home, state, update, reports }) => {
    const file = migrationFileName(SCHEMA_STEPS.find((step) => step.version === T - 1)!);
    await expect(update()).rejects.toThrow(`migration ${file} failed twice`);
    const saved = JSON.parse(fs.readFileSync(state, 'utf8'));
    fs.writeFileSync(state, JSON.stringify({ ...saved, schema: String(T - 2), expectedBookmark: second, bookmarkOutput: JSON.stringify({ bookmark: second }) }));
    const firstRun = reports.length;
    await expect(update()).rejects.toThrow(`migration ${file} failed twice`);
    expect(readDeploymentRecord(home)!.schemaUpdates).toMatchObject([
      { bookmark: BOOKMARK, schemaBefore: T - 3, workerVersionBefore: OLD_WORKER },
      { bookmark: second, schemaBefore: T - 2, workerVersionBefore: OLD_WORKER },
    ]);
    const text = reports.slice(firstRun).join('\n');
    expect(text).toContain(`It serves schema ${T - 3} only, so it refuses requests while the live schema is ${T - 2}.`);
    expect(text).toContain(`To put the database back on schema ${T - 3}, which the old Worker serves, restore bookmark ${BOOKMARK}`);
    expect(text).toContain(`This update's own recovery point, bookmark ${second}, returns the database to schema ${T - 2}, which the old Worker does not serve`);
    expect(text).not.toContain(`schema ${T - 3}, which the old Worker serves, restore bookmark ${second}`);
  });
});

it('claims nothing about the old Worker when the record does not show which schema it serves', async () => {
  await fixture({ schema: String(T - 3), workerBefore: null, liveSchema: true, overloadAt: [{ at: T - 2 }, { at: T - 2 }, { at: T - 2 }] }, async ({ root, home, update, reports }) => {
    writeDeploymentRecord({ ...readDeploymentRecord(home)!, versionId: null }, home);
    const file = migrationFileName(SCHEMA_STEPS.find((step) => step.version === T - 2)!);
    await expect(update()).rejects.toThrow(`migration ${file} failed twice`);
    expect(liveVersion(root)).toBe(T - 3);
    const text = reports.join('\n');
    expect(text).toContain(`returns the database to schema ${T - 3}; whether the old Worker serves it is not recorded`);
    expect(text).not.toContain('which the old Worker does not serve');
  });
});

it('settles a failure other than overload once, as before, without waiting', async () => {
  await fixture({ schema: String(T - 3), liveSchema: true, migrationExit: 1, migrationError: 'internal error [code: 7500]' }, async ({ update, calls, reports, waits }) => {
    await expect(update()).rejects.toThrow('internal error [code: 7500]');
    expect(waits).toEqual([]);
    const text = reports.join('\n');
    expect(text).toContain(`Schema: failed: not applied (target ${T}; live schema ${T - 3})`);
    expect(text).not.toContain('Schema update stopped');
    expect(text).not.toContain('overloaded');
  });
});

it('refuses to start on a D1 already overloaded, changing nothing', async () => {
  await fixture({ schema: String(T - 3), liveSchema: true, readOverloads: 1 }, async ({ home, update, calls, reports, waits }) => {
    const before = fs.readFileSync(deploymentRecordPath(home), 'utf8');
    await expect(update()).rejects.toThrow('overloaded (code 7429) before the update started; nothing was changed');
    expect(waits).toEqual([]);
    expect(fs.readFileSync(deploymentRecordPath(home), 'utf8')).toBe(before);
    expect(calls().some(({ args }) => args.includes('time-travel') || args.includes('migrations') || args[0] === 'deploy')).toBe(false);
    expect(reports.join('\n')).toContain('Nothing changed in Cloudflare; a rerun is safe');
  });
});
