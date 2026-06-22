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
  resolveClaimsHome,
  SYMBIONT_CONFIG_SUBSYSTEM,
} from '@myco/daemon/subsystem-claim.js';
import { daemonIdentity } from '@myco/grove/paths.js';

// The subsystem-claim primitive: an operator writes a durable claim into the
// shared claims area; a peer defers while a DIFFERENT owner token holds the
// subsystem; the claim stands until explicitly released (no process-liveness
// expiry); inert with no claim. The owner token is the owning daemon's home
// path (daemonIdentity) — two installs in two homes are two distinct owners.
//
// Claims are stored under resolveClaimsHome()/claims/, which defaults to
// MYCO_HOME so the test sandbox stays hermetic. Two daemons with different
// homes share claims when MYCO_CLAIMS_HOME is set to a common path.

const MYCO_HOME_ENV = 'MYCO_HOME';
const MYCO_CLAIMS_HOME_ENV = 'MYCO_CLAIMS_HOME';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function makeTmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function withEnv(key: string, value: string | undefined, fn: () => void): void {
  const prev = process.env[key];
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
  cleanups.push(() => {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  });
  fn();
}

describe('subsystem-claim', () => {
  let claimsHome: string;
  // Two home identities standing in for the production install and a dogfood
  // install sharing one machine's claims area.
  let prodOwner: string;
  let dogfoodOwner: string;

  beforeEach(() => {
    claimsHome = makeTmpDir('myco-claim-');
    prodOwner = daemonIdentity(path.join(os.homedir(), '.myco'));
    dogfoodOwner = daemonIdentity(path.join(os.homedir(), '.myco-dev'));
  });

  it('no claim → peer is not deferred (inert)', () => {
    expect(isClaimedByPeer(SYMBIONT_CONFIG_SUBSYSTEM, prodOwner, { claimsHome })).toBe(false);
  });

  it('a claim by a different home defers the peer', () => {
    claimSubsystem(SYMBIONT_CONFIG_SUBSYSTEM, dogfoodOwner, { claimsHome, pid: 4242 });
    expect(isClaimedByPeer(SYMBIONT_CONFIG_SUBSYSTEM, prodOwner, { claimsHome })).toBe(true);
  });

  it('two distinct homes are distinct owners', () => {
    expect(prodOwner).not.toBe(dogfoodOwner);
  });

  it("the owner's own claim never defers the owner", () => {
    claimSubsystem(SYMBIONT_CONFIG_SUBSYSTEM, dogfoodOwner, { claimsHome, pid: 4242 });
    expect(isClaimedByPeer(SYMBIONT_CONFIG_SUBSYSTEM, dogfoodOwner, { claimsHome })).toBe(false);
  });

  it('the claim is durable — it stands until released, regardless of the claiming pid', () => {
    // pid is informational only; the claim does NOT expire when that process
    // exits. Only an explicit release frees it.
    claimSubsystem(SYMBIONT_CONFIG_SUBSYSTEM, dogfoodOwner, { claimsHome, pid: 4242 });
    expect(isClaimedByPeer(SYMBIONT_CONFIG_SUBSYSTEM, prodOwner, { claimsHome })).toBe(true);
  });

  it('only the owner home can release a claim', () => {
    claimSubsystem(SYMBIONT_CONFIG_SUBSYSTEM, dogfoodOwner, { claimsHome, pid: 4242 });

    // A peer cannot release the dogfood daemon's claim.
    releaseSubsystemClaim(SYMBIONT_CONFIG_SUBSYSTEM, prodOwner, { claimsHome });
    expect(isClaimedByPeer(SYMBIONT_CONFIG_SUBSYSTEM, prodOwner, { claimsHome })).toBe(true);

    // The owner releases it → free.
    releaseSubsystemClaim(SYMBIONT_CONFIG_SUBSYSTEM, dogfoodOwner, { claimsHome });
    expect(isClaimedByPeer(SYMBIONT_CONFIG_SUBSYSTEM, prodOwner, { claimsHome })).toBe(false);
  });

  it('claim is idempotent — re-claiming just refreshes the marker', () => {
    claimSubsystem(SYMBIONT_CONFIG_SUBSYSTEM, dogfoodOwner, { claimsHome, pid: 4242, now: () => 1000 });
    claimSubsystem(SYMBIONT_CONFIG_SUBSYSTEM, dogfoodOwner, { claimsHome, pid: 4242, now: () => 2000 });
    const raw = readClaim(SYMBIONT_CONFIG_SUBSYSTEM, claimsHome);
    expect(raw?.claimed_at).toBe(2000);
    expect(raw?.owner).toBe(dogfoodOwner);
  });

  it('readClaim returns null when no claim exists', () => {
    expect(readClaim(SYMBIONT_CONFIG_SUBSYSTEM, claimsHome)).toBeNull();
  });

  it('listSubsystemClaims enumerates active claims', () => {
    expect(listSubsystemClaims({ claimsHome })).toEqual([]);
    claimSubsystem(SYMBIONT_CONFIG_SUBSYSTEM, dogfoodOwner, { claimsHome, pid: 4242, now: () => 1000 });
    const claims = listSubsystemClaims({ claimsHome });
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      subsystem: SYMBIONT_CONFIG_SUBSYSTEM,
      owner: dogfoodOwner,
      pid: 4242,
      claimed_at: 1000,
    });
  });
});

