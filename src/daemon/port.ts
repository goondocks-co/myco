import { createHash } from 'node:crypto';
import net from 'node:net';

export const PORT_RANGE_START = 19200;
export const PORT_RANGE_SIZE = 10000;
const PORT_RETRY_COUNT = 10;

/** Derive a deterministic port from a vault path. */
export function derivePort(vaultPath: string): number {
  const hash = createHash('md5').update(vaultPath).digest();
  const num = hash.readUInt16LE(0);
  return PORT_RANGE_START + (num % PORT_RANGE_SIZE);
}

/** Resolve the port to bind: try config port, derive from path, or fall back to ephemeral. */
export async function resolvePort(
  configPort: number | null,
  vaultPath: string,
): Promise<number> {
  const basePort = configPort ?? derivePort(vaultPath);

  for (let offset = 0; offset < PORT_RETRY_COUNT; offset++) {
    const candidate = basePort + offset;
    if (candidate > 65535) break;
    if (await isPortAvailable(candidate)) return candidate;
  }

  // All candidates taken — fall back to ephemeral
  return 0;
}

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
}
