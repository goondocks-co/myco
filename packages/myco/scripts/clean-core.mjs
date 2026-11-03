// Remove dist/src and JavaScript build output while retaining other dist assets.
import nodeFs from 'node:fs';
const { readdirSync, rmSync, existsSync } = nodeFs;
import path from 'node:path';

const dist = path.resolve('dist');
if (!existsSync(dist)) process.exit(0);

rmSync(path.join(dist, 'src'), { recursive: true, force: true });
for (const entry of readdirSync(dist, { withFileTypes: true })) {
  if (!entry.isFile()) continue;
  if (entry.name.endsWith('.js') || entry.name.endsWith('.js.map')) {
    rmSync(path.join(dist, entry.name), { force: true });
  }
}
