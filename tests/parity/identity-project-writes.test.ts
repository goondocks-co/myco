import { afterAll, beforeAll, describe, expect, it, test } from 'bun:test';
import { bootSelfhosted } from './targets/selfhosted.ts';
import { bootCloudflare, stopCloudflareRuntime } from './targets/cloudflare.ts';
import { lit, type ParityTarget } from './harness.ts';
import { MAX_PROJECTS } from '@myco-server-worker/constants.js';

if (!process.env.MYCO_PARITY) {
  test.skip('identity and Project writes parity (run with MYCO_PARITY=1)', () => {});
} else {
  afterAll(stopCloudflareRuntime);
  for (const [name, boot] of [
    ['selfhosted', bootSelfhosted],
    ['cloudflare', bootCloudflare],
  ] as const) {
    describe(`[${name}] identity and Project writes`, () => {
      let target: ParityTarget;
      beforeAll(async () => {
        target = await boot();
      }, 240_000);
      afterAll(async () => {
        await target?.stop();
      });
      const request = async (path: string, method: string, body?: unknown) => {
        const response = await fetch(target.url + path, {
          method,
          headers: { ...target.ownerHeaders(), origin: target.url, 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: response.status, body: (await response.json()) as any };
      };

      it('unarchive shares capacity admission and returns project_limit until a slot is available', async () => {
        const base = `/api/projects/${target.projectId}`;
        expect((await request(base + '/archive', 'POST')).status).toBe(200);
        const count = Number((await target.sql('SELECT COUNT(*) AS n FROM projects WHERE archived_at IS NULL'))[0]!.n);
        await target.sql(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<${MAX_PROJECTS - count})
          INSERT INTO projects(project_id,name,created_at) SELECT 'capacity_parity_'||i,'Capacity',1 FROM n`);
        try {
          expect(await request(base + '/unarchive', 'POST')).toMatchObject({ status: 409, body: { error: 'project_limit' } });
          expect(
            (await target.sql(`SELECT archived_at FROM projects WHERE project_id=${lit(target.projectId)}`))[0]!.archived_at,
          ).not.toBeNull();
          await target.sql("DELETE FROM projects WHERE project_id='capacity_parity_1'");
          expect(await request(base + '/unarchive', 'POST')).toMatchObject({ status: 200, body: { archived: false } });
          expect(Number((await target.sql('SELECT COUNT(*) AS n FROM projects WHERE archived_at IS NULL'))[0]!.n)).toBe(MAX_PROJECTS);
        } finally {
          await target.sql("DELETE FROM projects WHERE project_id LIKE 'capacity_parity_%'");
        }
      });

      it('repository and release credential replacement roll back when retiring the old slot fails', async () => {
        for (const kind of ['repository', 'release-provenance'] as const) {
          const path = `/api/projects/${target.projectId}/${kind}`;
          const payload =
            kind === 'repository'
              ? {
                  url: 'https://github.com/example/parity.git',
                  branch: 'main',
                  credential: { username: 'reader', token: 'fixture-old-token' },
                }
              : {
                  enabled: true,
                  githubRepo: 'example/parity',
                  productionRefs: ['refs/tags/v*'],
                  integrationRefs: ['origin/main'],
                  packageMap: [],
                  includeUnknown: true,
                  maxLookups: 10,
                  credential: { token: 'fixture-old-token' },
                };
          const first = await request(path, 'PUT', { ...payload, revision: null });
          expect(first.status).toBe(200);
          const key = kind === 'repository' ? 'repository' : 'releaseProvenance';
          const revision = first.body[key].revision;
          const table = kind === 'repository' ? 'project_repositories' : 'project_release_provenance';
          const old = await target.sql(`SELECT revision,secret_slot FROM ${table} WHERE project_id=${lit(target.projectId)}`);
          const oldSecrets = await target.sql('SELECT name,ciphertext,iv FROM deployment_secrets ORDER BY name');
          await target.sql(
            "CREATE TRIGGER parity_fail_retire BEFORE DELETE ON deployment_secrets BEGIN SELECT RAISE(ABORT,'fixture retirement failure'); END",
          );
          try {
            const failed = await request(path, 'PUT', {
              ...payload,
              revision,
              credential: { ...payload.credential, token: 'fixture-new-token' },
            });
            expect(failed.status).toBe(503);
            expect(await target.sql(`SELECT revision,secret_slot FROM ${table} WHERE project_id=${lit(target.projectId)}`)).toEqual(old);
            expect(await target.sql('SELECT name,ciphertext,iv FROM deployment_secrets ORDER BY name')).toEqual(oldSecrets);
          } finally {
            await target.sql('DROP TRIGGER parity_fail_retire');
          }
          expect(
            (await request(path, 'PUT', { ...payload, revision, credential: { ...payload.credential, token: 'fixture-new-token' } }))
              .status,
          ).toBe(200);
          expect(await target.sql(`SELECT name FROM deployment_secrets WHERE name=${lit(String(old[0]!.secret_slot))}`)).toEqual([]);
        }
      });
    });
  }
}
