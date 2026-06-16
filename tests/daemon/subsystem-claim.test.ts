import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  claimSubsystem,
  releaseSubsystemClaim,
  isClaimedByPeer,
  SYMBIONT_CONFIG_SUBSYSTEM,
} from '@myco/daemon/subsystem-claim.js';

// The general subsystem-claim primitive: a daemon writes a claim into the
// shared ~/.myco area; a peer defers while a LIVE claim by another variant
// exists; a dead owner's claim is stale (no lockout); inert with no claim.

describe('subsystem-claim', () => {
  let mycoHome: string;
  beforeEach(() => { mycoHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-claim-')); });
  afterEach(() => { fs.rmSync(mycoHome, { recursive: true, force: true }); });

  const alive = () => true;
  const dead = () => false;

  it('no claim → peer is not deferred (inert)', () => {
    expect(isClaimedByPeer(SYMBIONT_CONFIG_SUBSYSTEM, 'service', { mycoHome, isAlive: alive })).toBe(false);
  });

  it('a LIVE claim by a different variant defers the peer', () => {
    claimSubsystem(SYMBIONT_CONFIG_SUBSYSTEM, 'service-dev', { mycoHome, pid: 4242 });
    expect(isClaimedByPeer(SYMBIONT_CONFIG_SUBSYSTEM, 'service', { mycoHome, isAlive: alive })).toBe(true);
  });

  it("the owner's own claim never defers the owner", () => {
    claimSubsystem(SYMBIONT_CONFIG_SUBSYSTEM, 'service-dev', { mycoHome, pid: 4242 });
    expect(isClaimedByPeer(SYMBIONT_CONFIG_SUBSYSTEM, 'service-dev', { mycoHome, isAlive: alive })).toBe(false);
  });

  it('a claim whose owner pid is DEAD is stale → no deferral, no lockout', () => {
    claimSubsystem(SYMBIONT_CONFIG_SUBSYSTEM, 'service-dev', { mycoHome, pid: 4242 });
    expect(isClaimedByPeer(SYMBIONT_CONFIG_SUBSYSTEM, 'service', { mycoHome, isAlive: dead })).toBe(false);
  });

  it('only the owner variant can release a claim', () => {
    claimSubsystem(SYMBIONT_CONFIG_SUBSYSTEM, 'service-dev', { mycoHome, pid: 4242 });

    // A peer cannot release the dev daemon's claim.
    releaseSubsystemClaim(SYMBIONT_CONFIG_SUBSYSTEM, 'service', { mycoHome });
    expect(isClaimedByPeer(SYMBIONT_CONFIG_SUBSYSTEM, 'service', { mycoHome, isAlive: alive })).toBe(true);

    // The owner releases it → free.
    releaseSubsystemClaim(SYMBIONT_CONFIG_SUBSYSTEM, 'service-dev', { mycoHome });
    expect(isClaimedByPeer(SYMBIONT_CONFIG_SUBSYSTEM, 'service', { mycoHome, isAlive: alive })).toBe(false);
  });

  it('claim is idempotent — re-claiming just refreshes the marker', () => {
    claimSubsystem(SYMBIONT_CONFIG_SUBSYSTEM, 'service-dev', { mycoHome, pid: 4242, now: () => 1000 });
    claimSubsystem(SYMBIONT_CONFIG_SUBSYSTEM, 'service-dev', { mycoHome, pid: 4242, now: () => 2000 });
    const raw = JSON.parse(fs.readFileSync(path.join(mycoHome, 'claims', SYMBIONT_CONFIG_SUBSYSTEM + '.json'), 'utf-8'));
    expect(raw.claimed_at).toBe(2000);
    expect(raw.owner).toBe('service-dev');
  });
});
