#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO_ROOT = '/Users/chris/Repos/myco-collective-v1';
const TEAM_CONFIG_PATH = path.join(os.homedir(), '.myco-team', 'config.json');
const COLLECTIVE_CONFIG_PATH = path.join(os.homedir(), '.myco-collective', 'config.json');
const SMOKE_PREFIX = 'myco-smoke';
const NOW = Date.now();
const TEAM_PROJECT_NAME = `${SMOKE_PREFIX}-project-${NOW}`;
const COLLECTIVE_NAME = `${SMOKE_PREFIX}-collective-${NOW}`;
const EDGE_READY_ATTEMPTS = 12;
const EDGE_READY_DELAY_MS = 2_000;
const NODE_BIN = process.execPath;

function run(command, args, options = {}) {
  const executable = command === 'node' ? NODE_BIN : command;
  console.log(`$ ${command} ${args.join(' ')}`);
  return execFileSync(executable, args, {
    cwd: options.cwd ?? REPO_ROOT,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    ...options,
  });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function backupFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const backupPath = `${filePath}.smoke-backup-${NOW}`;
  fs.mkdirSync(path.dirname(backupPath), { recursive: true });
  fs.copyFileSync(filePath, backupPath);
  return backupPath;
}

function restoreBackup(originalPath, backupPath) {
  if (!backupPath) {
    fs.rmSync(originalPath, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(originalPath), { recursive: true });
  fs.copyFileSync(backupPath, originalPath);
  fs.rmSync(backupPath, { force: true });
}

async function fetchJson(url, init = {}) {
  const response = await fetch(url, init);
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { response, body, text };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForCheck(label, check) {
  let lastError = null;
  for (let attempt = 1; attempt <= EDGE_READY_ATTEMPTS; attempt += 1) {
    try {
      return await check();
    } catch (error) {
      lastError = error;
      if (attempt === EDGE_READY_ATTEMPTS) break;
      await sleep(EDGE_READY_DELAY_MS);
    }
  }

  throw new Error(`${label} did not become ready: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function createSmokeProject() {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), `${SMOKE_PREFIX}-repo-`));
  run('git', ['init'], { cwd: projectDir });
  const vaultDir = path.join(projectDir, '.myco');
  fs.mkdirSync(vaultDir, { recursive: true });
  fs.writeFileSync(path.join(vaultDir, 'myco.yaml'), ['version: 3', 'config_version: 0', 'team:', '  enabled: false'].join('\n'), 'utf-8');
  return { projectDir, vaultDir };
}

async function main() {
  const teamBackup = backupFile(TEAM_CONFIG_PATH);
  const collectiveBackup = backupFile(COLLECTIVE_CONFIG_PATH);
  const smokeProject = createSmokeProject();
  let teamInstalled = false;
  let collectiveInstalled = false;

  try {
    run('wrangler', ['whoami']);

    run('node', ['packages/myco-team/dist/main.js', 'install', smokeProject.projectDir]);
    teamInstalled = true;
    const teamConfig = readJson(TEAM_CONFIG_PATH);
    assert(teamConfig.worker_url && teamConfig.api_key, 'Team config missing worker_url or api_key');

    const teamHealth = await waitForCheck('Team health', async () => {
      const result = await fetchJson(`${teamConfig.worker_url}/health`);
      assert(result.response.ok, `Team health failed: ${result.response.status}`);
      assert(result.body?.status === 'ok', 'Team health did not return ok');
      return result;
    });

    run('node', ['packages/myco-collective/dist/main.js', 'install', COLLECTIVE_NAME]);
    collectiveInstalled = true;
    let collectiveConfig = readJson(COLLECTIVE_CONFIG_PATH);
    assert(collectiveConfig.worker_url && collectiveConfig.admin_token, 'Collective config missing worker_url or admin_token');

    const collectiveHealth = await waitForCheck('Collective health', async () => {
      const result = await fetchJson(`${collectiveConfig.worker_url}/health`);
      assert(result.response.ok, `Collective health failed: ${result.response.status}`);
      assert(result.body?.project_count === 0, 'Fresh collective should start with zero projects');
      return result;
    });

    await waitForCheck('Collective UI root', async () => {
      const uiRoot = await fetch(`${collectiveConfig.worker_url}/`);
      const uiRootText = await uiRoot.text();
      assert(uiRoot.ok, `Collective UI root failed: ${uiRoot.status}`);
      assert(uiRootText.includes('<div id="root"></div>'), 'Collective UI root did not serve the SPA shell');
    });

    await waitForCheck('Collective UI /projects', async () => {
      const uiProjects = await fetch(`${collectiveConfig.worker_url}/projects`);
      const uiProjectsText = await uiProjects.text();
      assert(uiProjects.ok, `Collective UI /projects failed: ${uiProjects.status}`);
      assert(uiProjectsText.includes('<div id="root"></div>'), 'Collective UI /projects did not fall back to the SPA shell');
    });

    run('node', [
      'packages/myco-collective/dist/main.js',
      'add-project',
      TEAM_PROJECT_NAME,
      teamConfig.worker_url,
      teamConfig.api_key,
    ]);

    const collectiveProjects = await fetchJson(`${collectiveConfig.worker_url}/api/projects`, {
      headers: { Authorization: `Bearer ${collectiveConfig.admin_token}` },
    });
    assert(collectiveProjects.response.ok, `Collective project listing failed: ${collectiveProjects.response.status}`);
    assert(Array.isArray(collectiveProjects.body?.projects), 'Collective project listing did not return projects');
    assert(collectiveProjects.body.projects.length === 1, 'Collective should have exactly one smoke project');
    assert(collectiveProjects.body.projects[0].last_seen, 'Collective project did not record a heartbeat timestamp');
    assert(collectiveProjects.body.projects[0].package_version, 'Collective project did not record package_version');
    assert(collectiveProjects.body.projects[0].schema_version, 'Collective project did not record schema_version');

    const teamCollectiveStatus = await fetchJson(`${teamConfig.worker_url}/collective/status`, {
      headers: { Authorization: `Bearer ${teamConfig.api_key}` },
    });
    assert(teamCollectiveStatus.response.ok, `Team collective status failed: ${teamCollectiveStatus.response.status}`);
    assert(teamCollectiveStatus.body?.connected === true, 'Team worker did not report a connected Collective');
    assert(teamCollectiveStatus.body?.project_id, 'Team worker did not persist the Collective project id');
    assert(teamCollectiveStatus.body?.last_heartbeat, 'Team worker did not record the last collective heartbeat');

    const queryProjects = await fetchJson(`${collectiveConfig.worker_url}/api/query`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${collectiveConfig.admin_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ tool: 'collective_projects', args: {} }),
    });
    assert(queryProjects.response.ok, `Collective query failed: ${queryProjects.response.status}`);
    assert(Array.isArray(queryProjects.body?.projects), 'Collective query did not return projects');

    const oldAdminToken = collectiveConfig.admin_token;
    run('node', ['packages/myco-collective/dist/main.js', 'rotate-tokens', 'admin']);
    collectiveConfig = readJson(COLLECTIVE_CONFIG_PATH);
    assert(collectiveConfig.admin_token !== oldAdminToken, 'Collective admin token did not rotate');

    const verifyNewToken = await fetchJson(`${collectiveConfig.worker_url}/api/auth/verify`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${collectiveConfig.admin_token}` },
    });
    assert(verifyNewToken.response.ok, `Verification with rotated admin token failed: ${verifyNewToken.response.status}`);

    const verifyOldToken = await fetchJson(`${collectiveConfig.worker_url}/api/auth/verify`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${oldAdminToken}` },
    });
    assert(verifyOldToken.response.status === 401, 'Old admin token should be rejected after rotation');

    console.log('\nCloudflare smoke test passed.');
    console.log(JSON.stringify({
      team_worker_url: teamConfig.worker_url,
      collective_worker_url: collectiveConfig.worker_url,
      project_id: teamCollectiveStatus.body.project_id,
    }, null, 2));
  } finally {
    if (collectiveInstalled) {
      try {
        run('node', ['packages/myco-collective/dist/main.js', 'destroy']);
      } catch (error) {
        console.error(`Collective cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (teamInstalled) {
      try {
        run('node', ['packages/myco-team/dist/main.js', 'destroy']);
      } catch (error) {
        console.error(`Team cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    restoreBackup(COLLECTIVE_CONFIG_PATH, collectiveBackup);
    restoreBackup(TEAM_CONFIG_PATH, teamBackup);
    fs.rmSync(smokeProject.projectDir, { recursive: true, force: true });
  }
}

await main();
