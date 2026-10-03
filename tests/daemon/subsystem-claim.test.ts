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
  shouldDeferSubsystem,
  guardBySubsystemClaim,
  SYMBIONT_CONFIG_SUBSYSTEM,
} from '@myco/grove/subsystem-claim.js';
import { daemonIdentity } from '@myco/grove/paths.js';

// The subsystem-claim primitive: an operator writes a durable claim into the
// shared claims area; a peer defers while a DIFFERENT owner token holds the
// subsystem; the claim stands until explicitly released (no process-liveness
// expiry); inert with no claim. The owner token is the owning daemon's home
// path (daemonIdentity) — two installs in two homes are two distinct owners.
//
// Claims are stored under resolveClaimsHome()/claims/: the default home
// (`~/.myco` under the user's home dir), whatever MYCO_HOME says, so every home
// on a machine shares one claims area. The test preload sandboxes HOME, which
// keeps it hermetic.

const MYCO_HOME_ENV = 'MYCO_HOME';
const HOME_ENV = 'HOME';

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
  cleanups.push(() => {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  });
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
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

describe('resolveClaimsHome — one claims area per machine', () => {
  it('is the default home under the user\'s home dir, whatever MYCO_HOME or an old MYCO_CLAIMS_HOME says', () => {
    const userHome = makeTmpDir('myco-claims-userhome-');
    const memberHome = makeTmpDir('myco-claims-member-');
    withEnv(HOME_ENV, userHome, () => {
      withEnv(MYCO_HOME_ENV, memberHome, () => {
        withEnv('MYCO_CLAIMS_HOME', memberHome, () => {
          expect(resolveClaimsHome()).toBe(path.join(userHome, '.myco'));
        });
      });
    });
  });

  it('stays inside the sandboxed user home', () => {
    expect(resolveClaimsHome()).toBe(path.join(os.homedir(), '.myco'));
    expect(process.env.HOME).toBe(os.homedir());
  });
});

describe('shouldDeferSubsystem + guardBySubsystemClaim (ambient-env gate)', () => {
  // shouldDeferSubsystem reads the ambient env: self = daemonIdentity() (from
  // MYCO_HOME), the claim from resolveClaimsHome() (the default home under HOME).
  // `claims` is the claims area; HOME is set to its parent.
  function withHomeAndClaims(home: string, claims: string, fn: () => void): void {
    withEnv(MYCO_HOME_ENV, home, () => withEnv(HOME_ENV, path.dirname(claims), fn));
  }
  /** A claims area at `<user home>/.myco`, the place resolveClaimsHome() names. */
  function claimsArea(): string {
    return path.join(makeTmpDir('myco-defer-userhome-'), '.myco');
  }

  it('no claim → does not defer (normal single-daemon install)', () => {
    const home = makeTmpDir('myco-defer-home-');
    const claims = claimsArea();
    withHomeAndClaims(home, claims, () => {
      expect(shouldDeferSubsystem(SYMBIONT_CONFIG_SUBSYSTEM)).toBe(false);
    });
  });

  it('peer holds the claim → defers', () => {
    const home = makeTmpDir('myco-defer-home-');
    const claims = claimsArea();
    const peer = daemonIdentity(makeTmpDir('myco-defer-peer-'));
    claimSubsystem(SYMBIONT_CONFIG_SUBSYSTEM, peer, { claimsHome: claims });
    withHomeAndClaims(home, claims, () => {
      expect(shouldDeferSubsystem(SYMBIONT_CONFIG_SUBSYSTEM)).toBe(true);
    });
  });

  it('this home owns the claim → does not defer', () => {
    const home = makeTmpDir('myco-defer-home-');
    const claims = claimsArea();
    claimSubsystem(SYMBIONT_CONFIG_SUBSYSTEM, daemonIdentity(home), { claimsHome: claims });
    withHomeAndClaims(home, claims, () => {
      expect(shouldDeferSubsystem(SYMBIONT_CONFIG_SUBSYSTEM)).toBe(false);
    });
  });

  it('guardBySubsystemClaim runs fn when not deferred, onDeferred when a peer owns it, and passes args', () => {
    const home = makeTmpDir('myco-guard-home-');
    const claims = claimsArea();
    const calls: string[] = [];
    const guarded = guardBySubsystemClaim(
      SYMBIONT_CONFIG_SUBSYSTEM,
      (n: number) => { calls.push(`fn:${n}`); return `wrote:${n}`; },
      (n: number) => { calls.push(`deferred:${n}`); return `skipped:${n}`; },
    );

    // No claim → fn runs.
    withHomeAndClaims(home, claims, () => {
      expect(guarded(1)).toBe('wrote:1');
    });

    // Peer claims → onDeferred runs, fn does not.
    claimSubsystem(SYMBIONT_CONFIG_SUBSYSTEM, daemonIdentity(makeTmpDir('myco-guard-peer-')), { claimsHome: claims });
    withHomeAndClaims(home, claims, () => {
      expect(guarded(2)).toBe('skipped:2');
    });

    expect(calls).toEqual(['fn:1', 'deferred:2']);
  });
});

describe('cross-daemon sharing through one claims area', () => {
  it('daemon B sees daemon A claim when both read the same claims area', () => {
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

    // Daemon A claims into its own home — no shared claims area.
    claimSubsystem(SYMBIONT_CONFIG_SUBSYSTEM, ownerA, { claimsHome: homeA });

    // Daemon B checks its own home — claim is not there.
    expect(isClaimedByPeer(SYMBIONT_CONFIG_SUBSYSTEM, ownerB, { claimsHome: homeB })).toBe(false);

    // Cleanup
    releaseSubsystemClaim(SYMBIONT_CONFIG_SUBSYSTEM, ownerA, { claimsHome: homeA });
  });
});
