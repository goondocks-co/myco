import { expect, it, spyOn } from 'bun:test';
import { Database, type SQLQueryBindings, type Statement } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recoveryBundleInventory, RECOVERY_LOCATOR_PAGE_ROWS } from '@myco/server/recovery-bundle-inventory.js';
import { verifyCopiedBundleEntries } from '@myco/server/recovery-bundle.js';
import { ingestEvent } from '@myco-server-worker/ingest/events.js';
import { registeredObjectKeySql } from '@myco-server-worker/core/blob-objects.js';
import { sqliteEnv, envelope, uuid } from '../myco-server/helpers/fixtures.js';
import { seedCredential } from '../myco-server/helpers/d1.js';

const HISTORY_ROWS = 12_000;
const BUNDLES = 12;
type Observation = { sql: string; params: unknown[]; rows: number; plans: string[] };

function observeReads(db: Database) {
  const calls: Observation[] = [];
  const prepare = db.prepare.bind(db), query = db.query.bind(db);
  const observed = new WeakSet<object>();
  const restores: Array<() => void> = [];
  function observe<R, P extends SQLQueryBindings[]>(statement: Statement<R, P>, sql: string) {
    if (!observed.has(statement) && /\bFROM (events|tool_calls|temp\.recovery_bundle_locator_inventory)\b/.test(sql)) {
      observed.add(statement);
      const all = statement.all.bind(statement);
      const observedAll = spyOn(statement, 'all').mockImplementation((...params) => {
        const rows = all(...params);
        const explain = prepare<{ detail: string }, P>(`EXPLAIN QUERY PLAN ${sql}`);
        let plans: string[];
        try { plans = explain.all(...params).map(plan => plan.detail); }
        finally { explain.finalize(); }
        calls.push({ sql, params, rows: rows.length, plans });
        return rows;
      });
      restores.push(() => observedAll.mockRestore());
    }
    return statement;
  }
  const p = spyOn(db, 'prepare').mockImplementation(<R, P extends SQLQueryBindings | SQLQueryBindings[]>(sql: string, params?: P) =>
    observe(prepare<R, P>(sql, params), sql));
  const q = spyOn(db, 'query').mockImplementation(<R, P extends SQLQueryBindings | SQLQueryBindings[]>(sql: string) =>
    observe(query<R, P>(sql), sql));
  return { calls, stop() { p.mockRestore(); q.mockRestore(); for (const restore of restores) restore(); } };
}

