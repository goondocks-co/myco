/**
 * L4 — the registry splits into Deployment memberships and Project Bindings, and
 * every v1 entry already on disk is upgraded in place.
 *
 * The upgrade is the dangerous part. An exact version check means a bump makes
 * every existing entry fail it, `readRegistryEntry` return null, and capture go
 * silent while `member status --all` shows nothing — which reads as "this machine
 * never joined", the one diagnosis that stops anyone looking for the upgrade.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {
  deploymentPath, deploymentsDir, listRegistryEntries, migrateRegistry, projectsDir, readDeploymentMembership,
  readRegistryEntry, registryEntryPath, registryKeyFor, removeRegistryEntry, writeRegistryEntry, REGISTRY_VERSION, type RegistryEntry,
} from '@myco/member/registry.js';
import { ensureMemberDir } from '@myco/member/store.js';
import { resolveMemberProjectRoot } from '@myco/member/credential.js';
import { memberRig, tempMycoHome } from './helpers/server.js';
import { recordingFetch, runHook } from './helpers/hooks.js';

let mycoHome: string;
const savedHome = process.env.MYCO_HOME;
const stderrLines: string[] = [];
const origErr = process.stderr.write.bind(process.stderr);

beforeEach(() => {
  mycoHome = tempMycoHome();
  process.env.MYCO_HOME = mycoHome;
  stderrLines.length = 0;
  (process.stderr as unknown as { write: (c: unknown) => boolean }).write = ((c: unknown) => { stderrLines.push(String(c)); return true; }) as never;
});
afterEach(() => {
  process.env.MYCO_HOME = savedHome;
  (process.stderr as unknown as { write: unknown }).write = origErr;
});

/** A v1 entry exactly as the shipped member wrote it: the credential lives in the project file. */
function writeV1(root: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  ensureMemberDir(projectsDir(mycoHome), mycoHome);
  const entry = {
    version: 1, projectId: 'proj_1', serverUrl: 'https://s.example', token: 'tok-v1', tokenId: 'mt_v1',
    expiresAt: 9_000, refreshAfter: 8_000, root, machineId: 'm1', joinedAt: 1, updatedAt: 1, ...over,
  };
  fs.writeFileSync(registryEntryPath(root, mycoHome), `${JSON.stringify(entry, null, 2)}\n`, { mode: 0o600 });
  return entry;
}

const read = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;

