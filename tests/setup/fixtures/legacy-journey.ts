import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { sandboxChildEnv, bindSandboxChildHome } from '../../../scripts/test-environment.mjs';
import { createBunHandler } from '@myco-server-worker/entry/bun.js';
import { readDeploymentMembership, writeDeploymentMembership, writeRegistryEntry } from '@myco/member/registry.js';
import { recordDefaultDeployment } from '@myco/member/default-deployment.js';
import { resolveMachineIdPath } from '@myco/paths/home.js';
import type { SetupDeps } from '@myco/setup/steps.js';
import { memberRig } from '../../member/helpers/server.js';
import { SESSION_SECRET } from '../../myco-server/helpers/owner.js';
import { legacyFixtureHome } from './legacy-home.js';

export const LEGACY_URLS = ['https://legacy-a.invalid', 'https://legacy-b.invalid'] as const;

/** File-backed native front doors retain accepted history across a killed setup process. */
export async function legacyJourney(root: string, options: { multi?: boolean; missing?: boolean; secondMembership?: boolean; agents?: string[] } = {}) {
  const metadata = path.join(root, 'legacy-fixture.json');
  let legacy: Omit<ReturnType<typeof legacyFixtureHome>, 'env'>;
  if (!fs.existsSync(metadata)) {
    const { env: _env, ...files } = legacyFixtureHome(path.join(root, 'legacy'));
    legacy = files;
    fs.copyFileSync(legacy.vault, path.join(root, 'vault-before'));
    for (const project of legacy.projects) execFileSync('git', ['init', '-q', project.root]);
    fs.writeFileSync(path.join(legacy.mycoHome, 'unmanaged.txt'), 'Keep this user file byte for byte.\n');
    for (const [index, serverUrl] of LEGACY_URLS.entries()) {
      const rig = await memberRig();
      fs.writeFileSync(path.join(root, `deployment-${index}.sqlite`), rig.env.sqlite.serialize());
      rig.env.sqlite.close();
      if (index === 0 || options.multi || options.missing || options.secondMembership) writeDeploymentMembership({ serverUrl, token: rig.token, machineId: 'machine_1', joinedAt: 1, updatedAt: 1 }, { mycoHome: legacy.mycoHome });
    }
    fs.writeFileSync(resolveMachineIdPath(legacy.mycoHome), 'machine_1');
    recordDefaultDeployment(LEGACY_URLS[0], { mycoHome: legacy.mycoHome });
    if (options.multi || options.missing) {
      const project = legacy.projects[0]!;
      const membership = readDeploymentMembership(LEGACY_URLS[0], legacy.mycoHome)!;
      writeRegistryEntry({ ...membership, version: 2, root: project.root, projectId: project.id }, { mycoHome: legacy.mycoHome });
    }
    if (options.multi) {
      const project = legacy.projects[1]!;
      const membership = readDeploymentMembership(LEGACY_URLS[1], legacy.mycoHome)!;
      writeRegistryEntry({ ...membership, version: 2, root: project.root, projectId: project.id }, { mycoHome: legacy.mycoHome });
    }
    if (options.missing) fs.rmSync(legacy.projects[1]!.root, { recursive: true });
    fs.writeFileSync(metadata, JSON.stringify(legacy));
  } else legacy = JSON.parse(fs.readFileSync(metadata, 'utf8'));
  const env = sandboxChildEnv(root, { HOME: legacy.home, MYCO_HOME: legacy.mycoHome, MYCO_LAUNCH_AGENTS_DIR: legacy.agentsDir });
  const restore = bindSandboxChildHome(root, env);
  const servers = await Promise.all(LEGACY_URLS.map((_, index) => createBunHandler({
    databasePath: path.join(root, `deployment-${index}.sqlite`), blobDir: path.join(root, `blobs-${index}`),
    header: 'x-forwarded-for', wakeLoop: false, SESSION_SECRET,
    GITHUB_CLIENT_ID: 'fixture', GITHUB_CLIENT_SECRET: 'fixture',
  })));
  const calls: { url: string; route: string; project: string | null }[] = [];
  const fetchImpl: typeof fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const index = LEGACY_URLS.indexOf(url.origin as typeof LEGACY_URLS[number]);
    if (index < 0) throw new Error(`Unexpected fixture destination ${url.origin}`);
    calls.push({ url: url.origin, route: url.pathname, project: request.headers.get('x-myco-project') });
    request.headers.set('x-forwarded-for', '192.0.2.31');
    return servers[index]!.fetch(request);
  }, { preconnect: () => {} });
  const checkpoints: string[] = [];
  const deps: SetupDeps = {
    mycoHome: legacy.mycoHome, cwd: legacy.projects[0]!.root, fetch: fetchImpl, agents: () => options.agents ?? [],
    ask: async () => null, sleep: async () => {},
    cutoverDeps: { env, platform: 'darwin', unitDirs: [{ dir: legacy.agentsDir, scope: 'user' }],
      stopDaemon: async () => 'none', launchctl: { run: async args => ({ stdout: args[0] === 'print' ? 'Could not find service in domain' : '', exitCode: args[0] === 'print' ? 113 : 0 }) },
      onCheckpoint: boundary => { checkpoints.push(boundary); },
    },
  };
  return { legacy, deps, calls, checkpoints, servers, close: async () => { for (const server of servers) await server.close(); restore(); } };
}
