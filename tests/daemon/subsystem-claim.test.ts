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
import { daemonIdentity } from '@myco/grove/paths.js';

// The subsystem-claim primitive: an operator writes a durable claim into the
// shared ~/.myco area; a peer defers while a DIFFERENT owner token holds the
// subsystem; the claim stands until explicitly released (no process-liveness
// expiry); inert with no claim. The owner token is the owning daemon's home
// path (daemonIdentity) — two installs in two homes are two distinct owners.

describe('subsystem-claim', () => {
  let mycoHome: string;
  // Two home identities standing in for the production install and a dogfood
  // install sharing one machine's claims area.
  let prodOwner: string;
  let dogfoodOwner: string;

  beforeEach(() => {
    mycoHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-claim-'));
    prodOwner = daemonIdentity(path.join(os.homedir(), '.myco'));
    dogfoodOwner = daemonIdentity(path.join(os.homedir(), '.myco-dev'));
  });
  afterEach(() => { fs.rmSync(mycoHome, { recursive: true, force: true }); });

  it('no claim → peer is not deferred (inert)', () => {
    expect(isClaimedByPeer(SYMBIONT_CONFIG_SUBSYSTEM, prodOwner, { mycoHome })).toBe(false);
  });

  it('a claim by a different home defers the peer', () => {
    claimSubsystem(SYMBIONT_CONFIG_SUBSYSTEM, dogfoodOwner, { mycoHome, pid: 4242 });
    expect(isClaimedByPeer(SYMBIONT_CONFIG_SUBSYSTEM, prodOwner, { mycoHome })).toBe(true);
  });

  it('two distinct homes are distinct owners', () => {
    expect(prodOwner).not.toBe(dogfoodOwner);
  });

  it("the owner's own claim never defers the owner", () => {
    claimSubsystem(SYMBIONT_CONFIG_SUBSYSTEM, dogfoodOwner, { mycoHome, pid: 4242 });
    expect(isClaimedByPeer(SYMBIONT_CONFIG_SUBSYSTEM, dogfoodOwner, { mycoHome })).toBe(false);
  });

  it('the claim is durable — it stands until released, regardless of the claiming pid', () => {
    // pid is informational only; the claim does NOT expire when that process
    // exits. Only an explicit release frees it.
    claimSubsystem(SYMBIONT_CONFIG_SUBSYSTEM, dogfoodOwner, { mycoHome, pid: 4242 });
    expect(isClaimedByPeer(SYMBIONT_CONFIG_SUBSYSTEM, prodOwner, { mycoHome })).toBe(true);
  });

  it('only the owner home can release a claim', () => {
    claimSubsystem(SYMBIONT_CONFIG_SUBSYSTEM, dogfoodOwner, { mycoHome, pid: 4242 });

    // A peer cannot release the dogfood daemon's claim.
    releaseSubsystemClaim(SYMBIONT_CONFIG_SUBSYSTEM, prodOwner, { mycoHome });
    expect(isClaimedByPeer(SYMBIONT_CONFIG_SUBSYSTEM, prodOwner, { mycoHome })).toBe(true);

    // The owner releases it → free.
    releaseSubsystemClaim(SYMBIONT_CONFIG_SUBSYSTEM, dogfoodOwner, { mycoHome });
    expect(isClaimedByPeer(SYMBIONT_CONFIG_SUBSYSTEM, prodOwner, { mycoHome })).toBe(false);
  });

  it('claim is idempotent — re-claiming just refreshes the marker', () => {
    claimSubsystem(SYMBIONT_CONFIG_SUBSYSTEM, dogfoodOwner, { mycoHome, pid: 4242, now: () => 1000 });
    claimSubsystem(SYMBIONT_CONFIG_SUBSYSTEM, dogfoodOwner, { mycoHome, pid: 4242, now: () => 2000 });
    const raw = readClaim(SYMBIONT_CONFIG_SUBSYSTEM, mycoHome);
    expect(raw?.claimed_at).toBe(2000);
    expect(raw?.owner).toBe(dogfoodOwner);
  });

  it('readClaim returns null when no claim exists', () => {
    expect(readClaim(SYMBIONT_CONFIG_SUBSYSTEM, mycoHome)).toBeNull();
  });

  it('listSubsystemClaims enumerates active claims', () => {
    expect(listSubsystemClaims({ mycoHome })).toEqual([]);
    claimSubsystem(SYMBIONT_CONFIG_SUBSYSTEM, dogfoodOwner, { mycoHome, pid: 4242, now: () => 1000 });
    const claims = listSubsystemClaims({ mycoHome });
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      subsystem: SYMBIONT_CONFIG_SUBSYSTEM,
      owner: dogfoodOwner,
      pid: 4242,
      claimed_at: 1000,
    });
  });
});
