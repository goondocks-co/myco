/** Persisted fleet fixtures over the native front door and built dashboard. Run from a scratch directory. */
import { Database } from 'bun:sqlite';
import { chromium, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderMigrationFiles } from '@myco-server-worker/db/migrate.js';
import { signSession, SESSION_COOKIE } from '@myco-server-worker/auth/owner/cookie.js';
import { serve } from '@myco-server-worker/entry/bun.js';
import { seedIdentities, OWNER, READER, MACHINES } from './fixture.ts';
import { offeredHarness } from '../myco-server/helpers/offered-harness.ts';
import { smallTapTargets } from './checks.ts';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-runner-screens-'));
const output = process.env.RUNNER_SHOTS_DIR;
if (!output) throw new Error('RUNNER_SHOTS_DIR is required');
fs.mkdirSync(output, { recursive: true });
const databasePath = path.join(root, 'myco.sqlite');
const secret = 'runner-screens-session-secret-0123456789';
const now = Date.now();
let sqlite = new Database(databasePath);
sqlite.exec('PRAGMA foreign_keys = ON');
for (const file of renderMigrationFiles()) sqlite.exec(file.sql);
const deploymentId = (sqlite.query("SELECT value FROM schema_meta WHERE key='deployment_id'").get() as { value: string }).value;
sqlite.close();
await seedIdentities(databasePath, now);
sqlite = new Database(databasePath);
sqlite.exec('PRAGMA foreign_keys = ON');
const states = [['busy','homelab-mini','Busy'],['idle','work-laptop','Online'],['empty','needs-agent','Not ready'],
  ['settling','waking-machine','Not ready'],['paused','paused-machine','Paused'],['removed','removed-machine','Removed'],
  ['stale','offline-machine','Offline'],['never','new-machine','Never contacted'],['unknown','unknown-reports','Not ready']] as const;
sqlite.run("INSERT INTO projects(project_id,name,created_at) VALUES ('proj_runner_screens','Myco',?)", [now]);
sqlite.run("INSERT INTO agents(id,name,source,enabled,created_at) VALUES ('myco-agent','Myco','built-in',1,?)", [now]);
for (const [id, name] of states) {
  sqlite.run('INSERT INTO runners(id,name,state,created_at,created_by_member,removed_at) VALUES (?,?,?,?,?,?)',
    ['rn_'+id,name,id==='removed'?'removed':id==='paused'?'paused':'enabled',now,OWNER.id,id==='removed'?now:null]);
  sqlite.run('INSERT INTO runner_credentials(id,runner_id,token_hash,epoch,issued_at,expires_at,lineage_root) VALUES (?,?,?,1,?,?,?)',
    ['rc_'+id,'rn_'+id,'fixture-only-'+id,now,now+3600000,'rc_'+id]);
  if (id !== 'never' && id !== 'busy') {
    sqlite.run('INSERT INTO runner_contacts(runner_id,machine_id,os,version,offers,capabilities,last_reason,last_seen_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
      ['rn_'+id,name,'macOS','2.0.0-alpha.3',id==='unknown'?null:JSON.stringify(id==='empty'?[]:[offeredHarness('claude-code')]),'[]','no_work',id==='stale'?now-1800000:now-20000,now-20000]);
    sqlite.run('INSERT INTO runner_observations(runner_id,arch,availability,reason,observed_at) VALUES (?,?,?,?,?)',
      ['rn_'+id,'arm64',id==='settling'?'settling':'ready',id==='settling'?'Waiting to settle after waking.':'Awake.',now-20000]);
    sqlite.run('INSERT INTO runner_update_reports(runner_id,channel,current_version,latest_version,last_check_at,last_result) VALUES (?,?,?,?,?,?)',
      ['rn_'+id,'alpha','2.0.0-alpha.3','2.0.0-alpha.3',now-60000,null]);
  }
}
sqlite.run('INSERT INTO runner_model_catalogs(runner_id,harness,catalog,resolutions,fetched_at,received_at) VALUES (?,?,?,?,?,?)',
  ['rn_idle','claude-code',JSON.stringify({harness:'claude-code',source:{kind:'command',command:'claude models'},signIn:'worker-login',fetchedAt:now-60000,models:[]}), '{}',now-60000,now-30000]);
