import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const image = process.argv[2] ?? 'myco-server:native';
const root = process.env.MYCO_SMOKE_MUTATION_ROOT;
if (!root) throw new Error('MYCO_SMOKE_MUTATION_ROOT must name a disposable scratch directory');

const mutations = [
  {
    name: 'clear-data',
    dockerfile: `FROM ${image}\nRUN printf '#!/bin/sh\\nrm -f /data/myco.sqlite /data/myco.sqlite-wal /data/myco.sqlite-shm\\nexec /app/docker-entrypoint.sh "$@"\\n' > /app/clear-entrypoint.sh && chmod +x /app/clear-entrypoint.sh\nENTRYPOINT ["/app/clear-entrypoint.sh"]\nCMD ["bun", "run", "/app/server.js"]\n`,
    refusal: /HTTP 401, expected 200/,
  },
  { name: 'move-blobs', dockerfile: `FROM ${image}\nENV MYCO_BLOB_DIR=/tmp/blobs\n`, refusal: /HTTP 404, expected 200/ },
  { name: 'ignore-volume', dockerfile: `FROM ${image}\nENV MYCO_DATABASE=/tmp/myco.sqlite MYCO_BLOB_DIR=/tmp/blobs\n`, refusal: /HTTP 401, expected 200/ },
];

for (const mutation of mutations) {
  const tag = `myco-server:ci-${mutation.name}-${randomUUID().slice(0, 8)}`;
  const buildDir = mkdtempSync(join(root, `${mutation.name}-build-`));
  const dockerfile = join(buildDir, 'Dockerfile');
  writeFileSync(dockerfile, mutation.dockerfile);
  const built = spawnSync('docker', ['build', '-f', dockerfile, '-t', tag, buildDir], {
    encoding: 'utf8', timeout: 120_000,
  });
  if (built.status !== 0) throw new Error(`${mutation.name} image build failed: ${built.stderr || built.stdout}`);
  const dataDir = mkdtempSync(join(root, `${mutation.name}-`));
  chmodSync(dataDir, 0o777);
  const checked = spawnSync('node', ['scripts/smoke-container-persistence.mjs', image, tag], {
    env: { ...process.env, MYCO_SMOKE_DATA_DIR: dataDir }, encoding: 'utf8', timeout: 120_000,
  });
  const output = `${checked.stdout ?? ''}${checked.stderr ?? ''}`;
  if (checked.status === 0 || !mutation.refusal.test(output)) {
    throw new Error(`${mutation.name} was not refused for lost data: ${output}`);
  }
  process.stdout.write(`${mutation.name}: preservation smoke refused missing data\n`);
}
