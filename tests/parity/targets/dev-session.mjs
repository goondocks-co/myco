import { createRequire } from 'node:module';
import { inspect } from 'node:util';
import path from 'node:path';
import { once } from 'node:events';

const require = createRequire(process.argv[2]);
const { unstable_DevEnv, unstable_splitSqlQuery } = require('wrangler');
const workers = new Map();
const DISCONNECT_DISPOSAL_TIMEOUT_MS = 10_000;

async function command(message) {
  const { id, op, tag, config, persist, vars } = message;
  try {
    if (op === 'start') {
      const bindings = Object.fromEntries(Object.entries(vars).map(([name, value]) => [name, { type: 'plain_text', value }]));
      const dev = new unstable_DevEnv();
      dev.on('error', error => console.error(inspect(error, { depth: 8 })));
      const loaded = once(dev, 'reloadComplete');
      const [worker] = await Promise.all([dev.startWorker({
        config, bindings,
        build: { tsconfig: path.resolve(path.dirname(process.argv[2]), '..', '..', 'tsconfig.json') },
        dev: {
          remote: false, watch: false, registry: undefined, inspector: false,
          server: { hostname: '127.0.0.1', port: 0 }, persist,
          logLevel: 'debug', testScheduled: true,
          structuredLogsHandler: log => console.log(JSON.stringify(log)),
        },
      }).then(worker => { workers.set(tag, worker); return worker; }), loaded]);
      const runtime = worker.raw.runtimes.find(runtime => runtime.mf !== undefined);
      if (!runtime?.mf) throw new Error('Wrangler provided no local UserWorker runtime');
      const url = (await runtime.mf.ready).origin;
      // Binding reloads must preserve the listener advertised to callback work.
      const setOptions = runtime.mf.setOptions.bind(runtime.mf);
      runtime.mf.setOptions = options => setOptions({ ...options, port: Number(new URL(url).port) });
      const [, reloaded] = await Promise.all([
        worker.patchConfig({ bindings: { ...bindings, MYCO_ORIGIN: { type: 'plain_text', value: url } } }),
        once(dev, 'reloadComplete'),
      ]);
      const currentUrl = (await runtime.mf.ready).origin;
      if (currentUrl !== url) throw new Error(`UserWorker listener changed from its configured origin ${url} to ${currentUrl}`);
      process.send({ id, url: currentUrl, headers: reloaded[0].proxyData.headers });
    } else if (op === 'sql') {
      const worker = workers.get(tag);
      const mf = worker?.raw.runtimes.find(runtime => runtime.mf !== undefined)?.mf;
      if (!mf) throw new Error(`No live local D1 runtime for ${tag}`);
      const database = await mf.getD1Database('MYCO_DB');
      const results = await database.batch(unstable_splitSqlQuery(message.sql).map(sql => database.prepare(sql)));
      process.send({ id, results });
    } else if (op === 'stop') {
      await workers.get(tag)?.dispose();
      workers.delete(tag);
      process.send({ id });
    } else if (op === 'close') {
      await Promise.all([...workers.values()].map(worker => worker.dispose()));
      workers.clear();
      process.send({ id });
      process.disconnect();
    } else throw new Error(`Unknown parity dev operation: ${op}`);
  } catch (error) {
    console.error(inspect(error, { depth: 8 }));
    process.send({ id, error: error instanceof Error ? error.stack : inspect(error, { depth: 8 }) });
  }
}

// Lifecycle operations complete in order; paired Deployments share this process and retain separate runtimes.
let pending = Promise.resolve();
process.on('message', message => { pending = pending.then(() => command(message)); });
process.on('disconnect', async () => {
  const deadline = setTimeout(() => {
    if (process.platform === 'win32') process.exit(1);
    else process.kill(-process.pid, 'SIGKILL');
  }, DISCONNECT_DISPOSAL_TIMEOUT_MS);
  try { await Promise.all([...workers.values()].map(worker => worker.dispose())); }
  catch (error) { console.error('Wrangler dev disconnected disposal failed:', inspect(error, { depth: 8 })); process.exitCode = 1; }
  finally { clearTimeout(deadline); process.exit(); }
});
