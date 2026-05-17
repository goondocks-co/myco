/**
 * Tenet conformance: every phase transition in claim/release is resumable.
 * For each phase, we stage a claim manifest stuck at that phase and verify
 * that re-running claim or release converges to the same terminal state
 * a clean run would produce.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  type ClaimManifest,
  claimGroveForDogfood,
  releaseClaimedGrove,
} from '@myco/grove/claim.js';
import {
  resolveGroveDbPath,
  resolveBackupsRoot,
} from '@myco/grove/paths.js';
import {
  clearGroveRegistryCaches,
  createGrove,
  loadGroveRecord,
  setGroveServedBy,
} from '@myco/grove/registry.js';

let home: string;
let backupsRoot: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-claim-resume-'));
  backupsRoot = path.join(home, 'backups');
  clearGroveRegistryCaches();
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  clearGroveRegistryCaches();
});

function seedGrove(name: string) {
  const grove = createGrove(name, home);
  // Write a fake SQLite-looking byte sequence at the Grove DB path so the
  // snapshot copy fallback succeeds (VACUUM INTO falls back to copyFileSync
  // when the file isn't a real DB).
  const dbPath = resolveGroveDbPath(grove.id, home);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.writeFileSync(dbPath, 'not-a-real-sqlite-file');
  return grove;
}

function readManifest(manifestPath: string): ClaimManifest {
  return JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as ClaimManifest;
}

describe('claim/release resumability (tenet conformance)', () => {
  it('claim is idempotent: re-running after success is a no-op', () => {
    const grove = seedGrove('Resume One');

    const first = claimGroveForDogfood(grove.id, home, { backupsRoot });
    expect(first.manifest.claim_phase).toBe('flipped');
    expect(loadGroveRecord(grove.id, home)?.served_by).toBe('service-dev');

    const second = claimGroveForDogfood(grove.id, home, { backupsRoot });
    expect(second.manifest_path).toBe(first.manifest_path);
    expect(second.manifest.claim_phase).toBe('flipped');
    expect(loadGroveRecord(grove.id, home)?.served_by).toBe('service-dev');
  });

  it('claim resumes when interrupted between snapshot and flip (claim_phase=claimed)', () => {
    const grove = seedGrove('Resume Two');

    // Run claim then rewind state to simulate crash after snapshot but
    // before served_by flip — manifest at 'claimed', served_by still
    // 'service'.
    const first = claimGroveForDogfood(grove.id, home, { backupsRoot });
    setGroveServedBy(grove.id, 'service', home);
    const rewound: ClaimManifest = { ...first.manifest, claim_phase: 'claimed' };
    fs.writeFileSync(first.manifest_path, JSON.stringify(rewound, null, 2));

    const resumed = claimGroveForDogfood(grove.id, home, { backupsRoot });
    expect(resumed.manifest.claim_phase).toBe('flipped');
    expect(loadGroveRecord(grove.id, home)?.served_by).toBe('service-dev');
  });

  it('release is idempotent: re-running after success is a no-op', () => {
    const grove = seedGrove('Resume Three');
    claimGroveForDogfood(grove.id, home, { backupsRoot });

    const first = releaseClaimedGrove(grove.id, home, { backupsRoot });
    expect(first.manifest.release_phase).toBe('archived');
    expect(loadGroveRecord(grove.id, home)?.served_by).toBe('service');

    // Re-running release after a clean completion: the active claim dir
    // has been renamed under archive/, so findOpenClaim returns null and
    // a fresh release call throws "Nothing to release."
    expect(() => releaseClaimedGrove(grove.id, home, { backupsRoot })).toThrow(/Nothing to release/);
  });

  it('release resumes from each phase', () => {
    type Phase = 'restored' | 'registry-restored' | 'flipped' | 'archived';
    const phases: Phase[] = ['restored', 'registry-restored', 'flipped'];

    for (const phase of phases) {
      // Fresh Grove per phase since release archives the prior claim dir.
      const slug = `phase-${phase}`.replace(/-/g, '_');
      const grove = seedGrove(`Phase ${phase}`);
      claimGroveForDogfood(grove.id, home, { backupsRoot });

      const claimsDir = path.join(
        resolveBackupsRoot(backupsRoot),
        'claims',
        grove.slug,
      );
      const claimRoots = fs.readdirSync(claimsDir).filter((n) => n !== 'archive');
      expect(claimRoots.length).toBe(1);
      const manifestPath = path.join(claimsDir, claimRoots[0], 'claim.json');
      const baseline = readManifest(manifestPath);

      // Stage the manifest at the target phase. Don't simulate partial
      // work — we only verify that the resume code path correctly skips
      // already-completed phases and finishes the rest.
      const staged: ClaimManifest = {
        ...baseline,
        release_phase: phase,
        release_owner_op: baseline.release_owner_op
          ?? `grove-release-${grove.slug}-staged`,
      };
      // For phases >= 'flipped', also flip served_by back since that phase's
      // work has logically happened.
      if (phase === 'flipped') {
        setGroveServedBy(grove.id, baseline.original_served_by, home);
      }
      fs.writeFileSync(manifestPath, JSON.stringify(staged, null, 2));

      const result = releaseClaimedGrove(grove.id, home, { backupsRoot });
      expect(result.manifest.release_phase).toBe('archived');
      expect(loadGroveRecord(grove.id, home)?.served_by).toBe('service');

      // After successful archive, the claim dir should be in archive/, not
      // active claims dir.
      const remaining = fs.existsSync(claimsDir)
        ? fs.readdirSync(claimsDir).filter((n) => n !== 'archive')
        : [];
      expect(remaining.length).toBe(0);
      expect(slug).toBeTruthy(); // suppress unused warning
    }
  });

  it('archive phase resumes when checkpoint was written but rename did not happen', () => {
    // Regression: the archive phase writes the 'archived' checkpoint
    // before renaming the claim dir. If a crash lands between checkpoint
    // and rename, the active claim dir is still in place — re-running
    // release must complete the rename instead of leaving the dir
    // stranded with an 'archived' flag.
    const grove = seedGrove('Resume Archive');
    claimGroveForDogfood(grove.id, home, { backupsRoot });

    const claimsDir = path.join(
      resolveBackupsRoot(backupsRoot),
      'claims',
      grove.slug,
    );
    const claimRoots = fs.readdirSync(claimsDir).filter((n) => n !== 'archive');
    const claimRoot = path.join(claimsDir, claimRoots[0]);
    const manifestPath = path.join(claimRoot, 'claim.json');
    const baseline = readManifest(manifestPath);

    // Simulate: prior release ran restore, registry-restore, served_by flip,
    // wrote 'archived' checkpoint, then crashed before rename.
    setGroveServedBy(grove.id, baseline.original_served_by, home);
    const stranded: ClaimManifest = {
      ...baseline,
      release_phase: 'archived',
      release_owner_op: `grove-release-${grove.slug}-staged`,
    };
    fs.writeFileSync(manifestPath, JSON.stringify(stranded, null, 2));

    const result = releaseClaimedGrove(grove.id, home, { backupsRoot });
    expect(result.manifest.release_phase).toBe('archived');
    expect(result.archive_dir).toContain(`${path.sep}archive${path.sep}`);
    expect(fs.existsSync(claimRoot)).toBe(false);
    expect(fs.existsSync(result.archive_dir)).toBe(true);
  });
});
