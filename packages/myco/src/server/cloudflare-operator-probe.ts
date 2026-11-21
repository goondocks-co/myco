/** Node performs local/global package discovery without starting npm's CLI or cache writer. */
export const OPERATOR_WRANGLER_PROBE = String.raw`
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const [cwd, npmEntry] = process.argv.slice(1);
async function discover() {
  const candidates = [];
  const local = createRequire(path.join(cwd, 'package.json'));
  try { candidates.push(local.resolve('wrangler/package.json')); }
  catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
  if (npmEntry) {
    const fromNpm = createRequire(npmEntry);
    const Config = fromNpm('@npmcli/config');
    const definitions = fromNpm('@npmcli/config/lib/definitions');
    const config = new Config({ ...definitions, npmPath: path.dirname(path.dirname(npmEntry)), cwd, argv: [process.execPath, npmEntry] });
    await config.load();
    candidates.push(path.join(config.globalPrefix, ...(process.platform === 'win32' ? [] : ['lib']), 'node_modules', 'wrangler', 'package.json'));
  }
  const search = process.env.PATH || process.env.Path || '';
  for (const folder of search.split(path.delimiter)) {
    for (const name of process.platform === 'win32' ? ['wrangler.cmd', 'wrangler'] : ['wrangler']) {
      const launcher = path.join(folder, name);
      if (!fs.existsSync(launcher)) continue;
      const entry = fs.realpathSync(launcher);
      candidates.push(path.join(path.dirname(entry), '..', 'package.json'), path.join(folder, 'node_modules', 'wrangler', 'package.json'));
    }
  }
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (pkg.name !== 'wrangler') continue;
    const relative = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.wrangler;
    if (!relative) throw new Error('Installed Wrangler declares no executable');
    const entry = path.resolve(path.dirname(file), relative);
    if (!fs.existsSync(entry)) throw new Error('Installed Wrangler executable is missing at ' + entry);
    process.stdout.write(JSON.stringify({ entry }));
    return;
  }
  process.stdout.write(JSON.stringify({ entry: null }));
}
discover().catch(error => { process.stderr.write('Operator Wrangler discovery failed: ' + (error.code || error.message)); process.exitCode = 1; });
`;
