import { it, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { run } from '@myco/cli/setup.js';
import { run as login } from '@myco/cli/login.js';
import { runJoin } from '@myco/cli/member.js';
import { createCloudflareDeployment } from '@myco/server/cloudflare-lifecycle.js';
import { prepareLocal } from '@myco/server/local-lifecycle.js';
import { convertManifestCode, registerGitHubApp, writeSignInPending } from '@myco/server/github-app.js';
import type { SetupDeps } from '@myco/setup/steps.js';
import { ownerDeployment, ACCOUNT, HOSTED_URL } from './owner-deployment.js';

it('conducts a create journey across a parent-owned process interruption', async () => {
  const root = process.env.MYCO_SETUP_FIXTURE_ROOT!;
  const home = path.join(root, 'myco');
  process.env.MYCO_HOME = home;
  const target = process.env.MYCO_SETUP_TARGET === 'cloudflare' ? 'cloudflare' : 'local';
  const boundary = process.env.MYCO_SETUP_STOP_AFTER;
  const address = target === 'cloudflare' ? HOSTED_URL : 'http://127.0.0.1:8787';
  const server = ownerDeployment(root, home, target, address);
  if (boundary === 'cloudflare-login') server.signOutWrangler();
  const reached = () => {
    fs.writeFileSync(path.join(root, 'reached'), boundary!);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  };
  const deps: SetupDeps = {
    ...server.deps, mycoHome: home, cwd: path.join(root, 'repo'), agents: () => [],
    ask: async question => {
      if (process.env.MYCO_SETUP_RESUME && question.startsWith('Approve this plan?')) throw new Error('resume unexpectedly re-asked plan consent');
      if (process.env.MYCO_SETUP_RESUME) return null;
      return question.startsWith('Choose the address') ? '1' : question.includes('already have') ? 'no' : 'yes';
    },
    sleep: async () => {}, loginDeps: { machineId: `kill-${target}` },
    createCloudflare: async options => { const result = await createCloudflareDeployment(options); if (boundary === 'create') reached(); return result; },
    registerApp: async options => {
      if (boundary === 'create' && target === 'local') reached();
      if (boundary === 'conversion' || boundary === 'installed') {
        if (target === 'local') { await writeSignInPending(options.target, await convertManifestCode('setup-conversion', server.github.registrationFetch), options.url); reached(); }
        else {
          const runner = options.runner!;
          options = { ...options, runner: { run: async (command, args, opts) => {
            if (boundary === 'conversion' && args.includes('bulk')) reached();
            const result = await runner.run(command, args, opts);
            if (boundary === 'installed' && args.includes('bulk')) reached();
            return result;
          } } };
        }
      }
      const result = await registerGitHubApp(options);
      if (boundary === 'signin') reached();
      return result;
    },
    prepareLocal: async (localHome, plan, localDeps) => { const result = await prepareLocal(localHome, plan, localDeps); if (boundary === 'owner-mint') reached(); return result; },
    openUrl: async url => {
      const owner = new URL(url).hash !== '';
      if (owner && boundary === 'owner-mint' && target === 'cloudflare') reached();
      await server.openUrl(url);
      if (owner && boundary === 'owner-link') reached();
    },
    login: async (args, loginDeps) => { const result = await login(args, loginDeps); if (boundary === 'machine') reached(); return result; },
    join: async (args, joinDeps) => { const result = await runJoin(args, joinDeps); if (boundary === 'project') reached(); return result; },
  };
  if (boundary === 'partial-create' || boundary === 'before-deploy') deps.cloudflare = { ...server.deps.cloudflare, runner: { run: async (command, args, options) => {
    if (boundary === 'partial-create' && args[2] === 'vectorize' && args[3] === 'create') reached();
    if (boundary === 'before-deploy' && args.includes('deploy')) reached();
    return server.runner.run(command, args, options);
  } } };
  if (boundary === 'cloudflare-login') deps.cloudflare = { ...server.deps.cloudflare, runner: { run: async (command, args, options) => {
    const result = await server.runner.run(command, args, options);
    if (args.includes('login')) reached();
    return result;
  } } };
  if (boundary === 'service') deps.local = { ...server.deps.local, service: { ...server.deps.local.service, runner: (command, args) => {
    const result = server.platform.runner(command, args);
    if (args[0] === 'load') reached();
    return result;
  } } };
  const first = ['--create', target, ...(target === 'cloudflare' ? ['--account-id', ACCOUNT] : ['--serve', 'service']), '--yes', '--new', 'Kill recovery', '--no-agents', '--no-runner'];
  try {
    expect(await run(process.env.MYCO_SETUP_RESUME ? ['--yes'] : first, deps)).toBe(0);
    fs.writeFileSync(path.join(root, 'resumed'), JSON.stringify({ commands: server.commands, conversions: server.github.calls.filter(call => call.url.includes('/conversions')).length, totalConversions: server.conversions }));
  } finally { await server.close(); }
}, 30_000);