for (const [id,status] of [['busy','running'],['paused','running'],['idle-completed','completed'],['idle-failed','failed']] as const) {
  const owner = id.startsWith('idle-')?'idle':id;
  sqlite.run('INSERT INTO member_credentials(id,member_id,token_hash,issued_at,expires_at,lineage_root,lineage_started_at) VALUES (?,?,?,?,?,?,?)',
    ['attempt_'+id,OWNER.id,'fixture-attempt-'+id,now,now+3600000,'attempt_'+id,now]);
  sqlite.run("INSERT INTO agent_runs(id,project_id,agent_id,task,status,queued_at,started_at,completed_at,lease_expires_at,leased_runner_id,leased_runner_credential_id,dispatched_by) VALUES (?,'proj_runner_screens','myco-agent','title-summary',?,?,?,?,?,?,?,?)",
    ['run_'+id,status,now-3600000,now-1800000,status==='running'?null:now-600000,status==='running'?now+3600000:null,'rn_'+owner,'rc_'+owner,'attempt_'+id]);
  sqlite.run("INSERT INTO agent_run_attempts(project_id,run_id,attempt_id,leased_by,owner_kind,runner_id,claimed_at) VALUES ('proj_runner_screens',?,?,?,'runner',?,?)",
    ['run_'+id,'attempt_'+id,'rn_'+owner,'rn_'+owner,now-1800000]);
}
sqlite.run("UPDATE agent_runs SET run_context = '{\"timeoutSeconds\":7200}' WHERE status = 'running'");
for (let i=0;i<3;i++) sqlite.run("INSERT INTO agent_runs(id,project_id,agent_id,task,status,queued_at,held_by) VALUES (?,'proj_runner_screens','myco-agent','title-summary','queued',?,'worker')", ['run_wait_'+i,now-18*60000+i]);
const legacy = sqlite.query('SELECT id FROM member_credentials WHERE machine_id=?').get(MACHINES[0].id) as {id:string};
sqlite.run("INSERT INTO worker_contacts(credential_id,machine_id,offers,capabilities,last_reason,last_seen_at,updated_at) VALUES (?,?,'[]','[]','no_work',?,?)",
  [legacy.id,MACHINES[0].id,now-1800000,now-1800000]);
const started = await serve({databasePath,blobDir:path.join(root,'blobs'),uiDir:path.join(REPO,'packages/myco-server/ui/dist'),
  port:0,bind:'loopback',transport:'loopback',sourceFrom:'socket',wakeLoop:false,harnessLaunch:async()=>undefined,
  originOf:port=>'http://127.0.0.1:'+port,SESSION_SECRET:secret,SECRET_WRAP_KEY:btoa('runner-screens-wrap-key-0123456789'),GITHUB_CLIENT_ID:'fixture',GITHUB_CLIENT_SECRET:'fixture'});
