/** Opt-in native low-tier title gate. All four harness homes must be inside MYCO_TITLING_SMOKE_ROOT. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, relative, isAbsolute } from 'node:path';
import { Database } from 'bun:sqlite';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { configureSqliteLibrary } from '../packages/myco-server/src/platform/bun/sqlite-library.js';
import { renderMigrationFiles } from '../packages/myco-server/src/db/migrate.js';
import { serve } from '../packages/myco-server/src/entry/bun.js';
import { ensureMember } from '../packages/myco-server/src/auth/enrollment.js';
import { issueMemberToken } from '../packages/myco-server/src/auth/tokens.js';
import { titleSession } from '../packages/myco-server/src/core/titling.js';
import { claimNextRun, endLeasedRun, HARNESS_MEMBER_ID } from '../packages/myco-server/src/core/harness.js';
import { settingsWriter } from '../packages/myco-server/src/core/settings.js';
import { getRun } from '../packages/myco-server/src/core/runs.js';
import { memberHeaders } from '../packages/myco/src/member/constants.js';
import { offerOf } from '../packages/myco/src/runner/detect.js';
import { claudeCodeDriver } from '../packages/myco/src/runner/drivers/claude-code.js';
import { writeRunDir, mcpConfigOf, MCP_SERVER_NAME } from '../packages/myco/src/runner/mcp-config.js';
import { runToolUse } from '../packages/myco/src/runner/tool-use.js';
import { harnessById } from '../packages/myco/src/runner/harnesses.js';
import { ExecutionAccounting } from '../packages/myco/src/runner/accounting.js';
import { classifyDiagnostic, harnessStoppedError } from '@goondocks/myco-shared/run-text';
import { WORKER_CAPABILITIES } from '@goondocks/myco-shared/repository';
import { WORKER_ACCOUNTING_VERSION } from '@goondocks/myco-shared/worker-usage';
import type { RunEvent } from '../packages/myco/src/runner/events.js';

const namedRoot = process.env.MYCO_TITLING_SMOKE_ROOT;
assert(namedRoot, 'Set MYCO_TITLING_SMOKE_ROOT to your isolated scratch folder');
const root = realpathSync(namedRoot);
for (const name of ['HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'MYCO_HOME']) {
  const home = process.env[name];
  assert(home, `Set ${name} to a directory inside the scratch folder`);
  const within = relative(root, realpathSync(home));
  assert(within !== '' && !within.startsWith('..') && !isAbsolute(within), `${name} must be inside the scratch folder`);
}
const scratch = mkdtempSync(join(root, 'native-title-'));
const originalPath = process.env.PATH;
const binary = execFileSync('/usr/bin/which', ['claude'], { encoding: 'utf8' }).trim();
const wrapperDir = join(scratch, 'bin');
const initPath = join(scratch, 'claude-init.json');
mkdirSync(wrapperDir);
writeFileSync(join(wrapperDir, 'claude'), `#!${process.execPath}
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const child = spawn(${JSON.stringify(binary)}, process.argv.slice(2), { stdio: ['inherit', 'pipe', 'inherit'] });
let held = '';
child.stdout.on('data', (chunk) => {
  process.stdout.write(chunk);
  held += chunk.toString();
  let at;
  while ((at = held.indexOf('\\n')) >= 0) {
    const line = held.slice(0, at); held = held.slice(at + 1);
    let value; try { value = JSON.parse(line); } catch { continue; }
    if (value.type === 'system' && value.subtype === 'init') writeFileSync(${JSON.stringify(initPath)}, JSON.stringify({
      tools: value.tools, mcp: value.mcp_servers?.map(({ name, status }) => ({ name, status }))
    }));
  }
});
child.on('exit', (code) => process.exit(code ?? 1));
`, { mode: 0o700 });
process.env.PATH = `${wrapperDir}:${originalPath ?? ''}`;
const databasePath = join(scratch, 'myco.sqlite');
const blobDir = join(scratch, 'blobs');
mkdirSync(blobDir);
configureSqliteLibrary();
const sqlite = new Database(databasePath);
for (const migration of renderMigrationFiles()) sqlite.exec(migration.sql);
const now = Date.now();
const projectId = 'proj_titling_smoke';
const sessionId = 'session_titling_smoke';
sqlite.run('INSERT INTO projects (project_id, name, created_at) VALUES (?, ?, ?)', [projectId, 'Isolated title smoke', now]);
sqlite.run('INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES (?, ?, ?, 1, ?)', ['myco-agent', 'Myco', 'built-in', now]);
sqlite.run('INSERT OR IGNORE INTO members (id, label, created_at, role) VALUES (?, ?, ?, ?)', [HARNESS_MEMBER_ID, 'harness', now, 'member']);
sqlite.close();
const deployment = await serve({ databasePath, blobDir, port: 0, wakeLoop: false, sourceFrom: 'socket', originOf: (port) => `http://127.0.0.1:${port}` });
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 60_000);
const client = new Client({ name: 'native-title-smoke', version: '1' });
try {
  await ensureMember(deployment.env.db, 'mem_title_smoke', now, 'admin', 'isolated worker');
  const credential = await issueMemberToken(deployment.env.db, { memberId: 'mem_title_smoke', machineId: 'machine_title_smoke' }, now);
  await settingsWriter(deployment.env.db).setLeaf('agent.harnesses.claude-code.credential', 'worker-login', 'mem_title_smoke', now);
  const seed = new Database(databasePath);
  seed.run('INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at, agent, branch, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [projectId, sessionId, 'machine_title_smoke', credential.tokenId, now, now, 'claude-code', 'main', now, now]);
  seed.run('INSERT INTO prompt_batches (project_id, session_id, prompt_id, event_id, text, origin, content_hash, created_at, updated_at, token_id, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [projectId, sessionId, 'prompt_title_smoke', 'event_title_smoke', 'Add a bounded retry around a transient runner connection failure. The retry was implemented and its regression gate passed.', 'user', 'smoke', now, now, credential.tokenId, now]);
  seed.close();
  const origin = `http://127.0.0.1:${deployment.port}`;
  assert.equal((await titleSession(deployment.env, { projectId, sessionId, now, origin })).outcome, 'queued');
  const claimed = await claimNextRun(deployment.env, { tokenId: credential.tokenId, machineId: 'machine_title_smoke', harnesses: offerOf([{ id: 'claude-code', installed: true, authenticated: true }]).offered, capabilities: WORKER_CAPABILITIES, now: Date.now() });
  assert(claimed.claimed, 'The native Deployment must hand out the title run');
  const run = claimed.run;
  assert.equal(run.profile.tier, 'low');
  const connection = { serverUrl: origin, projectId, runToken: run.runToken };
  const config = mcpConfigOf(connection) as { mcpServers: Record<string, { alwaysLoad?: boolean }> };
  assert.equal(config.mcpServers[MCP_SERVER_NAME]!.alwaysLoad, true);
  await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', origin), { requestInit: { headers: memberHeaders({ token: run.runToken, projectId }) } }));
  const tools = (await client.listTools()).tools.map((tool) => tool.name);
  assert(tools.includes('myco_run_sessions') && tools.includes('myco_run'), 'The title run must see its material, title and report tools');
  console.log(JSON.stringify({ attached: tools, alwaysLoad: true, tier: run.profile.tier, model: run.profile.model }));
  const accounting = new ExecutionAccounting();
  const toolUse = runToolUse(harnessById('claude-code')!.steps, false);
  let ending: Extract<RunEvent, { kind: 'ended' }> | undefined;
  for await (const event of claudeCodeDriver.run({ ...writeRunDir(scratch, run.id, connection), prompt: run.instruction!, credentialEnv: {}, profile: run.profile }, controller.signal)) {
    if (event.kind === 'identity') accounting.observe(event.identity, event.snapshot);
    if (event.kind === 'usage') { const { kind: _kind, ...usage } = event; accounting.usage(usage); }
    if (event.kind === 'tool_call') console.log(JSON.stringify({ tool: event.name, status: event.status }));
    const unused = toolUse(event);
    if (unused !== null) { ending = unused; controller.abort(); break; }
    if (event.kind === 'ended') ending = event;
  }
  if (existsSync(initPath)) console.log(JSON.stringify({ claudeInit: JSON.parse(readFileSync(initPath, 'utf8')) }));
  assert(ending, 'The real Claude Code stream must end');
  await endLeasedRun(deployment.env, { tokenId: credential.tokenId, now: Date.now() }, { projectId, runId: run.id, status: ending.stop === 'end_turn' ? 'completed' : 'failed', error: ending.stop === 'end_turn' ? null : harnessStoppedError(ending.stop, classifyDiagnostic('claude-code', ending)), identity: accounting.identity, accountingVersion: WORKER_ACCOUNTING_VERSION, attemptId: run.attemptId });
  const completed = await getRun(deployment.env.db, { projectId }, run.id);
  console.log(JSON.stringify({ status: completed?.status, error: completed?.error }));
  assert.equal(completed?.status, 'completed', 'The real low-tier title run must complete');
  const verify = new Database(databasePath);
  try {
    const title = verify.query('SELECT title, summary FROM sessions WHERE project_id = ? AND session_id = ?').get(projectId, sessionId) as { title: string | null; summary: string | null };
    assert(title.title && title.summary, 'The real run must store both title and summary');
    console.log(JSON.stringify({ title: title.title, summary: title.summary }));
  } finally { verify.close(); }
} finally {
  if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
  clearTimeout(timeout);
  controller.abort();
  await client.close();
  await deployment.stop();
}
