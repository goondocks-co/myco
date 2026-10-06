import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import { expect, it } from 'bun:test';
import { chromium } from 'playwright';
import { sha256Hex } from '@myco-server-worker/hash.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import { resolveLocalPaths, writeLocalSecrets } from '@myco/server/local.js';
import { signSession, SESSION_COOKIE } from '@myco-server-worker/auth/owner/cookie.js';
import { storageCleanupParity } from '../parity/scenarios/storage-cleanup.js';
import { GITHUB_SUB, MACHINE_ID, MEMBER_ID, PROJECT_ID, SESSION_SECRET, grantHeadersFor,
  memberHeadersFor, volumeSql, type ParityTarget } from '../parity/harness.js';

const binary = process.env.MYCO_STORAGE_CLEANUP_BINARY;

/** The carried native binary, UI and operator recovery commands share the archival contract. */
(binary ? it : it.skip)('serves cleanup through the compiled native binary and recovers its archives with the source unavailable', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-storage-binary-'));
  const childEnv = (home: string) => ({ PATH: process.env.PATH!, HOME: path.join(home, 'home'),
    CODEX_HOME: path.join(home, 'home/codex'), CLAUDE_CONFIG_DIR: path.join(home, 'home/claude'),
    MYCO_HOME: path.join(home, 'myco'), TMPDIR: path.join(root, 'tmp'), TMP: path.join(root, 'tmp'), TEMP: path.join(root, 'tmp') });
  fs.mkdirSync(path.join(root, 'tmp'));
  const sourceEnv = childEnv(path.join(root, 'source'));
  const restoredEnv = childEnv(path.join(root, 'restored'));
  let running: ReturnType<typeof Bun.spawn> | undefined;
  const invoke = async (args: string[], env = sourceEnv) => {
    const process = Bun.spawn([binary!, 'server', ...args], { env, stdout: 'pipe', stderr: 'pipe' });
    const [code] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
    expect(code, `compiled CLI ${args[0]}`).toBe(0);
  };
  const port = () => {
    const socket = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
    const value = socket.port!;socket.stop(true);return value;
  };
  const stop = async () => {
    if (running === undefined) return;
    running.kill('SIGTERM');
    const timer = setTimeout(() => running?.kill('SIGKILL'), 10_000);
    try { await running.exited; } finally { clearTimeout(timer);running = undefined; }
  };
  const start = async (env: ReturnType<typeof childEnv>, selectedPort: number) => {
    running = Bun.spawn([binary!, 'server', 'run', '--target', 'local', '--no-worker'], {
      env, stdout: Bun.file(path.join(root, `server-${selectedPort}.log`)), stderr: Bun.file(path.join(root, `server-${selectedPort}.error.log`)),
    });
    const url = `http://127.0.0.1:${selectedPort}`;
    for (let pass = 0; pass < 100; pass++) {
      try { if ((await fetch(`${url}/health`)).status === 200) return url; } catch {}
      await Bun.sleep(100);
    }
    throw new Error('compiled native server did not become healthy');
  };
  try {
    const selectedPort = port();
    await invoke(['create', '--target', 'local', '--port', String(selectedPort)]);
    const sourcePaths = resolveLocalPaths(sourceEnv.MYCO_HOME);
    writeLocalSecrets({ SESSION_SECRET, SECRET_WRAP_KEY: Buffer.alloc(32, 7).toString('base64'),
      GITHUB_CLIENT_ID: 'storage-fixture', GITHUB_CLIENT_SECRET: 'storage-fixture' }, sourcePaths);
    const sqlite = new Database(sourcePaths.databasePath);
    sqlite.query(`INSERT INTO members(id,label,created_at,github_id) VALUES(?,?,?,?)`).run(MEMBER_ID, 'fixture', Date.now(), GITHUB_SUB);
    sqlite.query(`INSERT INTO projects(project_id,name,created_at) VALUES(?,?,?)`).run(PROJECT_ID, PROJECT_ID, Date.now());
    const issued = await issueMemberToken(sqliteRelationalStore(sqlite), { memberId: MEMBER_ID, machineId: MACHINE_ID }, Date.now());
    sqlite.close();
    const cookie = `${SESSION_COOKIE}=${await signSession(SESSION_SECRET, { sub: GITHUB_SUB, login: 'fixture', iat: Date.now(), exp: Date.now()+3_600_000 })}`;
    const url = await start(sourceEnv, selectedPort);
    const target: ParityTarget = { name: 'selfhosted', url, projectId: PROJECT_ID, memberToken: issued.token,
      ownerHeaders: () => ({ cookie }), memberHeaders: extra => memberHeadersFor(issued.token, PROJECT_ID, extra),
      grantHeaders: grantHeadersFor, sql: volumeSql(sourcePaths.databasePath), clockWake: async () => {}, stop };
    await storageCleanupParity.run(target);
    const shell = await fetch(`${url}/`);
    expect(shell.status).toBe(200);
    expect(await shell.text()).toContain('<html');

    const [tool] = await target.sql(`SELECT session_id,tool_call_id,input_blob_key FROM tool_calls WHERE project_id='${PROJECT_ID}' LIMIT 1`);
    const fullPath = `/api/projects/${PROJECT_ID}/processed/tool-input/${tool.tool_call_id}`;
    const full = await (await fetch(`${url}${fullPath}`, { headers: { cookie } })).text();
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext();
      await context.addCookies([{ name: SESSION_COOKIE,value:cookie.slice(SESSION_COOKIE.length+1),
        domain:new URL(url).hostname,path:'/',secure:true,httpOnly:true,sameSite:'Lax' }]);
      const page = await context.newPage();
      await page.goto(`${url}/p/${PROJECT_ID}/sessions/${tool.session_id}`);
      await page.getByTestId('tool-calls-toggle').first().click();
      const row = page.getByTestId(`tool-call-${tool.tool_call_id}`);
      await row.waitFor();
      await row.getByRole('button').first().click();
      const link = row.getByRole('link', { name: 'Full input', exact: true });
      expect(await link.getAttribute('href')).toBe(fullPath);
      expect((await row.locator('pre').first().textContent())?.endsWith('…')).toBe(true);
      await context.close();
    } finally { await browser.close(); }

    const artifact = path.join(root, 'recovery');
    await invoke(['backup', '--target', 'local', '--to', artifact]);
    await stop();
    fs.rmSync(sourcePaths.blobDir, { recursive: true });
    const restorePort = port();
    await invoke(['restore', '--target', 'local', '--from', artifact, '--secrets-from', sourcePaths.secretsFile,
      '--yes', '--port', String(restorePort)], restoredEnv);
    const restoredUrl = await start(restoredEnv, restorePort);
    const recovered = await fetch(`${restoredUrl}${fullPath}`, { headers: { cookie } });
    expect(recovered.status).toBe(200);
    expect(await recovered.text()).toBe(full);
    const restoredPaths = resolveLocalPaths(restoredEnv.MYCO_HOME);
    const recoveredDb = new Database(restoredPaths.databasePath);
    try {
      expect((recoveredDb.query(`SELECT COUNT(*) AS n FROM events WHERE payload_format='archived'`).get() as {n:number}).n).toBeGreaterThan(0);
      const ref=recoveredDb.query(`SELECT r.archive_key,r.digest,m.github_id FROM event_content_refs r
        JOIN events e ON e.project_id=r.project_id AND e.event_id=r.event_id
        JOIN raw_credentials c ON c.token_id=e.token_id JOIN members m ON m.id=c.owner_member_id
        WHERE e.kind='response' LIMIT 1`).get() as {archive_key:string;digest:string;github_id:string};
      const rawPath=`${restoredUrl}/api/projects/${PROJECT_ID}/blobs/${ref.archive_key}`;
      const uploaderCookie=`${SESSION_COOKIE}=${await signSession(SESSION_SECRET,{sub:ref.github_id,login:'fixture',iat:Date.now(),exp:Date.now()+60_000})}`;
      const raw=await fetch(rawPath,{headers:{cookie:uploaderCookie}});
      expect(raw.status).toBe(200);
      expect(await sha256Hex(await raw.text())).toBe(ref.digest);
      expect((await fetch(rawPath,{headers:{cookie}})).status).toBe(404);
    } finally { recoveredDb.close(); }
  } finally { await stop();fs.rmSync(root, { recursive: true, force: true }); }
}, 180_000);
