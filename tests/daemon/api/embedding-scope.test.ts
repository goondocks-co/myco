/**
 * Home-ownership gate on the embedding action endpoints' single-Grove arm.
 *
 * The body-scope `grove_id` arrives outside the request-context funnel, so
 * the handlers themselves must refuse foreign-home and unknown Groves
 * BEFORE the runtime cache opens the Grove DB and builds an embedding
 * runtime on it. Ownership is the home: a Grove under a different
 * MYCO_HOME is not present here, so `assertOwnedGrove` throws
 * UnknownGroveError, which the daemon transport maps to 404
 * grove_not_found.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DaemonLogger } from '@myco/daemon/logger.js';
import { GroveRuntimeCache } from '@myco/daemon/grove-runtime-cache.js';
import { createEmbeddingActionHandlers } from '@myco/daemon/api/embedding.js';
import type { EmbeddingManager } from '@myco/daemon/embedding/index.js';
import { ensureGroveDatabase } from '@myco/grove/database.js';
import { createGrove, UnknownGroveError } from '@myco/grove/registry.js';
import { resolveGroveDbPath, resolveGroveDir } from '@myco/grove/paths.js';
import type { RouteRequest } from '@myco/daemon/router.js';

function emptyRequest(body: unknown = undefined): RouteRequest {
  return { body, query: {}, params: {}, pathname: '/api/embeddings/clean-orphans' };
}

// Stub runtime: the gate must fire before the factory is ever invoked for
// foreign/unknown Groves; the owned-Grove path only needs an object shape.
function stubEmbeddingFactory() {
  return {
    vectorStore: undefined as never,
    embeddingManager: {
      cleanOrphans: () => ({ orphans_removed: 0 }),
    } as unknown as EmbeddingManager,
  };
}

describe('embedding scope-aware actions — home ownership gate', () => {
  let workDir: string;
  let mycoHome: string;
  let previousMycoHome: string | undefined;
  let previousVariant: string | undefined;
  let logger: DaemonLogger;
  let cache: GroveRuntimeCache;

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'embed-scope-'));
    mycoHome = path.join(workDir, 'home');
    fs.mkdirSync(mycoHome, { recursive: true });
    previousMycoHome = process.env.MYCO_HOME;
    process.env.MYCO_HOME = mycoHome;
    // Keep the daemon-variant env out of these cases (ownership is the
    // home now, not the variant); restore it in afterEach.
    previousVariant = process.env.MYCO_SERVICE_VARIANT;
    delete process.env.MYCO_SERVICE_VARIANT;
    logger = new DaemonLogger(path.join(workDir, 'logs'), { level: 'error' });
    cache = new GroveRuntimeCache();
  });

  afterEach(() => {
    cache.closeAll();
    if (previousMycoHome === undefined) delete process.env.MYCO_HOME;
    else process.env.MYCO_HOME = previousMycoHome;
    if (previousVariant === undefined) delete process.env.MYCO_SERVICE_VARIANT;
    else process.env.MYCO_SERVICE_VARIANT = previousVariant;
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  function makeHandlers() {
    return createEmbeddingActionHandlers({
      cache,
      embeddingRuntimeFactory: stubEmbeddingFactory,
      logger,
      resolveRequestRuntime: () => {
        throw new Error('kind=grove dispatch must not touch the request runtime');
      },
      daemonStateDir: path.join(mycoHome, 'service'),
      mycoHome,
    });
  }

  it('runs against a Grove owned by this daemon (same home)', async () => {
    const grove = createGrove('alpha', mycoHome);
    ensureGroveDatabase(grove.id, mycoHome);
    const handlers = makeHandlers();

    const res = await handlers.handleCleanOrphans(
      emptyRequest({ scope: { kind: 'grove', grove_id: grove.id } }),
    );

    const body = res.body as { results: Array<{ grove_id: string; ok: boolean }>; summary: { ok: number } };
    expect(body.results).toHaveLength(1);
    expect(body.results[0]!.grove_id).toBe(grove.id);
    expect(body.summary.ok).toBe(1);
  });

  it('refuses a Grove in another home before creating its DB or embedding runtime', async () => {
    // Two real homes: the Grove lives under home B but the handler owns
    // home A (`mycoHome`), so the home-scoped lookup returns null and
    // `assertOwnedGrove` throws UnknownGroveError. A no-op gate would open
    // the foreign DB and build a runtime on it.
    const foreignHome = path.join(workDir, 'home-B');
    fs.mkdirSync(foreignHome, { recursive: true });
    const grove = createGrove('dogfood', foreignHome);
    const handlers = makeHandlers();

    let caught: unknown;
    try {
      await handlers.handleCleanOrphans(
        emptyRequest({ scope: { kind: 'grove', grove_id: grove.id } }),
      );
    } catch (err) {
      caught = err;
    }
    // Thrown BEFORE wrapPerGroveResult, so the refusal is not swallowed
    // into an ok:false result row; the foreign DB was never opened.
    expect(caught).toBeInstanceOf(UnknownGroveError);
    expect(fs.existsSync(resolveGroveDbPath(grove.id, mycoHome))).toBe(false);
  });

  it('refuses an unknown Grove id without creating groves/<id>/ (RC-5)', async () => {
    const unknownId = 'grove_' + 'f'.repeat(32);
    const handlers = makeHandlers();

    let caught: unknown;
    try {
      await handlers.handleCleanOrphans(
        emptyRequest({ scope: { kind: 'grove', grove_id: unknownId } }),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UnknownGroveError);
    expect(fs.existsSync(resolveGroveDir(unknownId, mycoHome))).toBe(false);
  });
});
