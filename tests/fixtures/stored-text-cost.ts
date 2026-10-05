import { agentProse } from '../../packages/myco-shared/src/run-text.js';
import { redactSecrets } from '../../packages/myco-shared/src/redact-secrets.js';

const mode = process.argv[2];
const timings: number[] = [];
if (mode === 'shared') {
  const chars = 1024 * 1024;
  for (const input of ['a-'.repeat(chars / 2), ' '.repeat(chars), '!'.repeat(chars) + 'x', 'token_budget: 1 '.repeat(Math.ceil(chars / 16)), 'token_budget: 1; '.repeat(Math.ceil(chars / 17))]) {
    const at = performance.now();
    agentProse(input, 4096, { singleLine: true });
    redactSecrets(input);
    timings.push(performance.now() - at);
  }
} else if (mode === 'route') {
  Bun.plugin({ name: 'cloudflare-workers-builtin', setup(build) {
    build.module('cloudflare:workers', () => ({ exports: { DurableObject: class {}, WorkerEntrypoint: class {} }, loader: 'object' }));
  } });
  const { configureSqliteLibrary } = await import('../../packages/myco-server/src/platform/bun/sqlite-library.js');
  configureSqliteLibrary();
  const { runRouteFixture } = await import('../myco-server/helpers/run-routes.js');
  const r = await runRouteFixture('agent_1');
  try {
    await r.post('/runs/claim', { id: 'r1', agentId: 'agent_1', task: 'container-smoke', capability: 'cortex' });
    for (const chars of [1024, 4096, 16_384, 65_536]) {
      const at = performance.now();
      const reply = await r.post('/runs/report', { runId: 'r1', agentId: 'agent_1', action: 'container-smoke', summary: 'Measured report.', details: 'a-'.repeat(chars / 2) });
      if (reply.recorded !== true) throw new Error('the measured report was not recorded');
      timings.push(performance.now() - at);
    }
    if (r.sqlite.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM agent_reports').get()?.count !== timings.length) throw new Error('the measured reports did not persist');
  } finally { r.sqlite.close(); }
} else throw new Error('unknown cost probe');
console.log(JSON.stringify({ mode, timings }));
