import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  claimSubsystem,
  releaseSubsystemClaim,
  isClaimedByPeer,
  listSubsystemClaims,
  readClaim,
  SYMBIONT_CONFIG_SUBSYSTEM,
} from '@myco/daemon/subsystem-claim.js';

// The subsystem-claim primitive: an operator writes a durable claim into the
// shared ~/.myco area; a peer defers while another variant owns the subsystem;
// the claim stands until explicitly released (no process-liveness expiry);
// inert with no claim.

describe('subsystem-claim', () => {
  let mycoHome: string;
  beforeEach(() => { mycoHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-claim-')); });
  afterEach(() => { fs.rmSync(mycoHome, { recursive: true, force: true }); });

  it('no claim → peer is not deferred (inert)', () => {
    expect(isClaimedByPeer(SYMBIONT_CONFIG_SUBSYSTEM, 'service', { mycoHome })).toBe(false);
  });

  it('a claim by a different variant defers the peer', () => {
    claimSubsystem(SYMBIONT_CONFIG_SUBSYSTEM, 'service-dev', { mycoHome, pid: 4242 });
    expect(isClaimedByPeer(SYMBIONT_CONFIG_SUBSYSTEM, 'service', { mycoHome })).toBe(true);
  });

  it("the owner's own claim never defers the owner", () => {
    claimSubsystem(SYMBIONT_CONFIG_SUBSYSTEM, 'service-dev', { mycoHome, pid: 4242 });
    expect(isClaimedByPeer(SYMBIONT_CONFIG_SUBSYSTEM, 'service-dev', { mycoHome })).toBe(false);
  });

  it('the claim is durable — it stands until released, regardless of the claiming pid', () => {
    // pid is informational only; the claim does NOT expire when that process
    // exits. Only an explicit release frees it.
    claimSubsystem(SYMBIONT_CONFIG_SUBSYSTEM, 'service-dev', { mycoHome, pid: 4242 });
    expect(isClaimedByPeer(SYMBIONT_CONFIG_SUBSYSTEM, 'service', { mycoHome })).toBe(true);
  });

  it('only the owner variant can release a claim', () => {
    claimSubsystem(SYMBIONT_CONFIG_SUBSYSTEM, 'service-dev', { mycoHome, pid: 4242 });

    // A peer cannot release the dev daemon's claim.
    releaseSubsystemClaim(SYMBIONT_CONFIG_SUBSYSTEM, 'service', { mycoHome });
    expect(isClaimedByPeer(SYMBIONT_CONFIG_SUBSYSTEM, 'service', { mycoHome })).toBe(true);

    // The owner releases it → free.
    releaseSubsystemClaim(SYMBIONT_CONFIG_SUBSYSTEM, 'service-dev', { mycoHome });
    expect(isClaimedByPeer(SYMBIONT_CONFIG_SUBSYSTEM, 'service', { mycoHome })).toBe(false);
  });

  it('claim is idempotent — re-claiming just refreshes the marker', () => {
    claimSubsystem(SYMBIONT_CONFIG_SUBSYSTEM, 'service-dev', { mycoHome, pid: 4242, now: () => 1000 });
    claimSubsystem(SYMBIONT_CONFIG_SUBSYSTEM, 'service-dev', { mycoHome, pid: 4242, now: () => 2000 });
    const raw = readClaim(SYMBIONT_CONFIG_SUBSYSTEM, mycoHome);
    expect(raw?.claimed_at).toBe(2000);
    expect(raw?.owner).toBe('service-dev');
  });

  it('readClaim returns null when no claim exists', () => {
    expect(readClaim(SYMBIONT_CONFIG_SUBSYSTEM, mycoHome)).toBeNull();
  });

  it('listSubsystemClaims enumerates active claims', () => {
    expect(listSubsystemClaims({ mycoHome })).toEqual([]);
    claimSubsystem(SYMBIONT_CONFIG_SUBSYSTEM, 'service-dev', { mycoHome, pid: 4242, now: () => 1000 });
    const claims = listSubsystemClaims({ mycoHome });
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      subsystem: SYMBIONT_CONFIG_SUBSYSTEM,
      owner: 'service-dev',
      pid: 4242,
      claimed_at: 1000,
    });
  });
});