const origin = 'http://127.0.0.1:'+started.port;
const browser = await chromium.launch();
const cookieFor = (member: typeof OWNER) => signSession(secret,{aud:deploymentId,sub:member.githubSub,login:member.login,iat:now,exp:now+3600000});
try {
  for (const mode of ['light','dark'] as const) {
    const context = await browser.newContext({viewport:{width:1440,height:1100},colorScheme:mode,reducedMotion:'reduce'});
    await context.addCookies([{name:SESSION_COOKIE,value:await cookieFor(OWNER),domain:'127.0.0.1',path:'/',secure:true}]);
    await context.addInitScript(mode=>localStorage.setItem('myco-appearance',JSON.stringify({theme:'sage',mode,font:'default',density:'normal'})),mode);
    const page = await context.newPage();
    await page.goto(origin+'/runners');
    await expect(page.getByRole('heading',{name:'homelab-mini'})).toBeVisible();
    for (const [id,,display] of states) {
      const card = page.locator('[data-runner="rn_'+id+'"]');
      await expect(card).toContainText(display);
      await expect(card).not.toContainText('Stopped');
      await expect(card.locator('details[open]')).toHaveCount(0);
      await card.screenshot({path:path.join(output,mode+'-'+id+'.png')});
    }
    await expect(page.locator('[data-runner="rn_busy"]')).toContainText('Writing a title for Myco');
    await expect(page.locator('[data-runner="rn_paused"]')).toContainText('Busy · draining');
    await expect(page.locator('[data-queue-warning]')).toContainText('3 runs waiting');
    await page.evaluate(() => window.scrollTo(0,0));
    await page.screenshot({path:path.join(output,mode+'-fleet.png'),fullPage:true});
    await page.locator('[data-runner="rn_idle"] summary').click();
    await expect(page.locator('[data-runner="rn_idle"]')).toContainText('claude models');
    await page.locator('[data-runner="rn_idle"]').screenshot({path:path.join(output,mode+'-details.png')});
    await page.locator('[data-runner="rn_idle"] summary').click();
    await page.setViewportSize({width:390,height:844});
    await expect(page.getByRole('navigation',{name:'Main pages'})).toBeVisible();
    await page.evaluate(() => window.scrollTo(0,0));
    await expect(page.getByRole('heading',{name:'homelab-mini'})).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (overflow > 0) throw new Error(`Runners page overflowed narrow viewport by ${overflow}px`);
    expect(await smallTapTargets(page), 'Runners tap targets under 44px').toEqual([]);
    await page.screenshot({path:path.join(output,mode+'-narrow.png')});
    await page.evaluate(() => window.scrollTo(0,document.documentElement.scrollHeight));
    await page.screenshot({path:path.join(output,mode+'-narrow-legacy.png')});
    await page.setViewportSize({width:1440,height:1100});
    await page.route('**/api/device/preview',route=>route.fulfill({json:{subject:'runner',runnerName:'homelab-mini',replacingRunnerId:'rn_busy',machineName:'Mini in the office',os:'macOS',ip:'192.0.2.10',approverIp:'192.0.2.20',ageSeconds:12,scope:'runner',expiresAt:now+600000}}));
    await page.getByRole('button',{name:'More actions for homelab-mini'}).click();
    await page.getByRole('menuitem',{name:'Replace registration'}).click();
    await page.getByLabel('Device code').fill('BCDF-GHJK');
    await expect(page.getByRole('button',{name:'Approve replacement'})).toBeDisabled();
    await page.getByRole('button',{name:'Check machine'}).click();
    await expect(page.getByRole('dialog')).toContainText('Mini in the office');
    await expect(page.getByRole('button',{name:'Approve replacement'})).toBeEnabled();
    await page.getByRole('dialog').screenshot({path:path.join(output,mode+'-replacement-review.png')});
    await page.getByRole('button',{name:'Cancel',exact:true}).click();
    await page.goto(origin+'/device');
    await page.getByLabel('Code from your terminal').fill('BCDF-GHJK');
    await page.getByRole('button',{name:'Check machine'}).click();
    await expect(page.getByRole('heading',{name:'Replace registration for homelab-mini'})).toBeVisible();
    await page.screenshot({path:path.join(output,mode+'-device-replacement.png'),fullPage:true});
    await page.unroute('**/api/device/preview');
    await page.goto(origin+'/runners');
    await page.getByRole('button',{name:'Forget this worker',exact:true}).click();
    await expect(page.getByRole('dialog')).toContainText('never revokes the member credential');
    await page.getByRole('dialog').screenshot({path:path.join(output,mode+'-forget-confirmation.png')});
    await page.getByRole('button',{name:'Cancel',exact:true}).click();
    await page.goto(origin+'/status/health#workers');
    await expect(page.locator('[data-legacy-worker]')).toContainText('Offline');
    await page.locator('[data-legacy-worker]').screenshot({path:path.join(output,mode+'-health-legacy.png')});
    await page.goto(origin+'/runners');
    await page.route('**/api/runners',route=>route.fulfill({json:{observedAt:now,runners:[],legacyWorkers:[],queue:{observedAt:now,count:0,oldestAt:null,reasons:[],nativeNeedsRunner:false}}}));
    await page.reload();
    await expect(page.getByText('No runners are registered.',{exact:false})).toBeVisible();
    await page.screenshot({path:path.join(output,mode+'-empty-fleet.png'),fullPage:true});
    await page.unroute('**/api/runners');
    await page.reload();
    await page.route('**/api/runners',route=>route.fulfill({status:503,json:{error:'unavailable'}}));
    await page.reload();
    await expect(page.getByText('Machine and queue information is unavailable.')).toBeVisible();
    await expect(page.getByText('No runners are registered.',{exact:false})).toHaveCount(0);
    await page.screenshot({path:path.join(output,mode+'-unavailable.png'),fullPage:true});
    await page.unroute('**/api/runners');
    await context.addCookies([{name:SESSION_COOKIE,value:await cookieFor(READER),domain:'127.0.0.1',path:'/',secure:true}]);
    await page.goto(origin+'/runners');
    await expect(page.getByRole('heading',{name:'homelab-mini'})).toBeVisible();
    for (const action of ['Rename','Pause','Remove','Replace registration','Update now','Forget this worker','More actions for homelab-mini'])
      await expect(page.getByRole('button',{name:action,exact:true})).toHaveCount(0);
    await page.screenshot({path:path.join(output,mode+'-member.png'),fullPage:true});
    sqlite.run('UPDATE members SET revoked_at=?,revoked_by=? WHERE id=?',[now,'fixture',READER.id]);
    await page.reload();
    await expect(page.locator('[data-runner]')).toHaveCount(0);
    await page.screenshot({path:path.join(output,mode+'-revoked-session.png'),fullPage:true});
    sqlite.run('UPDATE members SET revoked_at=NULL,revoked_by=NULL WHERE id=?',[READER.id]);
    await context.close();
  }
  const context = await browser.newContext();
  await context.addCookies([{name:SESSION_COOKIE,value:await cookieFor(OWNER),domain:'127.0.0.1',path:'/',secure:true}]);
  const page = await context.newPage();
  await page.goto(origin+'/status/health#workers');
  await page.getByRole('button',{name:'Forget this worker',exact:true}).click();
  await page.getByRole('button',{name:'Forget worker',exact:true}).click();
  await expect(page.locator('[data-legacy-worker]')).toHaveCount(0);
  await page.goto(origin+'/runners');
  await expect(page.getByRole('heading',{name:'homelab-mini'})).toBeVisible();
  await expect(page.locator('[data-legacy-worker]')).toHaveCount(0);
  await context.close();
  console.log('Runner browser fixtures passed: both modes, nine states, member/revoked reads, unavailable read and shared forget.');
} finally {
  await browser.close();
  await started.stop();
  sqlite.close();
  fs.rmSync(root,{recursive:true,force:true});
}