describe('resolveClaimsHome — hermeticity', () => {
  it('defaults to MYCO_HOME (sandbox), not the real home dir', () => {
    const sandbox = makeTmpDir('myco-claims-hermetic-');
    withEnv(MYCO_HOME_ENV, sandbox, () => {
      withEnv(MYCO_CLAIMS_HOME_ENV, undefined, () => {
        const resolved = resolveClaimsHome();
        // Must be the sandbox, not os.homedir()/.myco
        expect(resolved).toBe(sandbox);
        expect(resolved).not.toContain(os.homedir() + path.sep + '.myco');
      });
    });
  });

  it('claims written without MYCO_CLAIMS_HOME stay under the sandbox MYCO_HOME', () => {
    const sandbox = makeTmpDir('myco-claims-write-');
    withEnv(MYCO_HOME_ENV, sandbox, () => {
      withEnv(MYCO_CLAIMS_HOME_ENV, undefined, () => {
        const owner = daemonIdentity(sandbox);
        claimSubsystem(SYMBIONT_CONFIG_SUBSYSTEM, owner, { claimsHome: resolveClaimsHome() });
        const claimFile = path.join(sandbox, 'claims', `${SYMBIONT_CONFIG_SUBSYSTEM}.json`);
        expect(fs.existsSync(claimFile)).toBe(true);
        expect(claimFile.startsWith(sandbox)).toBe(true);
      });
    });
  });
});

describe('cross-daemon sharing via MYCO_CLAIMS_HOME', () => {
  it('daemon B sees daemon A claim when both share MYCO_CLAIMS_HOME', () => {
    const homeA = makeTmpDir('myco-home-a-');
    const homeB = makeTmpDir('myco-home-b-');
    const shared = makeTmpDir('myco-claims-shared-');

    const ownerA = daemonIdentity(homeA);
    const ownerB = daemonIdentity(homeB);

    // Daemon A claims symbiont-config in the shared area.
    claimSubsystem(SYMBIONT_CONFIG_SUBSYSTEM, ownerA, { claimsHome: shared });

    // Daemon B (different home, same shared claims dir) sees A's claim as a peer claim.
    expect(isClaimedByPeer(SYMBIONT_CONFIG_SUBSYSTEM, ownerB, { claimsHome: shared })).toBe(true);

    // Daemon A sees its OWN claim as NOT a peer claim.
    expect(isClaimedByPeer(SYMBIONT_CONFIG_SUBSYSTEM, ownerA, { claimsHome: shared })).toBe(false);

    // Cleanup
    releaseSubsystemClaim(SYMBIONT_CONFIG_SUBSYSTEM, ownerA, { claimsHome: shared });
    expect(readClaim(SYMBIONT_CONFIG_SUBSYSTEM, shared)).toBeNull();
  });

  it('daemon B cannot see daemon A claim when each uses its own home (no sharing)', () => {
    const homeA = makeTmpDir('myco-home-noshr-a-');
    const homeB = makeTmpDir('myco-home-noshr-b-');

    const ownerA = daemonIdentity(homeA);
    const ownerB = daemonIdentity(homeB);

    // Daemon A claims into its own home — no shared MYCO_CLAIMS_HOME.
    claimSubsystem(SYMBIONT_CONFIG_SUBSYSTEM, ownerA, { claimsHome: homeA });

    // Daemon B checks its own home — claim is not there.
    expect(isClaimedByPeer(SYMBIONT_CONFIG_SUBSYSTEM, ownerB, { claimsHome: homeB })).toBe(false);

    // Cleanup
    releaseSubsystemClaim(SYMBIONT_CONFIG_SUBSYSTEM, ownerA, { claimsHome: homeA });
  });
});