describe('registry v1 → v2', () => {
  it('reads a v1 entry that is still on disk, upgrading it in place, so a machine that has not run since the split keeps capturing', () => {
    const root = path.join(mycoHome, 'repo');
    const v1 = writeV1(root);

    // The composed view is what every caller reads, and it is unchanged by the split.
    const entry = readRegistryEntry(root, mycoHome);
    expect(entry).toMatchObject({
      projectId: 'proj_1', serverUrl: 'https://s.example', token: 'tok-v1', tokenId: 'mt_v1',
      expiresAt: 9_000, refreshAfter: 8_000, root, machineId: 'm1',
    });
    expect(entry!.version).toBe(REGISTRY_VERSION);

    // On disk it is now two files: the project file holds no credential at all.
    const binding = read(registryEntryPath(root, mycoHome));
    expect(binding).toEqual({ version: REGISTRY_VERSION, root, projectId: 'proj_1', serverUrl: 'https://s.example', joinedAt: 1, updatedAt: 1 });
    expect(Object.keys(binding)).not.toContain('token');
    expect(read(deploymentPath('https://s.example', mycoHome))).toMatchObject({ version: REGISTRY_VERSION, serverUrl: 'https://s.example', token: v1.token, machineId: 'm1' });
  });

  it('lists upgraded entries rather than nothing, which is what `member status --all` shows after an upgrade', () => {
    const roots = ['a', 'b'].map((n) => path.join(mycoHome, n));
    for (const root of roots) writeV1(root, { projectId: `proj_${path.basename(root)}` });
    expect(listRegistryEntries(mycoHome).map((e) => e.root).sort()).toEqual([...roots].sort());
  });

  it('consolidates one credential per project into one per Deployment, keeping the most recently updated, and says so rather than dropping the rest silently', () => {
    // Entries are scanned in filename order, which is a hash of the root and so is
    // unrelated to how recent they are. The newest is deliberately placed LAST in that
    // order: an upgrade that kept whichever it saw first would otherwise agree with one
    // that kept the most recent, and this would pass either way.
    const roots = [1, 2, 3].map((n) => path.join(mycoHome, `r${n}`))
      .sort((a, b) => registryKeyFor(a).localeCompare(registryKeyFor(b)));
    writeV1(roots[0], { token: 'old', updatedAt: 10 });
    writeV1(roots[1], { token: 'middle', updatedAt: 20 });
    writeV1(roots[2], { token: 'newest', updatedAt: 30 });

    expect(migrateRegistry(mycoHome)).toEqual({ upgraded: 3, consolidated: 2 });
    expect(fs.readdirSync(deploymentsDir(mycoHome)).filter((f) => f.endsWith('.json'))).toHaveLength(1);
    expect(readDeploymentMembership('https://s.example', mycoHome)!.token).toBe('newest');
    expect(stderrLines.join('')).toContain('consolidated 3 project credentials into 1 deployment membership');
    // All three roots still resolve, and all three now share the one credential.
    expect(listRegistryEntries(mycoHome).map((e) => e.token)).toEqual(['newest', 'newest', 'newest']);
  });

  it('keeps separate memberships for separate Deployments', () => {
    writeV1(path.join(mycoHome, 'a'), { serverUrl: 'https://one.example', token: 'one' });
    writeV1(path.join(mycoHome, 'b'), { serverUrl: 'https://two.example', token: 'two' });
    expect(migrateRegistry(mycoHome)).toEqual({ upgraded: 2, consolidated: 0 });
    expect(readDeploymentMembership('https://one.example', mycoHome)!.token).toBe('one');
    expect(readDeploymentMembership('https://two.example', mycoHome)!.token).toBe('two');
    expect(stderrLines.join('')).not.toContain('consolidated');
  });

  it('gives up on a v1 entry the upgrade cannot take, by name and at once, rather than re-reading it forever', () => {
    // A v1 file missing a field the upgrade needs is skipped by the upgrade — so a read
    // that retries whenever it sees a v1 version would read it, upgrade nothing, and
    // read it again. This runs inside a hook: that loop ends when the harness kills the
    // hook, on every hook, with nothing captured and nothing said. The retry is single.
    const root = path.join(mycoHome, 'repo');
    writeV1(root, { token: '' });

    const started = Date.now();
    expect(readRegistryEntry(root, mycoHome)).toBeNull();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(stderrLines.join('')).toContain('not upgradable from v1');
    // Reported once, on the retry — never as a verdict on whether this call's upgrade
    // happened to move anything, which is a different question and is another hook's.
    expect(stderrLines.filter((l) => l.includes('not upgradable from v1'))).toHaveLength(1);
    // The file is left as it is: nothing half-upgraded, and no membership invented for it.
    expect(read(registryEntryPath(root, mycoHome)).version).toBe(1);
    expect(fs.existsSync(deploymentsDir(mycoHome)) && fs.readdirSync(deploymentsDir(mycoHome)).filter((f) => f.endsWith('.json'))).toEqual([]);
  });

  it('reads an entry another hook upgraded a moment earlier, rather than calling it malformed', () => {
    // Two hooks read the same v1 file before either takes the lock; one upgrades. The
    // loser's own upgrade then finds nothing left to do — which says nothing about
    // whether ITS file is readable now. Testing this call's upgrade count instead of
    // re-reading is what turns a won race into "malformed" and skips the capture.
    const root = path.join(mycoHome, 'repo');
    writeV1(root);
    expect(migrateRegistry(mycoHome).upgraded).toBe(1);

    // Put a second v1 file back and read the FIRST one: the upgrade this read triggers
    // reports work for a different file entirely, and the read must still succeed.
    writeV1(path.join(mycoHome, 'other'), { projectId: 'proj_2' });
    expect(readRegistryEntry(root, mycoHome)).toMatchObject({ projectId: 'proj_1', token: 'tok-v1' });
    expect(stderrLines.join('')).not.toContain('not upgradable');
  });

  it('runs twice with no further effect, so hooks racing the upgrade is not a problem', () => {
    const root = path.join(mycoHome, 'repo');
    writeV1(root);
    expect(migrateRegistry(mycoHome)).toEqual({ upgraded: 1, consolidated: 0 });
    const after = { binding: read(registryEntryPath(root, mycoHome)), membership: read(deploymentPath('https://s.example', mycoHome)) };
    expect(migrateRegistry(mycoHome)).toEqual({ upgraded: 0, consolidated: 0 });
    expect({ binding: read(registryEntryPath(root, mycoHome)), membership: read(deploymentPath('https://s.example', mycoHome)) }).toEqual(after);
  });
});