it('operator recovery examines each historical identity once and searches its temporary locator index', async () => {
  const f = sqliteEnv();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-recovery-locator-'));
  let snapshot: Database | undefined;
  try {
    const now = Date.now(), token = seedCredential(f.sqlite, { expiresAt: now + 60_000 });
    for (let i = 0; i < BUNDLES; i += 1) {
      expect(await ingestEvent(f.db, { projectId: 'proj_1', machineId: 'm', tokenId: token, bodyBytes: 0, now },
        envelope({ eventId: uuid(i+1), sessionId: 'sess_inventory', kind: 'tool.use',
          payload: { toolCallId: uuid(i+100), toolName: 'Write', input: 'exact input '.repeat(300), success: true } }),
        f.serverEnv)).toMatchObject({ persisted: true, projected: true });
    }
    f.sqlite.exec(`INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at)
      VALUES('proj_1','sess_history','m','t',0,0)`);
    const event = f.sqlite.prepare(`INSERT INTO events(project_id,event_id,session_id,token_id,kind,channel,payload,
      envelope_hash,created_at,received_at,payload_bytes) VALUES('proj_1',?,'sess_history','t','response','cli','{}',?,0,0,2)`);
    const tool = f.sqlite.prepare(`INSERT INTO tool_calls(project_id,tool_call_id,session_id,event_id,tool_name,input,
      success,created_at,token_id,received_at) VALUES('proj_1',?,'sess_history',?,'Read','{}',1,0,'t',0)`);
    try { f.sqlite.transaction(() => {
      for (let i = 0; i < HISTORY_ROWS; i += 1) {
        event.run(uuid(10_000+i), '0'.repeat(64)); tool.run(uuid(30_000+i), uuid(10_000+i));
      }
    })(); } finally { event.finalize(); tool.finalize(); }
    const file = path.join(dir, 'snapshot.sqlite'); fs.writeFileSync(file, f.sqlite.serialize());
    snapshot = new Database(file, { readonly: true });
    const before = fs.readFileSync(file);
    const reads = observeReads(snapshot);
    const sourceKey = (key: string) => {
      const [project, digest] = key.split('/');
      return (f.sqlite.query(`SELECT ${registeredObjectKeySql('?', '?')} AS key`).get(project!, digest!) as { key: string }).key;
    };
    try {
      await verifyCopiedBundleEntries(snapshot, { ...f.bucket,
        head: key => f.bucket.head(sourceKey(key)), get: (key, options) => f.bucket.get(sourceKey(key), options) });
    } finally { reads.stop(); }
    for (const table of ['events','tool_calls']) {
      const pages = reads.calls.filter(call => new RegExp(`FROM ${table}\\b`).test(call.sql));
      expect(pages.reduce((sum, call) => sum+call.rows, 0)).toBe(HISTORY_ROWS+BUNDLES);
      expect(pages).toHaveLength(Math.ceil((HISTORY_ROWS+BUNDLES)/RECOVERY_LOCATOR_PAGE_ROWS)+1);
      for (const page of pages) {
        expect(page.rows).toBeLessThanOrEqual(RECOVERY_LOCATOR_PAGE_ROWS);
        expect(page.sql).toContain('WHERE (project_id,');
        expect(page.plans.some(plan => plan.startsWith(`SEARCH ${table} USING INDEX`) && plan.includes('>'))).toBe(true);
      }
    }
    const lookups = reads.calls.filter(call => call.sql.includes('FROM temp.recovery_bundle_locator_inventory'));
    expect(lookups).toHaveLength(BUNDLES);
    for (const lookup of lookups) {
      expect(lookup.rows).toBe(1);
      expect(lookup.plans.some(plan => plan.includes('SEARCH temp.recovery_bundle_locator_inventory USING PRIMARY KEY (project_id=? AND bundle_id=?)'))).toBe(true);
    }
    expect(snapshot.query("SELECT name FROM sqlite_temp_master WHERE type='table'").all()).toEqual([]);
    expect(fs.readFileSync(file)).toEqual(before);
  } finally { snapshot?.close(); f.sqlite.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

it('the recovery inventory refuses dangling locators and releases its temporary state on failure', () => {
  const f = sqliteEnv();
  try {
    f.sqlite.exec(`INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at)
      VALUES('proj_1','sess_dangling','m','t',0,0)`);
    f.sqlite.prepare(`INSERT INTO events(project_id,event_id,session_id,token_id,kind,channel,payload,envelope_hash,
      created_at,received_at,payload_bytes,bundle_id,bundle_entry) VALUES('proj_1',?,'sess_dangling','t','response',
      'cli','{}',?,0,0,2,9999,0)`).run(uuid(1), '0'.repeat(64));
    expect(() => recoveryBundleInventory(f.sqlite)).toThrow('event_content_reference_invalid');
    expect(f.sqlite.query("SELECT name FROM sqlite_temp_master WHERE type='table'").all()).toEqual([]);
  } finally { f.sqlite.close(); }
});

it('operator recovery refuses a bundle outside the bounded entry format',async()=>{
  const f=sqliteEnv();
  try {
    const now=Date.now(),token=seedCredential(f.sqlite,{expiresAt:now+60_000});
    expect(await ingestEvent(f.db,{projectId:'proj_1',machineId:'m',tokenId:token,bodyBytes:0,now},
      envelope({eventId:uuid(90),kind:'tool.use',payload:{toolCallId:uuid(91),toolName:'Read',
        input:'format bound'.repeat(300),success:true}}),f.serverEnv)).toMatchObject({persisted:true,projected:true});
    f.sqlite.exec('UPDATE archive_bundles SET entry_count=65');
    const sourceKey=(key:string)=>{
      const [project,digest]=key.split('/');
      return (f.sqlite.query(`SELECT ${registeredObjectKeySql('?', '?')} AS key`).get(project!,digest!) as {key:string}).key;
    };
    await expect(verifyCopiedBundleEntries(f.sqlite,{...f.bucket,head:key=>f.bucket.head(sourceKey(key)),
      get:(key,options)=>f.bucket.get(sourceKey(key),options)})).rejects.toThrow('event_content_reference_invalid');
    expect(f.sqlite.query("SELECT name FROM sqlite_temp_master WHERE type='table'").all()).toEqual([]);
  } finally {f.sqlite.close();}
});
