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
import { describe, expect, test } from 'bun:test';
import net, { type Server } from 'node:net';

import {
  assertLoopbackPortReleaseProof,
  type LoopbackPortReleaseProof,
  withLoopbackPortReleaseProof,
} from '@myco/host/loopback-port-proof.js';

function listen(port = 0): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port }, () => resolve(server));
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function freeLoopbackPort(): Promise<number> {
  const server = await listen();
  const address = server.address();
  if (address === null || typeof address === 'string') {
    await close(server);
    throw new Error('Expected an IP listener address');
  }
  await close(server);
  return address.port;
}

describe('loopback port release proof', () => {
  test('is active only inside the callback and only for its port', async () => {
    const port = await freeLoopbackPort();
    let captured: LoopbackPortReleaseProof | undefined;

    await withLoopbackPortReleaseProof(port, (proof) => {
      captured = proof;
      expect(() => assertLoopbackPortReleaseProof(proof, port)).not.toThrow();
      expect(() => assertLoopbackPortReleaseProof(proof, port + 1)).toThrow(/Invalid or inactive/);
    });

    expect(captured).toBeDefined();
    expect(() => assertLoopbackPortReleaseProof(captured!, port)).toThrow(/Invalid or inactive/);
  });

  test('rejects while the port is occupied and does not invoke the callback', async () => {
    const server = await listen();
    const address = server.address();
    if (address === null || typeof address === 'string') {
      await close(server);
      throw new Error('Expected an IP listener address');
    }
    let invoked = false;
    try {
      await expect(withLoopbackPortReleaseProof(address.port, () => {
        invoked = true;
      })).rejects.toThrow(/reservation remains active/);
      expect(invoked).toBe(false);
    } finally {
      await close(server);
    }
  });

  test('releases every binding after a callback failure', async () => {
    const port = await freeLoopbackPort();

    await expect(withLoopbackPortReleaseProof(port, () => {
      throw new Error('callback failed');
    })).rejects.toThrow('callback failed');

    const server = await listen(port);
    await close(server);
  });
});