describe('a v1 entry still captures', () => {
  it('delivers a hook\'s event to the server from an entry written before the split, with no join in between', async () => {
    // The whole point of the upgrade. This drives the real hook against the real
    // worker: a machine that captured yesterday on v1 captures today on v2, and the
    // only thing that changed on disk is the layout.
    const rig = await memberRig();
    const root = resolveMemberProjectRoot(process.cwd());
    ensureMemberDir(projectsDir(mycoHome), mycoHome);
    fs.writeFileSync(registryEntryPath(root, mycoHome), `${JSON.stringify({
      version: 1, projectId: 'proj_1', serverUrl: 'https://member-test.invalid', token: rig.token,
      tokenId: rig.tokenId, expiresAt: rig.expiresAt, root, machineId: 'machine_1', joinedAt: 1, updatedAt: 1,
    }, null, 2)}\n`, { mode: 0o600 });
    expect(fs.existsSync(deploymentsDir(mycoHome))).toBe(false);

    const { fetch, requests } = recordingFetch(rig.fetch);
    const result = await runHook('post-tool-use', { session_id: 'sess-v1', tool_name: 'Read', tool_input: { file_path: '/a' } }, { fetch, credential: 'registry' });

    expect(result.stderr).not.toContain('no registry entry');
    expect(requests.map((r) => r.path)).toEqual(['/events']);
    expect(rig.rows('events')).toBe(1);
    // And the upgrade happened on the way through, once.
    expect(fs.readdirSync(deploymentsDir(mycoHome)).filter((f) => f.endsWith('.json'))).toHaveLength(1);
    expect(read(registryEntryPath(root, mycoHome)).version).toBe(REGISTRY_VERSION);
  });
});

