import { describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from '../support/fenced-fs.mjs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { HARNESSES, credentialFile, offerable } from '@myco/runner/harnesses.js';
import { runWorker } from '@myco/runner/loop.js';
import { HARNESS_DETECTION_TTL_MS } from '@myco/runner/detect.js';
import { EXECUTION_PROFILE_FEATURE, MODEL_CATALOG_FEATURE } from '@goondocks/myco-shared/execution-profile';
import { FEATURES_HEADER } from '@goondocks/myco-shared/member-protocol';
import { stubProfileHarness } from '../helpers/stub-profile-harness.js';
import { removeWhenTestsEnd } from '../support/remove-when-tests-end.js';

const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

describe('live worker offers', () => {
  it('awaits model-listing disposal before releasing the worker attachment', async () => {
    const path = process.env.PATH;
    const root = removeWhenTestsEnd(mkdtempSync(join(tmpdir(), 'myco-listing-shutdown-')));
    stubProfileHarness();
    let disposed = false;
    const stopping = new AbortController();
    try {
      await runWorker({
        serverUrl: 'https://fixture.invalid', token: 'fixture', lockDir: null, runRoot: root, only: ['claude-code'], pollIdleMs: 1,
        signal: stopping.signal, log: () => {},
        listModels: (_ids, signal) => new Promise((resolve) => {
          signal.addEventListener('abort', () => { setTimeout(() => { disposed = true; resolve([]); }, 20); }, { once: true });
        }),
        fetchImpl: (async (input) => {
          if (new URL(String(input)).pathname === '/worker/claim') stopping.abort();
          return Response.json({ persisted: true, claimed: false, reason: 'no_work' }, {
            headers: { [FEATURES_HEADER]: [EXECUTION_PROFILE_FEATURE, MODEL_CATALOG_FEATURE].join(',') },
          });
        }) as typeof fetch,
      });
      expect(disposed).toBe(true);
    } finally { stopping.abort(); process.env.PATH = path; }
  });

  for (const harness of HARNESSES.filter(offerable)) {
    it(`${harness.id} follows installation and login changes without restarting`, async () => {
      const root = removeWhenTestsEnd(mkdtempSync(join(tmpdir(), 'myco-live-offer-')));
      const home = join(root, 'home');
      const bin = join(root, 'bin');
      mkdirSync(home); mkdirSync(bin);
      const before = { ...process.env };
      Object.assign(process.env, { HOME: home, CODEX_HOME: join(home, '.codex'), CLAUDE_CONFIG_DIR: join(home, '.claude'), MYCO_HOME: join(home, '.myco'), PATH: `${bin}:/usr/bin:/bin` });
      const binary = join(bin, harness.binary);
      const marker = join(root, 'logged-in');
      const login = credentialFile(harness);
      const offers: Array<{ installed: boolean; authenticated: boolean }> = [];
      const catalogSets: string[][] = [];
      const stop = new AbortController();
      const install = () => writeFileSync(binary, `#!/bin/sh\n[ -f ${quote(marker)} ]\n`, { mode: 0o755 });
      const authenticate = () => {
        writeFileSync(marker, 'fixture');
        if (login !== null && harness.credential.kind !== 'command') {
          mkdirSync(dirname(login), { recursive: true });
          writeFileSync(login, JSON.stringify({ [harness.credential.requires[0] ?? 'fixture']: 'synthetic-login' }));
        }
      };
      let claims = 0;
      let now = 0;
      const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        if (path === '/worker/claim') {
          const body = JSON.parse(String(init?.body)) as { harnesses: Array<{ id: string; installed: boolean; authenticated: boolean }> };
          const offered = body.harnesses.find((h) => h.id === harness.id)!;
          offers.push({ installed: offered.installed, authenticated: offered.authenticated });
          claims += 1;
          now += HARNESS_DETECTION_TTL_MS;
          if (claims === 1) install();
          if (claims === 2) authenticate();
          if (claims === 3) { rmSync(marker); if (login !== null && existsSync(login)) rmSync(login); }
          if (claims === 4) rmSync(binary);
          if (claims === 5) { install(); authenticate(); }
          if (claims === 6) stop.abort();
        }
        return Response.json({ persisted: true, claimed: false, reason: 'no_work', pollAfterMs: 5 }, {
          headers: { [FEATURES_HEADER]: [EXECUTION_PROFILE_FEATURE, MODEL_CATALOG_FEATURE].join(',') },
        });
      }) as typeof fetch;
      try {
        await runWorker({ serverUrl: 'https://fixture.invalid', token: 'fixture', lockDir: null, runRoot: join(root, 'runs'), only: [harness.id], pollIdleMs: 5, log: () => {}, fetchImpl, signal: stop.signal,
          clock: () => now,
          listModels: async (ids) => { catalogSets.push([...ids]); return []; },
        });
        expect(offers).toEqual([
          { installed: false, authenticated: false }, { installed: true, authenticated: false },
          { installed: true, authenticated: true }, { installed: true, authenticated: false },
          { installed: false, authenticated: false }, { installed: true, authenticated: true },
        ]);
        expect(catalogSets).toEqual([[harness.id], [harness.id]]);
      } finally {
        stop.abort();
        for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key];
        Object.assign(process.env, before);
      }
    });
  }
});
