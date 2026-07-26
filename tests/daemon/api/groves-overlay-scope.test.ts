/**
 * A member reaching a Grove-listing route across the overlay must see only the
 * Grove its request resolved to — never the whole machine.
 *
 * The route-stamp gate classifies what a route IS. It cannot constrain what a
 * handler READS, so a handler that enumerates independently of `requestContext`
 * walks straight past it. `GET /api/groves` did exactly that: wired once at
 * startup with the daemon-wide scope, it handed any bearer-holding member every
 * Grove on the host plus every project's absolute checkout path.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createGrove } from '@myco/grove/registry.js';
import type { RouteRequest } from '@myco/daemon/router.js';
import {
  createListGrovesHandler,
  overlayGroveFilter,
  scopeForRequest,
  servedGroveScopeForDaemon,
  type GrovesResponse,
} from '@myco/daemon/api/groves.js';

let home: string;
let savedHome: string | undefined;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-overlay-scope-'));
  savedHome = process.env.MYCO_HOME;
  process.env.MYCO_HOME = home;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.MYCO_HOME;
  else process.env.MYCO_HOME = savedHome;
  fs.rmSync(home, { recursive: true, force: true });
});

function request(overrides: Partial<RouteRequest> = {}): RouteRequest {
  return {
    body: undefined,
    query: {},
    params: {},
    pathname: '/api/groves',
    ...overrides,
  };
}

async function listGroves(req: RouteRequest): Promise<GrovesResponse> {
  const handler = createListGrovesHandler(servedGroveScopeForDaemon(), path.join(home, 'state'));
  const res = await handler(req);
  return res.body as GrovesResponse;
}

describe('GET /api/groves — overlay scope narrowing', () => {
  test('a local request still sees every Grove on the machine', async () => {
    const served = createGrove('Served', home);
    const personal = createGrove('Personal', home);

    const body = await listGroves(request());

    const ids = body.groves.map((g) => g.id);
    expect(ids).toContain(served.id);
    expect(ids).toContain(personal.id);
  });

  test('an overlay request sees ONLY the Grove its request resolved to', async () => {
    const served = createGrove('Served', home);
    const personal = createGrove('Personal', home);

    const body = await listGroves(request({
      isOverlay: true,
      requestContext: { groveId: served.id } as RouteRequest['requestContext'],
    }));

    const ids = body.groves.map((g) => g.id);
    expect(ids).toEqual([served.id]);
    expect(ids).not.toContain(personal.id); // the operator's private Grove
  });

  test('an overlay request with no resolved Grove sees nothing, not everything', async () => {
    createGrove('Served', home);
    createGrove('Personal', home);

    const body = await listGroves(request({ isOverlay: true }));

    expect(body.groves).toEqual([]);
  });
});

describe('scope narrowing helpers', () => {
  test('scopeForRequest passes the daemon scope through for a local request', () => {
    const daemonScope = servedGroveScopeForDaemon();
    expect(scopeForRequest(daemonScope, request()).groveIds).toBeNull();
  });

  test('scopeForRequest pins an overlay request to its own Grove', () => {
    const scoped = scopeForRequest(servedGroveScopeForDaemon(), request({
      isOverlay: true,
      requestContext: { groveId: 'grove_abc' } as RouteRequest['requestContext'],
    }));
    expect(scoped.groveIds).toEqual(['grove_abc']);
  });

  test('overlayGroveFilter is inert locally and exact over the overlay', () => {
    expect(overlayGroveFilter(request())).toBeUndefined();

    const filter = overlayGroveFilter(request({
      isOverlay: true,
      requestContext: { groveId: 'grove_abc' } as RouteRequest['requestContext'],
    }));
    expect(filter?.({ id: 'grove_abc' })).toBe(true);
    expect(filter?.({ id: 'grove_other' })).toBe(false);
  });

  test('overlayGroveFilter admits nothing when the overlay request has no Grove', () => {
    const filter = overlayGroveFilter(request({ isOverlay: true }));
    expect(filter?.({ id: 'grove_abc' })).toBe(false);
  });
});