describe('registry split', () => {
  const entry = (root: string, over: Partial<RegistryEntry> = {}): RegistryEntry => ({
    version: REGISTRY_VERSION, projectId: 'proj_1', serverUrl: 'https://s.example', token: 'tok', tokenId: 'mt_1',
    root, machineId: 'm1', joinedAt: 1, updatedAt: 1, ...over,
  });

  it('holds the credential once for a machine working in many projects, so a rotation reaches all of them at once', () => {
    const roots = [1, 2, 3].map((n) => path.join(mycoHome, `p${n}`));
    for (const [i, root] of roots.entries()) writeRegistryEntry(entry(root, { projectId: `proj_${i}` }), { mycoHome });
    expect(fs.readdirSync(deploymentsDir(mycoHome)).filter((f) => f.endsWith('.json'))).toHaveLength(1);
    for (const root of roots) expect(read(registryEntryPath(root, mycoHome)).token).toBeUndefined();

    // One project rotates. Every other project is already on the new token — there is
    // no second copy to leave stale, and the successor's first use revokes the old one.
    writeRegistryEntry({ ...entry(roots[0]), token: 'rotated', tokenId: 'mt_2' }, { mycoHome });
    expect(listRegistryEntries(mycoHome).map((e) => e.token)).toEqual(['rotated', 'rotated', 'rotated']);
  });

  it('keeps the instant this machine joined the Deployment, whatever a later project binding says', () => {
    // A membership's `joinedAt` is about the Deployment, not about whichever project
    // was bound most recently. Binding a second project must not restate it as today,
    // or an operator reading the file is told this machine joined at a moment it did not.
    const first = path.join(mycoHome, 'p1');
    writeRegistryEntry(entry(first, { joinedAt: 100, updatedAt: 100 }), { mycoHome });
    writeRegistryEntry(entry(path.join(mycoHome, 'p2'), { projectId: 'proj_2', joinedAt: 900, updatedAt: 900 }), { mycoHome });

    expect(readDeploymentMembership('https://s.example', mycoHome)!.joinedAt).toBe(100);
    // The second project's own binding still records when IT was bound.
    expect(read(registryEntryPath(path.join(mycoHome, 'p2'), mycoHome)).joinedAt).toBe(900);
  });

  it('refuses a binding whose Deployment membership is gone, by name, rather than reporting no membership at all', () => {
    const root = path.join(mycoHome, 'repo');
    writeRegistryEntry(entry(root), { mycoHome });
    fs.unlinkSync(deploymentPath('https://s.example', mycoHome));
    expect(readRegistryEntry(root, mycoHome)).toBeNull();
    expect(stderrLines.join('')).toContain('no membership for https://s.example');
  });

  it('refuses an entry from a newer build rather than reading it as its own, in both the read and the list', () => {
    // The membership is written first and is perfectly readable, so the version of the
    // binding is the ONLY thing standing between this entry and being read. Without
    // that, a missing membership refuses the entry on its own and the version check
    // could do nothing at all without the test noticing.
    const root = path.join(mycoHome, 'repo');
    writeRegistryEntry(entry(root), { mycoHome });
    expect(readRegistryEntry(root, mycoHome)).not.toBeNull();

    const binding = read(registryEntryPath(root, mycoHome));
    fs.writeFileSync(registryEntryPath(root, mycoHome), `${JSON.stringify({ ...binding, version: REGISTRY_VERSION + 1, projectId: 'proj_from_the_future' }, null, 2)}\n`, { mode: 0o600 });

    expect(readRegistryEntry(root, mycoHome)).toBeNull();
    expect(listRegistryEntries(mycoHome)).toEqual([]);
    // And it is left exactly as the newer build wrote it: a downgrade never rewrites forward-written state.
    expect(read(registryEntryPath(root, mycoHome))).toMatchObject({ version: REGISTRY_VERSION + 1, projectId: 'proj_from_the_future' });
  });

  it('merges into an existing membership instead of replacing it, so binding a second project keeps the first project working', () => {
    // One membership serves every project on a Deployment. A write on behalf of one
    // project that replaced it would swap the live credential for whatever that call
    // carried, drop the rotation state so the next hook refreshes immediately, and
    // strand the displaced credential live on the server with no id left to revoke it.
    const a = path.join(mycoHome, 'a');
    writeRegistryEntry(entry(a, { token: 'live', tokenId: 'mt_live', expiresAt: 5_000, refreshAfter: 4_000 }), { mycoHome });

    // `myco member join` for a second project builds an entry carrying no tokenId,
    // expiresAt or refreshAfter — exactly what the CLI does.
    writeRegistryEntry({ version: REGISTRY_VERSION, projectId: 'proj_2', serverUrl: 'https://s.example', token: 'live', root: path.join(mycoHome, 'b'), machineId: 'm1', joinedAt: 2, updatedAt: 2 }, { mycoHome });

    const held = readDeploymentMembership('https://s.example', mycoHome)!;
    expect({ tokenId: held.tokenId, expiresAt: held.expiresAt, refreshAfter: held.refreshAfter }).toEqual({ tokenId: 'mt_live', expiresAt: 5_000, refreshAfter: 4_000 });
    expect(readRegistryEntry(a, mycoHome)).toMatchObject({ token: 'live', tokenId: 'mt_live', projectId: 'proj_1' });
  });

  it('takes the credential with the last binding that named it, and not before', () => {
    const a = path.join(mycoHome, 'a');
    const b = path.join(mycoHome, 'b');
    writeRegistryEntry(entry(a), { mycoHome });
    writeRegistryEntry(entry(b, { projectId: 'proj_2' }), { mycoHome });

    expect(removeRegistryEntry(a, mycoHome)).toBe(true);
    // Still bound by b: the credential stays and b keeps capturing.
    expect(fs.existsSync(deploymentPath('https://s.example', mycoHome))).toBe(true);
    expect(readRegistryEntry(b, mycoHome)).not.toBeNull();

    expect(removeRegistryEntry(b, mycoHome)).toBe(true);
    // Nothing names it now. Leaving the token behind is leaving a live secret on disk
    // that nothing references and no local record names well enough to revoke.
    expect(fs.existsSync(deploymentPath('https://s.example', mycoHome))).toBe(false);
  });

  it('leaves a membership alone when the upgrade re-runs, so a crash inside the binding loop cannot promote an older credential', () => {
    // The upgrade recomputes its winner from whichever v1 files remain. If the newest
    // entry's file has already been rewritten as a binding and an older one has not —
    // the state a crash mid-loop leaves — a second run would otherwise pick the older.
    const roots = [1, 2].map((n) => path.join(mycoHome, `r${n}`));
    writeV1(roots[0], { token: 'newest', updatedAt: 30 });
    writeV1(roots[1], { token: 'older', updatedAt: 10 });
    expect(migrateRegistry(mycoHome).upgraded).toBe(2);
    expect(readDeploymentMembership('https://s.example', mycoHome)!.token).toBe('newest');

    // Put the older entry back at v1, as an interrupted run or an older build would.
    writeV1(roots[1], { token: 'older', updatedAt: 10 });
    migrateRegistry(mycoHome);
    expect(readDeploymentMembership('https://s.example', mycoHome)!.token).toBe('newest');
  });

  it('refuses a binding whose membership records a different Deployment, rather than sending its capture there', () => {
    const root = path.join(mycoHome, 'repo');
    writeRegistryEntry(entry(root), { mycoHome });
    const file = deploymentPath('https://s.example', mycoHome);
    const held = read(file);
    fs.writeFileSync(file, `${JSON.stringify({ ...held, serverUrl: 'https://elsewhere.example' }, null, 2)}\n`, { mode: 0o600 });
    expect(readRegistryEntry(root, mycoHome)).toBeNull();
  });

  it('carries the member id through the split, so it is not erased by the next write', () => {
    const root = path.join(mycoHome, 'repo');
    writeRegistryEntry(entry(root, { memberId: 'mem_abc' }), { mycoHome });
    expect(readRegistryEntry(root, mycoHome)).toMatchObject({ memberId: 'mem_abc' });
    writeRegistryEntry(entry(path.join(mycoHome, 'other'), { projectId: 'proj_2' }), { mycoHome });
    expect(readRegistryEntry(root, mycoHome)).toMatchObject({ memberId: 'mem_abc' });
  });
});
