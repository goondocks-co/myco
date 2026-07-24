/*
 * Copyright 2026 Myco Contributors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import net, { type Server } from 'node:net';

const activeProofs = new WeakSet<object>();
declare const loopbackPortReleaseProofBrand: unique symbol;

export interface LoopbackPortReleaseProof {
  readonly proxyPort: number;
  readonly [loopbackPortReleaseProofBrand]: true;
}

function listen(host: string, port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen({ host, port, exclusive: true }, () => {
      server.removeListener('error', reject);
      resolve(server);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function ipv6LoopbackAvailable(): Promise<boolean> {
  try {
    const probe = await listen('::1', 0);
    await close(probe);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EADDRNOTAVAIL') return false;
    throw error;
  }
}

/**
 * Hold every available loopback binding for `proxyPort` while a caller
 * publishes claim removal. Successful exclusive binds prove no IPv4, IPv6, or
 * wildcard listener still owns the configured outbound-proxy port.
 */
export async function withLoopbackPortReleaseProof<T>(
  proxyPort: number,
  fn: (proof: LoopbackPortReleaseProof) => T | Promise<T>,
): Promise<T> {
  const servers: Server[] = [];
  try {
    try {
      servers.push(await listen('127.0.0.1', proxyPort));
      if (await ipv6LoopbackAvailable()) servers.push(await listen('::1', proxyPort));
    } catch (error) {
      throw new Error(
        `Proxy port ${proxyPort} is still bound on a loopback endpoint; its reservation remains active.`,
        { cause: error },
      );
    }
    const proof = { proxyPort } as LoopbackPortReleaseProof;
    activeProofs.add(proof);
    try {
      return await fn(proof);
    } finally {
      activeProofs.delete(proof);
    }
  } finally {
    await Promise.allSettled(servers.map(close));
  }
}

export function assertLoopbackPortReleaseProof(
  proof: LoopbackPortReleaseProof,
  proxyPort: number,
): void {
  if (!activeProofs.has(proof) || proof.proxyPort !== proxyPort) {
    throw new Error(`Invalid or inactive loopback release proof for proxy port ${proxyPort}.`);
  }
}
