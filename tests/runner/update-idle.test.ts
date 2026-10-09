import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runWorker } from '@myco/runner/loop.js';
import { RUNNER_CONTACT_PATH } from '@myco/runner/runner-routes.js';
import { FEATURES_HEADER } from '@goondocks/myco-shared/member-protocol';
import { EXECUTION_PROFILE_FEATURE } from '@goondocks/myco-shared/execution-profile';
import { STUB_PROFILE, stubProfileHarness } from '../helpers/stub-profile-harness.js';
import { bindSandboxChildHome } from '../../scripts/test-environment.mjs';

const answer = (body: Record<string, unknown>) => Response.json(body, {
  headers: { [FEATURES_HEADER]: EXECUTION_PROFILE_FEATURE },
});

describe('runner update idle admission', () => {
  it('defers a mid-run request through attempt completion, then restarts before another claim', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-runner-update-idle-'));
    const before = { ...process.env };
    const restore = bindSandboxChildHome(root);
    const release = path.join(root, 'release'), pidFile = path.join(root, 'pid');
    const stopping = new AbortController();
    let pending = false, active = false, ended = false, claims = 0, contacts = 0, idleCalls = 0;
    const events: string[] = [];
    try {
      stubProfileHarness({ holdUntil: release, pidFile });
      const timer = setInterval(() => {
        if (!fs.existsSync(pidFile) || pending) return;
        pending = true;
        events.push('requested');
        expect(idleCalls).toBe(1);
        setTimeout(() => fs.writeFileSync(release, ''), 40);
      }, 5);
      try {
        const outcome = await runWorker({
          serverUrl: 'https://update-idle.invalid', token: 'fixture', lockDir: null,
          deploymentId: 'dep_fixture', compatibilityPath: RUNNER_CONTACT_PATH,
          runRoot: path.join(root, 'runs'), only: ['claude-code'], detection: { credentialBytes: false },
          signal: stopping.signal, pollIdleMs: 1, log: () => {},
          contactBody: () => ({ update: { currentVersion: '2.0.0-alpha.2', channel: 'alpha' } }),
          onContact: async body => { if (body.updateRequest) events.push('delivered'); },
          onClaim: () => { expect(active).toBe(true); events.push('claim-started'); },
          onClaimCompleted: () => { expect(ended).toBe(true); events.push('claim-completed'); },
          onIdle: async () => {
            idleCalls++;
            expect(active).toBe(false);
            if (!pending) return;
            expect(ended).toBe(true);
            events.push('restart');
            return 'restart';
          },
          fetchImpl: (async (input, init) => {
            const url = new URL(String(input));
            if (url.pathname === RUNNER_CONTACT_PATH) {
              contacts++;
              expect(JSON.parse(String(init?.body)).update.channel).toBe('alpha');
              return answer({ persisted: true, runner: { deploymentId: 'dep_fixture' },
                updateRequest: pending ? { id: 'req_fixture', requestedAt: 1 } : null });
            }
            if (url.pathname === '/worker/claim') {
              expect(++claims).toBe(1);
              active = true;
              return answer({ persisted: true, claimed: true, leaseMs: 60_000, heartbeatMs: 30_000,
                run: { id: 'run_fixture', projectId: 'proj_fixture', task: 'extract-curate', harness: 'claude-code',
                  instruction: 'Return a report.', instructions: null, timeoutSeconds: 60, runToken: 'fixture',
                  credentialEnv: {}, profile: STUB_PROFILE } });
            }
            if (url.pathname === '/worker/end') {
              expect(pending).toBe(true);
              active = false; ended = true; events.push('ended');
              return answer({ persisted: true, ended: true });
            }
            return answer({ persisted: true });
          }) as typeof fetch,
        });
        expect(outcome).toMatchObject({ driven: 1, refused: null, replaced: true });
        expect(contacts).toBe(2);
        expect(events).toEqual(['claim-started', 'requested', 'ended', 'claim-completed', 'delivered', 'restart']);
      } finally { clearInterval(timer); stopping.abort(); }
    } finally {
      restore();
      for (const name of Object.keys(process.env)) if (!(name in before)) delete process.env[name];
      Object.assign(process.env, before);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('holds claims during restart health verification while continuing authenticated contact', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-runner-update-hold-'));
    const stopping = new AbortController();
    let contacts = 0, claims = 0;
    try {
      const outcome = await runWorker({
        serverUrl: 'https://update-hold.invalid', token: 'fixture', lockDir: null,
        runRoot: path.join(root, 'runs'), only: [], signal: stopping.signal, pollIdleMs: 1, log: () => {},
        onIdle: async () => { if (contacts === 3) stopping.abort(); return 'hold'; },
        fetchImpl: (async input => {
          if (new URL(String(input)).pathname === '/worker/claim') claims++;
          else contacts++;
          return answer({ persisted: true });
        }) as typeof fetch,
      });
      expect(outcome).toEqual({ driven: 0, refused: null });
      expect(contacts).toBe(3);
      expect(claims).toBe(0);
    } finally { stopping.abort(); fs.rmSync(root, { recursive: true, force: true }); }
  });
  it('keeps a paused runner in contact without asking for work', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-runner-paused-contact-'));
    const stopping = new AbortController();
    let contacts = 0, claims = 0;
    try {
      const outcome = await runWorker({
        serverUrl: 'https://paused.invalid', token: 'fixture', lockDir: null,
        deploymentId: 'dep_fixture', compatibilityPath: RUNNER_CONTACT_PATH,
        runRoot: path.join(root, 'runs'), only: [], signal: stopping.signal, pollIdleMs: 1, log: () => {},
        contactBody: () => ({}),
        fetchImpl: (async (input, init) => {
          if (new URL(String(input)).pathname === '/worker/claim') claims++;
          else {
            expect(JSON.parse(String(init?.body))).toMatchObject({ availability: 'ready', arch: process.arch });
            if (++contacts === 3) stopping.abort();
          }
          return answer({ persisted: true, runner: { deploymentId: 'dep_fixture', state: 'paused' } });
        }) as typeof fetch,
      });
      expect(outcome).toEqual({ driven: 0, refused: null });
      expect({ contacts, claims }).toEqual({ contacts: 3, claims: 0 });
    } finally { stopping.abort(); fs.rmSync(root, { recursive: true, force: true }); }
  });

});
