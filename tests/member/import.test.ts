import { refuseImportAfter } from '../setup/fixtures/interruption.js';
import { run as runImportCli, reportLines } from '@myco/cli/import.js';
import { recordDefaultDeployment } from '@myco/member/default-deployment.js';
import { spoolDirFor, MemberSpool } from '@myco/member/spool.js';
import { routingKey } from '@myco/member/routing.js';
import { writeRegistryEntry, readRegistryEntry } from '@myco/member/registry.js';
/**
 * Importing a machine's existing history, against the real worker.
 *
 * The gate this feature is judged by is that running it twice changes nothing —
 * and "nothing" has to mean row counts AND blob keys AND requests, because the
 * expensive failure is invisible in row counts alone: the member uploads a
 * blob before the event that references it is admitted, so a re-import that
 * looked like a no-op in the store could still be charging bytes and stranding
 * objects on every run.
 *
 * Two failures here are silent by construction and are what most of this file
 * exists for:
 *
 *   - a transcript store is not project-scoped, so an import that does not
 *     attribute files a machine's other checkouts under whichever Project it
 *     happened to be looking at. Every row lands; every count looks right.
 *   - a moved or re-created file is a NEW identity over the same content, so
 *     re-deriving it mints new event ids for row identities that already
 *     exist. The projections refuse quietly, the event log doubles, and the
 *     conflict signal a live parse would raise never fires.
 */
import { describe, expect, it, spyOn } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IMPORT_DEADLINE, runImport, importUntilSettled, isMemberStatePath, type ImportOptions } from '@myco/member/import.js';
import { attributeByPathSlug, attributeTranscript, rootSlug } from '@myco/symbionts/transcript-attribution.js';
import { BUNDLED_MANIFESTS } from '@myco/symbionts/manifests.generated.js';
import { expandRoot, manifestTranscriptDiscovery } from '@myco/symbionts/transcript-discovery.js';
import { parseTranscripts } from '@myco-server-worker/ingest/parse.js';
import { memberRig, tempMycoHome, TEST_MACHINE_ID } from './helpers/server.js';
import { registerTestMember, runHook } from './helpers/hooks.js';
import { resolveCredential } from '@myco/member/credential.js';
import { repositoryAt, rootKeyFor } from '@myco/member/auto-join.js';
import { Client } from '@modelcontextprotocol/client';
import { deploymentTransport, resolveDeploymentUpstream } from '@myco/mcp/deployment-upstream.js';
import { memberTranscriptRoutingKey } from '@myco/member/transcript-routing.js';
import { resetMachineIdCache } from '@myco/machine-id.js';

const line = (o: Record<string, unknown>): string => `${JSON.stringify(o)}\n`;

/** A Claude Code transcript of one turn, long enough to carry a head digest. */
function transcript(n: number): string {
  const pad = 'x'.repeat(5000);
  return line({ type: 'user', cwd: '/PLACEHOLDER', promptId: `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`, message: { content: `prompt ${n} ${pad}` }, timestamp: '2026-09-01T10:00:00Z' })
    + line({ type: 'assistant', message: { content: [{ type: 'text', text: `reply ${n}` }] }, timestamp: '2026-09-01T10:00:01Z' });
}

/**
 * A fake `~/.claude/projects/<slug>/<sessionId>.jsonl` store, with HOME pointed
 * at it.
 *
 * Every file is aged past the freshness floor, because that is what an archive
 * is: a store of files nothing has touched for a while. A fixture written at
 * the current instant is a store of sessions that are all still running, which
 * an import is right to leave alone — so a test that wants history has to say
 * so, and one that wants a live session says that instead.
 */
function store(root: string, cwds: readonly string[], perCwd = 2): { home: string; files: string[] } {
  const home = fs.mkdtempSync(path.join(root, 'home-'));
  const files: string[] = [];
  let n = 0;
  for (const cwd of cwds) {
    const dir = path.join(home, '.claude', 'projects', `-${rootSlug(cwd)}`);
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < perCwd; i += 1) {
      n += 1;
      const file = path.join(dir, `00000000-0000-4000-8000-${String(n).padStart(12, '0')}.jsonl`);
      fs.writeFileSync(file, transcript(n).replace('/PLACEHOLDER', cwd));
      files.push(file);
    }
  }
  for (const file of files) age(file);
  return { home, files };
}

/** Push a fixture's mtime past the freshness floor, so an import reads it as history. */
const age = (file: string, byMs = 60 * 60_000): void => {
  const at = new Date(Date.now() - byMs);
  fs.utimesSync(file, at, at);
};

async function rig(cwds: readonly string[], perCwd = 2, prebuilt?: { home: string; files: string[] }) {
  const env = await memberRig();
  const mycoHome = tempMycoHome();
  const root = prebuilt === undefined ? fs.mkdtempSync(path.join(os.tmpdir(), 'myco-import-')) : path.dirname(prebuilt.home);
  const { home, files } = prebuilt ?? store(root, cwds, perCwd);
  const held = process.env.HOME;
  process.env.HOME = home;

  // ONE PROJECT PER ROOT. Binding every root to the same Project would let a
  // pass that funnelled every candidate into the first Project pass every
  // assertion below.
  const projectOf = new Map<string, string>();
  cwds.forEach((cwd, i) => {
    const projectId = i === 0 ? 'proj_1' : `proj_${i + 1}`;
    projectOf.set(cwd, projectId);
    env.env.sqlite.run(`INSERT OR IGNORE INTO projects (project_id, name, created_at) VALUES (?, ?, ?)`, [projectId, projectId, Date.now()]);
    registerTestMember({ mycoHome, token: env.token, tokenId: env.tokenId, projectId, serverUrl: 'https://member-test.invalid', root: cwd });
  });

  /** Every plan request: the Project its header named, and the candidates it carried. */
  const planRequests: Array<{ project: string; sessions: string[] }> = [];
  let uploads = 0;
  const recordingFetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/blobs/')) uploads += 1;
    if (url.includes('/import/plan')) {
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      const parsed = JSON.parse(String(init?.body ?? '{}')) as { candidates?: Array<{ sessionId: string }> };
      planRequests.push({ project: headers.get('x-myco-project') ?? '', sessions: (parsed.candidates ?? []).map((c) => c.sessionId).sort() });
    }
    return env.fetch(input, init);
  };

  // `serverUrl` is an OPTION, not a dep: it is what the caller names, the same
  // way `myco login` names the Deployment it just redeemed.
  const run = (opts: Partial<ImportOptions> = {}) =>
    runImport({ serverUrl: 'https://member-test.invalid', ...opts }, { fetch: recordingFetch, mycoHome, machineId: TEST_MACHINE_ID, now: () => Date.now() });
  const blobKeys = (): string[] =>
    (env.env.sqlite.query(`SELECT key FROM blobs ORDER BY key`).all() as Array<{ key: string }>).map((r) => r.key);
  const snapshot = () => ({
    events: env.rows('events'), segments: env.rows('transcript_segments'), blobs: env.rows('blobs'),
    sessions: env.rows('sessions'), prompts: env.rows('prompt_batches'), keys: blobKeys(),
  });
  const restore = () => { if (held === undefined) delete process.env.HOME; else process.env.HOME = held; };
  const uploadCount = () => uploads;
  const resetUploads = () => { uploads = 0; };
  return { env, mycoHome, home, files, run, snapshot, blobKeys, restore, projectOf, planRequests, uploadCount, resetUploads };
}

describe('an import with a deadline', () => {
  it('stops recursive discovery at its deadline, reports pending history, and preserves it for a later pass', async () => {
    const cwd = path.join(os.tmpdir(), 'myco-import-discovery-deadline');
    const r = await rig([cwd], 3);
    const contents = r.files.map(file => fs.readFileSync(file, 'utf8'));
    const until = Date.now() + 60_000;
    let late = false;
    let reads = 0;
    const readdir = fs.readdirSync.bind(fs);
    const probe = spyOn(fs, 'readdirSync').mockImplementation(((...args: Parameters<typeof fs.readdirSync>) => {
      if (String(args[0]).startsWith(path.join(r.home, '.claude', 'projects'))) {
        reads++;
        late = true;
      }
      return readdir(...args);
    }) as typeof fs.readdirSync);
    try {
      const report = await runImport({ serverUrl: 'https://member-test.invalid', until }, {
        fetch: async () => { throw new Error('expired discovery must not send'); },
        mycoHome: r.mycoHome, machineId: TEST_MACHINE_ID, now: () => late ? until + 1 : Date.now(),
      });
      expect(reads).toBe(1);
      expect(report.stoppedBy).toBe(IMPORT_DEADLINE);
      expect(report.projects.map(project => project.endedBy)).toEqual([IMPORT_DEADLINE]);
      expect(r.files.map(file => fs.readFileSync(file, 'utf8'))).toEqual(contents);
      probe.mockRestore();
      const resumed = await r.run();
      expect(resumed.projects.flatMap(project => project.agents).reduce((sum, agent) => sum + agent.imported, 0)).toBe(3);
    } finally {
      probe.mockRestore();
      r.restore();
    }
  });

  it('ships no session past it, says so, and the next import brings the rest without sending any twice', async () => {
    const cwd = path.join(os.tmpdir(), 'myco-import-deadline');
    const r = await rig([cwd], 3);
    try {
      const until = Date.now() + 60_000;
      // The clock passes the deadline once the first session has sent anything.
      let late = false;
      let plans = 0;
      const fetch = async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('/import/plan')) plans += 1;
        if (!url.includes('/import/plan')) late = true;
        return r.env.fetch(input, init);
      };
      const bounded = (at: number) => runImport({ serverUrl: 'https://member-test.invalid', until: at }, { fetch, mycoHome: r.mycoHome, machineId: TEST_MACHINE_ID, now: () => (late ? until + 1 : Date.now()) });
      const imported = (report: Awaited<ReturnType<typeof runImport>>) => report.projects.reduce((n, p) => n + p.agents.reduce((m, a) => m + a.imported, 0), 0);

      const none = await bounded(Date.now() - 1);
      // Past it before it starts: not even a plan is asked for.
      expect({ imported: imported(none), endedBy: none.projects.map((p) => p.endedBy), plans }).toEqual({ imported: 0, endedBy: [IMPORT_DEADLINE], plans: 0 });
      const one = await bounded(until);
      expect({ imported: imported(one), endedBy: one.projects.map((p) => p.endedBy) }).toEqual({ imported: 1, endedBy: [IMPORT_DEADLINE] });
      const rest = await r.run();
      expect(imported(rest)).toBe(2);
      const facts = r.env.env.sqlite.query(`SELECT COUNT(*) AS n FROM events WHERE kind IN ('session.start', 'session.end')`).get() as { n: number };
      expect(facts.n).toBe(3 * 2);
    } finally {
      r.restore();
    }
  });
});

describe('importing a machine of one project', () => {
  it('is a no-op when run again, ships only a delta, and never re-derives a moved file', async () => {
    const cwd = path.join(os.tmpdir(), 'myco-import-alpha');
    const r = await rig([cwd]);
    try {
      // Run 1: everything on disk arrives.
      await r.run();
      const first = r.snapshot();
      expect(first.segments).toBeGreaterThan(0);
      expect(first.blobs).toBeGreaterThan(0);

      // Run 2: identical. No row, no blob, and no upload request.
      r.resetUploads();
      await r.run();
      expect(r.snapshot()).toEqual(first);
      expect(r.uploadCount()).toBe(0);

      // Run 3: one transcript grows. Only its delta lands.
      fs.appendFileSync(r.files[0], line({ type: 'assistant', message: { content: [{ type: 'text', text: 'later' }] }, timestamp: '2026-09-01T11:00:00Z' }));
      age(r.files[0]);
      await r.run();
      const third = r.snapshot();
      expect(third.segments).toBe(first.segments + 1);

      // Run 4: one transcript is RE-CREATED in place — the same path and the
      // same content under a new inode, which is a new identity. Re-deriving it
      // would mint fresh event ids for row identities that already exist: the
      // projections would refuse quietly, the event log would double, and the
      // conflict a live parse raises would never fire. Only the head digest
      // tells this from a rotation, so only an equal digest refuses it.
      const content = fs.readFileSync(r.files[1]);
      fs.writeFileSync(`${r.files[1]}.tmp`, content);
      fs.renameSync(`${r.files[1]}.tmp`, r.files[1]);
      age(r.files[1]);
      await r.run();
      expect(r.snapshot()).toEqual(third);

      // The session's facts are sent once, not once per run. Four runs over two
      // sessions is four fact events, not sixteen: a re-sent `session.start`
      // and `session.end` are two more rows for a session that has not changed.
      const facts = r.env.env.sqlite.query(`SELECT COUNT(*) AS n FROM events WHERE kind IN ('session.start', 'session.end')`).get() as { n: number };
      expect(facts.n).toBe(r.files.length * 2);
    } finally {
      r.restore();
    }
  });

  it('reports what it found and what it imported, per agent', async () => {
    const cwd = path.join(os.tmpdir(), 'myco-import-report');
    const r = await rig([cwd]);
    try {
      const report = await r.run();
      const claude = report.projects[0]?.agents.find((a) => a.agent === 'claude-code');
      expect({ found: claude?.found, imported: claude?.imported }).toEqual({ found: 2, imported: 2 });
      // A second run finds the same and imports none: the count is what makes a
      // store's size visible without any lane declaring it.
      const again = await r.run();
      const second = again.projects[0]?.agents.find((a) => a.agent === 'claude-code');
      expect({ found: second?.found, imported: second?.imported, held: second?.skipped.held }).toEqual({ found: 2, imported: 0, held: 2 });
    } finally {
      r.restore();
    }
  });
});

describe('importing a machine of several projects', () => {
  it('imports every checkout bound to the Deployment, each under its own Project', async () => {
    const alpha = path.join(os.tmpdir(), 'myco-import-a');
    const beta = path.join(os.tmpdir(), 'myco-import-b');
    const r = await rig([alpha, beta]);
    try {
      const report = await r.run();
      // Both roots are bound, to DIFFERENT Projects, so both are imported under
      // their own. A rule that attributed to one Project and dropped the rest
      // would import half of this and report itself complete.
      expect(report.projects.map((p) => p.projectId).sort()).toEqual(['proj_1', 'proj_2']);
      const imported = report.projects.flatMap((p) => p.agents).reduce((n, a) => n + a.imported, 0);
      expect({ imported, unattributable: report.unattributable }).toEqual({ imported: 4, unattributable: 0 });

      // Two Projects, two files each, so a machine-wide `found` reads 4 where
      // the truth is 2. One Project, or one file each, and the two numbers are
      // the same and the count could revert with nothing failing.
      expect(report.projects.map((project) => project.agents.map((a) => [a.found, a.imported]))).toEqual([[[2, 2]], [[2, 2]]]);

      // One request per Project, and every candidate in a request belongs to
      // the Project that request's header names. Asserted on the wire: a
      // candidate offered under the wrong Project and filtered afterwards would
      // satisfy a report-only assertion.
      expect(r.planRequests).toHaveLength(2);
      for (const request of r.planRequests) {
        const cwd = [...r.projectOf].find(([, id]) => id === request.project)?.[0];
        expect({ project: request.project, known: cwd !== undefined }).toEqual({ project: request.project, known: true });
        for (const sessionId of request.sessions) {
          const file = r.files.find((f) => f.endsWith(`${sessionId}.jsonl`));
          expect({ sessionId, inProject: file !== undefined && fs.readFileSync(file, 'utf8').includes(`"cwd":"${cwd}"`) })
            .toEqual({ sessionId, inProject: true });
        }
      }
    } finally {
      r.restore();
    }
  });

  it('reports the Projects --project excluded rather than passing over them', async () => {
    const alpha = path.join(os.tmpdir(), 'myco-narrow-a');
    const beta = path.join(os.tmpdir(), 'myco-narrow-b');
    const r = await rig([alpha, beta]);
    try {
      const report = await r.run({ project: 'proj_1' });
      expect(report.projects.map((p) => p.projectId)).toEqual(['proj_1']);
      // The other Project's history exists and was not fetched. Silence here
      // reads as "there was nothing", which is a different answer.
      expect(report.narrowed).toEqual(['proj_2']);
      expect(r.planRequests.map((q) => q.project)).toEqual(['proj_1']);
    } finally {
      r.restore();
    }
  });

  it('leaves a transcript whose root no binding names, and one it cannot place at all', async () => {
    const bound = path.join(os.tmpdir(), 'myco-import-bound');
    const stranger = path.join(os.tmpdir(), 'myco-import-stranger');
    const r = await rig([bound]);
    try {
      // A second checkout's transcripts sit in the same store; nothing on this
      // Deployment names that root.
      const dir = path.join(r.home, '.claude', 'projects', `-${rootSlug(stranger)}`);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, '00000000-0000-4000-8000-000000000099.jsonl'), transcript(99).replace('/PLACEHOLDER', stranger));
      // And one that names no project anywhere.
      const orphan = path.join(r.home, '.claude', 'projects', 'no-project-here');
      fs.mkdirSync(orphan, { recursive: true });
      fs.writeFileSync(path.join(orphan, '00000000-0000-4000-8000-000000000098.jsonl'), transcript(98).replace('"cwd":"/PLACEHOLDER",', ''));

      const report = await r.run();
      const imported = report.projects.flatMap((p) => p.agents).reduce((n, a) => n + a.imported, 0);
      // Three distinct outcomes, each named: imported, belongs to a checkout
      // this Deployment holds no Project for, and cannot be placed at all.
      expect({ imported, unbound: report.unbound, unattributable: report.unattributable })
        .toEqual({ imported: 2, unbound: 1, unattributable: 1 });
    } finally {
      r.restore();
    }
  });
});

describe('choosing which Deployment to import into', () => {
  it('offers identical plugin session ids only to their pinned Deployment, including after a repository rebind', async () => {
    const aUrl = 'https://import-a.invalid';
    const bUrl = 'https://import-b.invalid';
    const projectId = 'proj_same';
    const sessionId = 'same-session';
    const a = await memberRig({ projectId });
    const b = await memberRig({ projectId });
    const mycoHome = tempMycoHome();
    const previousMycoHome = process.env.MYCO_HOME;
    process.env.MYCO_HOME = mycoHome;
    try {
      const roots = [path.join(mycoHome, 'repo-a'), path.join(mycoHome, 'repo-b')];
      for (const root of roots) fs.mkdirSync(root);
      const entries = [
        registerTestMember({ mycoHome, root: roots[0], serverUrl: aUrl, projectId, token: a.token, tokenId: a.tokenId }),
        registerTestMember({ mycoHome, root: roots[1], serverUrl: bUrl, projectId, token: b.token, tokenId: b.tokenId }),
      ];
      for (const entry of entries) {
        const scope = path.join(mycoHome, 'member', 'transcripts', routingKey(entry));
        const file = path.join(scope, 'opencode', `${sessionId}.jsonl`);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(path.join(scope, 'destination.json'), `${JSON.stringify({ serverUrl: entry.serverUrl, projectId })}\n`, { mode: 0o600 });
        fs.writeFileSync(file, line({ type: 'user', cwd: entry.root, message: { role: 'user', content: entry.serverUrl } }));
        age(file);
      }

      const decoyHome = path.join(mycoHome, 'decoy-home');
      const decoyScope = path.join(decoyHome, 'member', 'transcripts', routingKey(entries[0]));
      fs.mkdirSync(path.join(decoyScope, 'opencode'), { recursive: true });
      fs.writeFileSync(path.join(decoyScope, 'destination.json'), JSON.stringify({ serverUrl: aUrl, projectId }), { mode: 0o600 });
      fs.writeFileSync(path.join(decoyScope, 'opencode', `${sessionId}.jsonl`), line({ type: 'user', cwd: roots[0], message: { role: 'user', content: 'foreign member home' } }));
      process.env.MYCO_HOME = decoyHome;
      const offers: Array<{ serverUrl: string; sessions: string[] }> = [];
      const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const request = new Request(input, init);
        const serverUrl = request.url.startsWith(aUrl) ? aUrl : bUrl;
        expect(request.headers.get('authorization') === `Bearer ${serverUrl === aUrl ? a.token : b.token}`).toBe(true);
        if (new URL(request.url).pathname === '/import/plan') {
          const body = await request.clone().json() as { candidates: Array<{ sessionId: string }> };
          offers.push({ serverUrl, sessions: body.candidates.map((candidate) => candidate.sessionId) });
        }
        return (serverUrl === aUrl ? a : b).fetch(request);
      };
      const run = (serverUrl: string) => runImport({ serverUrl, agent: 'opencode', dryRun: true }, {
        fetch, mycoHome, machineId: TEST_MACHINE_ID, now: Date.now,
      });

      await run(aUrl);
      await run(bUrl);
      expect(offers).toEqual([
        { serverUrl: aUrl, sessions: [sessionId] },
        { serverUrl: bUrl, sessions: [sessionId] },
      ]);

      writeRegistryEntry({ ...entries[1], root: roots[0] }, { mycoHome });
      offers.length = 0;
      await run(bUrl);
      expect(offers).toEqual([{ serverUrl: bUrl, sessions: [sessionId] }]);
    } finally {
      if (previousMycoHome === undefined) delete process.env.MYCO_HOME;
      else process.env.MYCO_HOME = previousMycoHome;
    }
  });

  it('imports into the Deployment it was given, on a machine that belongs to two', async () => {
    const cwd = path.join(os.tmpdir(), 'myco-import-two-a');
    const other = path.join(os.tmpdir(), 'myco-import-two-b');
    const r = await rig([cwd]);
    try {
      const secondary = await memberRig({ projectId: 'proj_9' });
      registerTestMember({ mycoHome: r.mycoHome, token: secondary.token, tokenId: secondary.tokenId, projectId: 'proj_9', serverUrl: 'https://other.invalid', root: other });

      const report = await r.run();
      expect(report.refused).toBeUndefined();
      expect(report.projects.map((p) => p.projectId)).toEqual(['proj_1']);
      // Every request went to the Deployment named, not to whichever sorted first.
      expect(r.planRequests.map((q) => q.project)).toEqual(['proj_1']);
      expect(report.projects[0].agents.reduce((n, a) => n + a.imported, 0)).toBe(2);
    } finally {
      r.restore();
    }
  });

  it('requires an explicit default or repository binding even with one Deployment', async () => {
    const cwd = path.join(os.tmpdir(), 'myco-import-single-bound');
    const r = await rig([cwd]);
    try {
      const deps = { fetch: r.env.fetch, mycoHome: r.mycoHome, machineId: TEST_MACHINE_ID, cwd: os.tmpdir() };
      expect((await runImport({ dryRun: true }, deps)).refused).toContain('--server');
      expect((await runImport({ dryRun: true }, { ...deps, cwd })).refused).toBeUndefined();
      recordDefaultDeployment('https://member-test.invalid', { mycoHome: r.mycoHome });
      expect((await runImport({ dryRun: true }, deps)).refused).toBeUndefined();
    } finally { r.restore(); }
  });

  it('refuses rather than guessing when a machine belongs to two and nothing names one', async () => {
    const cwd = path.join(os.tmpdir(), 'myco-import-ambig-a');
    const other = path.join(os.tmpdir(), 'myco-import-ambig-b');
    const r = await rig([cwd]);
    try {
      registerTestMember({ mycoHome: r.mycoHome, token: r.env.token, tokenId: r.env.tokenId, projectId: 'proj_9', serverUrl: 'https://other.invalid', root: other });
      // No `serverUrl`, and a working directory that names neither binding.
      const report = await runImport({ cwd: os.tmpdir() } as never, { fetch: r.env.fetch, mycoHome: r.mycoHome, machineId: TEST_MACHINE_ID, cwd: os.tmpdir() });
      expect(report.refused).toContain('2 Deployments');
      expect(report.projects).toEqual([]);
    } finally {
      r.restore();
    }
  });
});

describe('the offer cap', () => {
  it('offers the newest and reports the tail it left, whatever order the walk answered in', async () => {
    const cwd = path.join(os.tmpdir(), 'myco-import-cap');
    const r = await rig([cwd], 4);
    try {
      // Age them so the NEWEST are the ones the directory walk answers last:
      // a cap applied during the walk keeps whichever the filesystem listed
      // first, which is neither the newest nor anything a person could predict.
      r.files.forEach((file, i) => age(file, (r.files.length - i) * 60 * 60_000));

      const report = await r.run({ offerLimit: 2 });
      const claude = report.projects[0]?.agents.find((a) => a.agent === 'claude-code');
      expect({ imported: claude?.imported, trimmed: claude?.trimmed, found: claude?.found })
        .toEqual({ imported: 2, trimmed: 2, found: 4 });

      // And the two that landed are the two newest, by session id.
      const sessions = (r.env.env.sqlite.query(`SELECT session_id FROM sessions ORDER BY session_id`).all() as Array<{ session_id: string }>).map((x) => x.session_id);
      expect(sessions).toEqual([path.basename(r.files[2], '.jsonl'), path.basename(r.files[3], '.jsonl')].sort());
    } finally {
      r.restore();
    }
  });
});

describe('a transcript that may still be being written', () => {
  it('is left to the agent writing it, while a stale one beside it is imported', async () => {
    const cwd = path.join(os.tmpdir(), 'myco-import-active');
    const r = await rig([cwd], 2);
    try {
      // One file untouched for an hour, one written a moment ago. Only the
      // stale one is history; importing the fresh one would declare a session
      // over that has not finished, and hand a half-finished session to
      // whatever reads ended sessions.
      const stale = new Date(Date.now() - 60 * 60_000);
      fs.utimesSync(r.files[0], stale, stale);
      fs.utimesSync(r.files[1], new Date(), new Date());

      const report = await r.run();
      const claude = report.projects[0]?.agents.find((a) => a.agent === 'claude-code');
      expect({ imported: claude?.imported, active: report.active }).toEqual({ imported: 1, active: 1 });

      // The one that was shipped is the stale one, named rather than inferred.
      const sessions = (r.env.env.sqlite.query(`SELECT session_id FROM sessions ORDER BY session_id`).all() as Array<{ session_id: string }>).map((x) => x.session_id);
      expect(sessions).toEqual([path.basename(r.files[0], '.jsonl')]);

      // And once it goes quiet, the same import takes it: the floor defers, it
      // does not exclude.
      fs.utimesSync(r.files[1], stale, stale);
      const second = await r.run();
      expect({ imported: second.projects[0]?.agents.find((a) => a.agent === 'claude-code')?.imported, active: second.active }).toEqual({ imported: 1, active: 0 });
    } finally {
      r.restore();
    }
  });
});

describe('what an import leaves behind, and what stops it', () => {
  it('resumes a killed pass from the byte the Deployment acknowledged', async () => {
    const cwd = path.join(os.tmpdir(), 'myco-import-resume');
    const r = await rig([cwd], 1);
    try {
      // The first pass dies after the plan and before any segment lands.
      let planned = false;
      const dying = async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (planned && url.includes('/events')) throw new Error('connection lost');
        if (url.includes('/import/plan')) planned = true;
        return r.env.fetch(input, init);
      };
      await runImport({ serverUrl: 'https://member-test.invalid' }, { fetch: dying, mycoHome: r.mycoHome, machineId: TEST_MACHINE_ID }).catch(() => null);

      // The second pass completes, and lands what an uninterrupted one would:
      // the state file carries the pointer, nothing else is remembered between
      // runs. Deriving those bytes into rows is the Deployment's half and its
      // own tick's; what is asserted here is that the bytes arrived exactly once.
      await r.run();
      const complete = r.snapshot();
      expect({ segments: complete.segments, sessions: complete.sessions }).toEqual({ segments: 1, sessions: 1 });

      // And a third pass over the completed session ships nothing more.
      r.resetUploads();
      await r.run();
      expect({ snapshot: r.snapshot(), uploads: r.uploadCount() }).toEqual({ snapshot: complete, uploads: 0 });
    } finally {
      r.restore();
    }
  });

  it('leaves session state that ages out on the same clock a captured session\'s does', async () => {
    const cwd = path.join(os.tmpdir(), 'myco-import-gc');
    const r = await rig([cwd], 1);
    try {
      await r.run();
      const spoolDir = spoolDirFor({ projectId: 'proj_1', serverUrl: 'https://member-test.invalid' }, r.mycoHome);
      const states = fs.readdirSync(spoolDir).filter((f) => f.endsWith('.state.json'));
      expect(states.length).toBe(1);
      // Stamped, so retention has a clock to age it on. State with no
      // `startedAt` and no `lastAckAt` is state nothing ever collects.
      const state = JSON.parse(fs.readFileSync(path.join(spoolDir, states[0]), 'utf8')) as { startedAt?: number; lastAckAt?: number };
      expect({ hasClock: state.startedAt !== undefined || state.lastAckAt !== undefined }).toEqual({ hasClock: true });
    } finally {
      r.restore();
    }
  });
});

describe('the stores Myco writes for a harness that keeps none', () => {
  it('derives rows from a Pi-shaped store end to end, through the import and the parse', async () => {
    const cwd = path.join(os.tmpdir(), 'myco-import-pi');
    const r = await rig([cwd], 0);
    try {
      // Pi's own layout and Pi's own record shape: the turn is nested one level
      // down under `message`, which no other parser reads. Shipping bytes that
      // derive nothing would spend a member's quota for no rows, so this is
      // asserted through the parse rather than at the segment.
      const session = '00000000-0000-4000-8000-0000000000f1';
      const dir = path.join(r.home, '.pi', 'agent', 'sessions', 'proj');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `2026-09-01T10-00-00_${session}.jsonl`);
      // Pi's real recorded shape, from the fixture the parser's own tests read,
      // with only the working directory rewritten to this checkout. Hand-typing
      // the records here would let Pi's format move without this noticing.
      const source = fs.readFileSync(new URL('../fixtures/pi-parse-basic.jsonl', import.meta.url), 'utf8');
      fs.writeFileSync(file, source.split('\n').filter((l) => l.trim() !== '')
        .map((line) => {
          const record = JSON.parse(line) as Record<string, unknown>;
          if (typeof record.cwd === 'string') record.cwd = cwd;
          return JSON.stringify(record);
        }).join('\n') + '\n');
      age(file);

      const report = await r.run();
      expect(report.projects[0]?.agents.find((a) => a.agent === 'pi')?.imported).toBe(1);

      // The bytes are in; now the Deployment reads them. Rows, not just segments.
      await parseTranscripts(r.env.env.serverEnv, Date.now());
      const prompts = r.env.env.sqlite.query(`SELECT text FROM prompt_batches`).all() as Array<{ text: string | null }>;
      // Rows, not segments: shipping bytes nothing can read would spend a
      // member's quota for no history. Pi's turn is nested a level down under
      // `message`, which no other parser reads.
      expect(prompts.length).toBeGreaterThan(0);
      const responses = r.env.env.sqlite.query(`SELECT COUNT(*) AS n FROM responses`).get() as { n: number };
      const calls = r.env.env.sqlite.query(`SELECT COUNT(*) AS n FROM tool_calls`).get() as { n: number };
      expect({ responses: responses.n > 0, calls: calls.n > 0 }).toEqual({ responses: true, calls: true });
    } finally {
      r.restore();
    }
  });

  it('counts a store pruned under a pass as removed, never as imported', async () => {
    const cwd = path.join(os.tmpdir(), 'myco-import-pruned');
    // THREE files, not one. With a single file "ended cleanly" and "counted a
    // file it never sent" look identical; with three, one surviving import
    // separates them, and a pass that called every vanished file imported reads
    // as three imported for zero bytes shipped.
    const r = await rig([cwd], 3);
    try {
      let planned = false;
      const pruning = async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('/import/plan')) {
          planned = true;
          const answer = await r.env.fetch(input, init);
          // Admitted, then gone: Myco writes and prunes some of these stores,
          // so a file can disappear between the plan and the ship.
          for (const file of r.files.slice(1)) { try { fs.unlinkSync(file); } catch { /* already gone */ } }
          return answer;
        }
        return r.env.fetch(input, init);
      };
      const report = await runImport({ serverUrl: 'https://member-test.invalid' }, { fetch: pruning, mycoHome: r.mycoHome, machineId: TEST_MACHINE_ID });
      expect(planned).toBe(true);
      expect(report.refused).toBeUndefined();

      const claude = report.projects[0]?.agents.find((a) => a.agent === 'claude-code');
      expect({ imported: claude?.imported, vanished: claude?.vanished }).toEqual({ imported: 1, vanished: 2 });

      // And the count is the truth: exactly one session's bytes reached the
      // Deployment, not three.
      const rows = r.env.env.sqlite.query(`SELECT COUNT(*) AS n FROM transcript_segments`).get() as { n: number };
      expect(rows.n).toBe(1);

      // What did land is coherent: the parse reaches the end of what is held
      // rather than waiting on bytes nothing will send.
      await parseTranscripts(r.env.env.serverEnv, Date.now());
      const transcripts = r.env.env.sqlite.query(`SELECT size, parsed_offset, parse_error FROM transcripts`).all() as Array<{ size: number; parsed_offset: number; parse_error: string | null }>;
      for (const row of transcripts) expect({ complete: row.parsed_offset >= row.size, error: row.parse_error }).toEqual({ complete: true, error: null });
    } finally {
      r.restore();
    }
  });
});

describe('what an import will not read', () => {
  it('refuses any path inside the member’s own state, whatever a manifest declares', () => {
    const home = '/fixture/myco-home';
    for (const inside of ['spool/proj_1/s1.jsonl', 'spool/proj_1/blobs/abc', 'deployments/aaaa.json', 'projects/bbbb.json']) {
      expect({ path: inside, refused: isMemberStatePath(`${home}/member/${inside}`, home) }).toEqual({ path: inside, refused: true });
    }
    // A store Myco keeps beside its own state is not its own state.
    expect(isMemberStatePath(`${home}/member/transcripts/opencode/s1.jsonl`, home)).toBe(false);
  });

  it('holds every shipped manifest’s roots outside the member state tree', () => {
    const home = '/fixture/myco-home-gate';
    const env = { ...process.env, HOME: '/fixture/fake-home', MYCO_HOME: home };
    const offenders: string[] = [];
    for (const manifest of BUNDLED_MANIFESTS) {
      for (const root of manifestTranscriptDiscovery(manifest.name)?.roots ?? []) {
        const expanded = expandRoot(root, env);
        if (isMemberStatePath(`${expanded}/any/file.jsonl`, home)) offenders.push(`${manifest.name}: ${root}`);
      }
    }
    // Read from the shipped manifests rather than a list here, so a manifest
    // added later is covered without an edit.
    expect(offenders).toEqual([]);
  });
});

describe('attributing a transcript to a checkout', () => {
  it('matches a store that names its directory after the project root, in both spellings', () => {
    const root = '/Users/someone/Repos/myco';
    expect(attributeByPathSlug(`/h/.cursor/projects/${rootSlug(root)}/agent-transcripts/s.jsonl`, [root])).toBe(root);
    expect(attributeByPathSlug(`/h/.claude/projects/-${rootSlug(root)}/s.jsonl`, [root])).toBe(root);
    // A directory named after nothing is not a match; a guess here files one
    // project's history under another.
    expect(attributeByPathSlug('/h/.cursor/projects/1778382652592/agent-transcripts/s.jsonl', [root])).toBeNull();
    expect(attributeByPathSlug('/h/.cursor/projects/empty-window/agent-transcripts/s.jsonl', [root])).toBeNull();
  });

  it('reads the working directory a manifest declares, in preference to the path', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-attr-'));
    const recorded = path.join(dir, 'recorded');
    const other = path.join(dir, 'other');
    fs.mkdirSync(path.join(recorded, 'packages', 'x'), { recursive: true });
    expect(Bun.spawnSync(['git', 'init', '-q', recorded], { stdout: 'ignore', stderr: 'ignore' }).exitCode).toBe(0);
    // The file sits in a directory named after `other`, and records `recorded`.
    // The header wins, so a store that names one project in its path and
    // another in its content is placed by what the session actually ran in.
    const nested = path.join(dir, `-${rootSlug(other)}`);
    fs.mkdirSync(nested, { recursive: true });
    const file = path.join(nested, 's.jsonl');
    fs.writeFileSync(file, transcript(1).replace('/PLACEHOLDER', recorded));

    expect(attributeTranscript('claude-code', file, [recorded, other])).toEqual({ kind: 'bound', root: recorded });
    // A subdirectory of a checkout is that checkout: an agent started deeper in
    // the tree records the deeper path.
    fs.writeFileSync(file, transcript(1).replace('/PLACEHOLDER', path.join(recorded, 'packages', 'x')));
    expect(attributeTranscript('claude-code', file, [recorded])).toEqual({ kind: 'bound', root: recorded });
    // A recorded directory under no known root is named, not discarded.
    expect(attributeTranscript('claude-code', file, [other])).toEqual({ kind: 'elsewhere', directory: path.join(recorded, 'packages', 'x') });
  });

  it('falls back to the path only where no working directory is recorded', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-attr-slug-'));
    const root = path.join(os.tmpdir(), 'myco-attr-slugroot');
    const nested = path.join(dir, `-${rootSlug(root)}`);
    fs.mkdirSync(nested, { recursive: true });
    const file = path.join(nested, 's.jsonl');
    // No `cwd` key at all — the shape cursor and the reduced-tier harnesses have.
    fs.writeFileSync(file, transcript(1).replace('"cwd":"/PLACEHOLDER",', ''));
    expect(attributeTranscript('claude-code', file, [root])).toEqual({ kind: 'bound', root });
    expect(attributeTranscript('claude-code', file, [])).toEqual({ kind: 'unknown' });
  });
});

describe('an import the Deployment rate-limits', () => {
  it('waits and runs another pass until every session is sent', async () => {
    const cwd = path.join(os.tmpdir(), 'myco-import-limited');
    const r = await rig([cwd], 3);
    try {
      let limited = 2;
      const limitedFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        if (limited > 0 && new URL(new Request(input, init).url).pathname === '/events') { limited -= 1; return new Response('slow down', { status: 429 }); }
        return r.env.fetch(input, init);
      };
      const waits: number[] = [];
      const report = await importUntilSettled({ serverUrl: 'https://member-test.invalid' }, {
        fetch: limitedFetch, mycoHome: r.mycoHome, machineId: TEST_MACHINE_ID, now: () => Date.now(), sleep: async (ms) => { waits.push(ms); },
      });
      expect(waits.length).toBeGreaterThan(0);
      expect(report.projects.every((p) => p.endedBy === undefined)).toBe(true);
      expect(r.env.rows('transcripts')).toBe(3);
    } finally {
      r.restore();
    }
  });
});

describe('import explains upload failures', () => {
  for (const [kind, fix] of [
    ['edge', 'Cloudflare Security Events'], ['edge-mid', 'Cloudflare Security Events'], ['worker', 'check this machine'],
    ['server', 'check its health'],
    ['refused', 'correct the source record'], ['held', 'update the Deployment'],
    ['large', 'reduce that record'],
    ['interrupted', 'resume safely'],
  ] as const) {
    it(`prints grouped causes and stoppedBy for ${kind}`, async () => {
      const r = await rig([path.join(os.tmpdir(), `import-feedback-${kind}`)], 2);
      const controller = new AbortController();
        const edge = refuseImportAfter(2, r.env.fetch);
      try {
        const lines: string[] = [];
        let failures = 0;
        const fetch: typeof r.env.fetch = async (input, init) => {
          const route = new URL(new Request(input, init).url).pathname;
          if (kind === 'edge-mid') return edge.fetchImpl(input, init);
          if (kind === 'worker' && route === '/import/plan') return new Response('forbidden', { status: 403, headers: { 'x-myco-protocol': '1' } });
          if ((kind === 'edge' || kind === 'server') && route === '/import/plan') {
            failures += 1;
            return new Response('upstream', { status: kind === 'edge' ? 403 : 500 });
          }
          if (route === '/events') {
            if (kind === 'interrupted') { controller.abort(); throw new DOMException('stopped', 'AbortError'); }
            if (kind === 'refused' || kind === 'large' || kind === 'held') return Response.json({ persisted: false, code: kind === 'large' ? 'body_cap' : kind === 'held' ? 'unknown_field' : 'invalid_field', reason: 'fixture' }, { headers: { 'x-myco-protocol': '1' } });
          }
          return r.env.fetch(input, init);
        };
        const ok = await runImportCli(['--server', 'https://member-test.invalid', '--days', '3650'], {
          fetch, signal: controller.signal, mycoHome: r.mycoHome, machineId: TEST_MACHINE_ID, sleep: async () => {},
          stdout: (l) => lines.push(l), stderr: (l) => lines.push(l),
        });
        expect(ok).toBe(false);
        const output = lines.join('\n');
        expect(output).toMatch(/\d+ import problems?:/);
        expect(output.split('\n').find((l) => l.startsWith('stoppedBy:'))).toContain(fix);
        if (kind === 'edge') { expect(output).toContain('likely a security rule'); expect(failures).toBe(1); }
        if (kind === 'server') expect(failures).toBe(4);
        if (kind === 'held') {
          lines.length = 0;
          await runImportCli(['--server', 'https://member-test.invalid', '--days', '3650'], {
            fetch, mycoHome: r.mycoHome, machineId: TEST_MACHINE_ID, sleep: async () => {},
            stdout: (l) => lines.push(l), stderr: (l) => lines.push(l),
          });
          expect(lines.join('\n')).toContain('1 import problem: the Deployment does not accept a field');
          expect(lines.find((l) => l.startsWith('stoppedBy:'))).toContain('update the Deployment');
        }

        if (kind === 'worker') expect(output).not.toContain('likely a security rule');
        if (kind === 'interrupted' || kind === 'edge' || kind === 'edge-mid' || kind === 'server' || kind === 'worker') {
          await r.run();
          expect(r.snapshot().sessions).toBe(2);
        }
      } finally { r.restore(); }
    });
  }

  it('prints progress while a project is uploading, with acknowledged session counts', async () => {
    const r = await rig([path.join(os.tmpdir(), 'import-feedback-progress')], 3);
    const lines: string[] = [];
    let clock = Date.now();
    let events = 0;
    try {
      await runImport({ serverUrl: 'https://member-test.invalid', windowDays: 3650 }, {
        mycoHome: r.mycoHome, machineId: TEST_MACHINE_ID, now: () => clock,
        fetch: async (input, init) => { clock += 6_000; if (String(input).endsWith('/events')) events += 1; return r.env.fetch(input, init); },
        progress: (l) => lines.push(`${events}: ${l}`),
      });
      expect(lines.some((l) => l.includes('1 imported') && !l.includes('3 imported'))).toBe(true);
      expect(lines.some((l) => l.includes('0 imported') && l.includes('safe to stop and run again'))).toBe(true);
      expect(lines.at(-1)).toContain('3 imported');
    } finally { r.restore(); }
  });
});

describe('import retry explanations', () => {
  for (const [failure, words] of [
    [429, 'HTTP 429'], [503, 'HTTP 503'],
    ['timeout', 'request timed out'], ['network', 'network request failed'],
  ] as const) {
    it(`names ${failure} while waiting and resumes safely`, async () => {
      const r = await rig([path.join(os.tmpdir(), `retry-cause-${failure}`)], 1);
      const lines: string[] = [];
      let failed = false;
      try {
        const report = await importUntilSettled({ serverUrl: 'https://member-test.invalid', windowDays: 3650 }, {
          mycoHome: r.mycoHome, machineId: TEST_MACHINE_ID, sleep: async () => {},
          progress: (line) => lines.push(line),
          fetch: async (input, init) => {
            if (!failed && String(input).endsWith('/import/plan')) {
              failed = true;
              if (failure === 'timeout') throw new DOMException('fixture', 'TimeoutError');
              if (failure === 'network') throw new Error('private transport detail');
              return new Response('fixture', { status: failure });
            }
            return r.env.fetch(input, init);
          },
        });
        expect(report.projects[0].endedBy).toBeUndefined();
        expect(lines.some((line) => line.includes(words) && line.includes('trying again') && line.includes('safe to stop and run again'))).toBe(true);
        expect(lines.join('\n')).not.toContain('private transport detail');
        expect(r.snapshot().sessions).toBe(1);
      } finally { r.restore(); }
    });
  }
});

import { IMPORT_FAULTS, faultAt, importSnapshot } from './helpers/import-differential.js';

describe('transcript fault/resume differential', () => {
  for (const persistent of [false, true]) for (const kind of IMPORT_FAULTS) {
    it(`${kind}, ${persistent ? 'persistent' : 'single'} at every request: resume equals uninterrupted rows`, async () => {
      const cwds = [path.join(os.tmpdir(), 'differential-a'), path.join(os.tmpdir(), 'differential-b')];
      const base = await rig(cwds, 1);
      fs.appendFileSync(base.files[0]!, ' '.repeat(600_000));
      age(base.files[0]!);
      const counter = faultAt(base.env.fetch, Infinity, kind, false, new AbortController());
      const options = { serverUrl: 'https://member-test.invalid', windowDays: 3650 };
      const deps = { machineId: TEST_MACHINE_ID, sleep: async () => {}, maxPasses: 2 };
      await importUntilSettled(options, { ...deps, fetch: counter.fetch, mycoHome: base.mycoHome });
      const baseline = importSnapshot(base.env.env.sqlite);
      base.restore();
      for (let index = 1; index <= counter.count(); index += 1) {
        const r = await rig(cwds, 1, base);
        const controller = new AbortController();
        const fault = faultAt(r.env.fetch, index, kind, persistent, controller);
        try {
          await runImport(options, { ...deps, fetch: fault.fetch, mycoHome: r.mycoHome, signal: controller.signal });
          const resumed = await importUntilSettled(options, { ...deps, fetch: r.env.fetch, mycoHome: r.mycoHome });
          expect(resumed.projects.every((p) => p.endedBy === undefined && !p.notAttempted), `${kind} ${persistent} request ${index}`).toBe(true);
          expect(importSnapshot(r.env.env.sqlite), `${kind} ${persistent} request ${index}`).toEqual(baseline);
        } finally { r.restore(); }
      }
    }, 60_000);
  }

  it('resumes at the acknowledged offset and sends only the remaining transcript bytes', async () => {
    const r = await rig([path.join(os.tmpdir(), 'resume-byte-count')], 1);
    try {
      fs.appendFileSync(r.files[0]!, ' '.repeat(600_000));
      age(r.files[0]!);
      let segments = 0;
      const controller = new AbortController();
      const first: typeof r.env.fetch = async (input, init) => {
        const req = new Request(input, init);
        const event = new URL(req.url).pathname === '/events' ? await req.clone().json() as { kind: string } : null;
        const response = await r.env.fetch(req);
        if (event?.kind === 'transcript.segment' && ++segments === 1) controller.abort();
        return response;
      };
      const options = { serverUrl: 'https://member-test.invalid', windowDays: 3650 };
      const deps = { mycoHome: r.mycoHome, machineId: TEST_MACHINE_ID, sleep: async () => {} };
      await runImport(options, { ...deps, fetch: first, signal: controller.signal });
      fs.appendFileSync(r.files[0]!, ' '.repeat(100_000));
      age(r.files[0]!);
      const held = r.env.env.sqlite.query('SELECT size FROM transcripts').get() as { size: number };
      expect(held.size).toBeGreaterThan(0);
      expect(held.size).toBeLessThan(fs.statSync(r.files[0]!).size);
      let sent = 0;
      const resume: typeof r.env.fetch = async (input, init) => {
        const req = new Request(input, init);
        if (new URL(req.url).pathname.startsWith('/blobs/')) sent += (await req.clone().arrayBuffer()).byteLength;
        return r.env.fetch(req);
      };
      await importUntilSettled(options, { ...deps, fetch: resume });
      expect(sent).toBe(fs.statSync(r.files[0]!).size - held.size);
    } finally { r.restore(); }
  });

  it('continues after a refused project plan and names unreached projects after a transport stop', async () => {
    const r = await rig([path.join(os.tmpdir(), 'continue-a'), path.join(os.tmpdir(), 'continue-b')], 1);
    try {
      const opts = { serverUrl: 'https://member-test.invalid' };
      const deps = { mycoHome: r.mycoHome, machineId: TEST_MACHINE_ID };
      let first = true;
      const refused: typeof r.env.fetch = async (input, init) => {
        if (first) { first = false; return Response.json({ persisted: false, code: 'forbidden', reason: 'project closed' }); }
        return r.env.fetch(input, init);
      };
      const report = await runImport(opts, { ...deps, fetch: refused });
      expect(report.projects).toHaveLength(2);
      expect(report.projects[1]!.agents[0]!.imported).toBe(1);
      const { reportLines } = await import('@myco/cli/import.js');
      const lines = reportLines(report, false).join('\n');
      expect(lines).toContain('1 import problem: forbidden: project closed');
      expect(lines).not.toContain('stoppedBy:');
      const stopped = await runImport(opts, { ...deps, fetch: async () => new Response('blocked', { status: 403 }) });
      expect(stopped.projects[1]!.notAttempted).toBe(true);
      expect(reportLines(stopped, false).join('\n')).toContain(stopped.projects[1]!.projectId);
      expect(reportLines(stopped, false).join('\n')).toContain('not attempted');
    } finally { r.restore(); }
  });
});


describe('worktree capture and import attribution (#1722)', () => {
  function repository(base: string, name: string): { root: string; tree: string } {
    const root = path.join(base, 'Repos', name);
    const tree = path.join(base, '.herdr', 'worktrees', name, 'feature');
    fs.mkdirSync(root, { recursive: true });
    const git = (...args: string[]) => {
      expect(Bun.spawnSync(['git', ...args], { cwd: root, stdout: 'ignore', stderr: 'ignore' }).exitCode).toBe(0);
    };
    git('init', '-q', '-b', 'main');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
    git('worktree', 'add', '-q', '-b', 'feature', tree);
    fs.mkdirSync(path.join(tree, 'src'));
    return { root, tree };
  }

  it('captures and imports a connected worktree under the same repository Project', async () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-worktree-')));
    const { root, tree } = repository(base, 'connected');
    const cwd = path.join(tree, 'src');
    const r = await rig([root], 1, store(base, [cwd], 1));
    const heldHome = process.env.MYCO_HOME;
    process.env.MYCO_HOME = r.mycoHome;
    resetMachineIdCache();
    try {
      const credential = resolveCredential('registry', { cwd, mycoHome: r.mycoHome });
      expect(credential?.projectId).toBe('proj_1');
      expect(credential?.root).toBe(root);
      expect(repositoryAt(cwd, r.mycoHome).root).toBe(root);
      const liveFile = path.join(base, 'live.jsonl');
      fs.writeFileSync(liveFile, transcript(2).replace('/PLACEHOLDER', cwd));
      const live = await runHook('session-start', { cwd, session_id: 'worktree-live-session', transcript_path: liveFile, source: 'startup' }, { fetch: r.env.fetch, helpers: 'run' });
      expect(live.stderr).not.toContain('dropped');
      expect(live.stderr).not.toContain('no registry entry');
      expect(r.env.env.sqlite.query('SELECT project_id FROM sessions WHERE session_id = ?').get('worktree-live-session')).toEqual({ project_id: 'proj_1' });
      const report = await r.run();
      expect(report.unbound).toBe(0);
      expect(report.projects.map((p) => [p.projectId, p.agents[0].imported])).toEqual([['proj_1', 1]]);
      expect(r.planRequests).toEqual([{ project: credential!.projectId, sessions: [path.basename(r.files[0], '.jsonl')] }]);
    } finally {
      r.restore();
      if (heldHome === undefined) delete process.env.MYCO_HOME; else process.env.MYCO_HOME = heldHome;
      resetMachineIdCache();
    }
  });

  it('reports an unconnected worktree and a pruned path-shaped lookalike without importing either', async () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-worktree-')));
    const connected = repository(base, 'connected');
    const unconnected = repository(base, 'unconnected');
    const lookalike = path.join(base, '.herdr', 'worktrees', 'connected', 'never-registered');
    const r = await rig([connected.root], 1, store(base, [unconnected.tree, lookalike], 1));
    try {
      recordDefaultDeployment('https://member-test.invalid', { mycoHome: r.mycoHome });
      const report = await r.run({ mappings: [{ from: base, to: connected.root }] });
      // An explicit mapping can admit the unknown path, but never the other repository.
      expect(report.unboundDirectories).toEqual({ [unconnected.tree]: 1 });
      expect(reportLines(report, false).join('\n')).not.toContain('--map');
      const unmapped = await r.run();
      expect(unmapped.unboundDirectories).toEqual({ [unconnected.tree]: 1, [lookalike]: 1 });
      expect(unmapped.projects).toEqual([]);
      const out: string[] = [];
      await runImportCli(['--server', 'https://member-test.invalid', '--agent', 'claude-code', '--dry-run'], {
        mycoHome: r.mycoHome, fetch: r.env.fetch, machineId: TEST_MACHINE_ID, stdout: (l) => out.push(l), stderr: (l) => out.push(l),
      });
      expect(out.join('\n')).toContain('--map');
    } finally { r.restore(); }
  });

  it('refuses a deleted cwd claimed by two connected repositories', async () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-worktree-')));
    const first = repository(base, 'first'); const second = repository(base, 'second');
    const gone = path.join(base, 'ambiguous', 'src');
    for (const root of [first.root, second.root]) {
      const record = path.join(root, '.git', 'worktrees', 'claim');
      fs.mkdirSync(record, { recursive: true });
      fs.writeFileSync(path.join(record, 'gitdir'), `${path.dirname(gone)}/.git\n`);
      fs.writeFileSync(path.join(record, 'commondir'), '../..\n');
    }
    const r = await rig([first.root, second.root], 1, store(base, [gone], 1));
    try {
      const report = await r.run();
      expect(report.projects).toEqual([]);
      expect(report.unboundDirectories).toEqual({ [gone]: 1 });
      expect(r.planRequests).toEqual([]);
    } finally { r.restore(); }
  });

  it('keeps literal personal registry bindings out of the work-default hold', async () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-worktree-')));
    const personal = repository(base, 'Homelab');
    const alias = path.join(base, 'homelab-alias');
    fs.symlinkSync(personal.root, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const spellings = [alias];
    if (process.platform === 'darwin') {
      spellings.push(personal.root.replace('/Homelab', '/HOMELAB'));
      const temporaryAlias = path.join(path.parse(personal.root).root, 'tmp');
      const physicalTemporary = fs.realpathSync(temporaryAlias);
      const relative = path.relative(physicalTemporary, personal.root);
      if (!relative.startsWith('..') && !path.isAbsolute(relative)) spellings.push(path.join(temporaryAlias, relative));
    }
    for (const root of spellings) {
      const r = await rig([root], 1, store(base, [path.join(root, 'src')], 1));
      fs.mkdirSync(path.join(root, 'src'), { recursive: true });
      const held = process.env.MYCO_HOME;
      process.env.MYCO_HOME = r.mycoHome;
      try {
        recordDefaultDeployment('http://127.0.0.1:9102', { mycoHome: r.mycoHome });
        registerTestMember({ mycoHome: r.mycoHome, root, serverUrl: 'http://127.0.0.1:9101', projectId: 'proj_homelab', token: r.env.token, tokenId: r.env.tokenId });
        let holds = 0;
        const credential = resolveCredential('registry', { cwd: path.join(root, 'src'), mycoHome: r.mycoHome, claimsUnconnected: () => { holds += 1; return true; } });
        expect(credential).toMatchObject({ root, projectId: 'proj_homelab', serverUrl: 'http://127.0.0.1:9101' });
        expect(holds).toBe(0);
        const live = await runHook('session-start', { cwd: path.join(root, 'src'), session_id: 'alias-personal', transcript_path: r.files[0], source: 'startup' }, { fetch: async () => { throw new Error('ECONNREFUSED'); } });
        expect(live.stderr).toBe('');
        const spool = new MemberSpool(readRegistryEntry(root, r.mycoHome)!, { mycoHome: r.mycoHome });
        expect(spool.readRecords('alias-personal').some((record) => record?.kind === 'session.start')).toBe(true);
        expect(repositoryAt(root, r.mycoHome).rootKey).toBe(rootKeyFor(root, r.mycoHome));
        const report = await r.run();
        expect(report.projects).toEqual([]);
        expect(r.planRequests).toEqual([]);
      } finally {
        r.restore();
        if (held === undefined) delete process.env.MYCO_HOME; else process.env.MYCO_HOME = held;
      }
    }
  });

  it('keeps GIT_DIR-only steering on personal from nested and linked working directories', async () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-worktree-')));
    const { root, tree } = repository(base, 'homelab-steered');
    const nested = path.join(root, 'sub', 'deep'); fs.mkdirSync(nested, { recursive: true });
    const r = await rig([root], 1, store(base, [nested], 1));
    const held = { MYCO_HOME: process.env.MYCO_HOME, GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE };
    process.env.MYCO_HOME = r.mycoHome; process.env.GIT_DIR = path.join(root, '.git'); delete process.env.GIT_WORK_TREE;
    try {
      recordDefaultDeployment('http://127.0.0.1:9102', { mycoHome: r.mycoHome });
      registerTestMember({ mycoHome: r.mycoHome, root, serverUrl: 'http://127.0.0.1:9101', projectId: 'proj_homelab', token: r.env.token, tokenId: r.env.tokenId });
      for (const [i, cwd] of [nested, tree].entries()) {
        let holds = 0;
        expect(resolveCredential('registry', { cwd, mycoHome: r.mycoHome, claimsUnconnected: () => { holds += 1; return true; } })).toMatchObject({ root, projectId: 'proj_homelab', serverUrl: 'http://127.0.0.1:9101' });
        expect(holds).toBe(0);
        const session = `steered-personal-${i}`;
        const live = await runHook('session-start', { cwd, session_id: session, transcript_path: r.files[0], source: 'startup' }, { fetch: async () => { throw new Error('ECONNREFUSED'); } });
        expect(live.stderr).toBe('');
        expect(new MemberSpool(readRegistryEntry(root, r.mycoHome)!, { mycoHome: r.mycoHome }).readRecords(session).some((record) => record?.kind === 'session.start')).toBe(true);
      }
    } finally {
      for (const [name, value] of Object.entries(held)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
      r.restore();
    }
  });

  it('excludes a connected scratch worktree from live capture, plugin routing and import alike', async () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-worktree-')));
    const { root } = repository(base, 'scratch-main');
    const tree = path.join(os.tmpdir(), 'claude-test', crypto.randomUUID(), 'scratchpad', 'lane');
    expect(Bun.spawnSync(['git', 'worktree', 'add', '-q', '-b', 'scratch', tree], { cwd: root, stdout: 'ignore', stderr: 'ignore' }).exitCode).toBe(0);
    const r = await rig([root], 1, store(base, [tree], 1));
    const held = process.env.MYCO_HOME; process.env.MYCO_HOME = r.mycoHome;
    try {
      expect(resolveCredential('registry', { cwd: tree, mycoHome: r.mycoHome })?.projectId).toBe('proj_1');
      const upstream = resolveDeploymentUpstream('registry', { cwd: tree, mycoHome: r.mycoHome });
      expect(upstream?.projectId).toBe('proj_1');
      const client = new Client({ name: 'scratch-read', version: '1' });
      try {
        await client.connect(deploymentTransport(upstream!, {}, r.env.fetch));
        const tools = await client.listTools();
        expect(tools.tools.some((tool) => tool.name === 'myco_search')).toBe(true);
      } finally { await client.close(); }
      const live = await runHook('session-start', { cwd: tree, session_id: 'scratch-live', transcript_path: r.files[0], source: 'startup' }, { fetch: async () => { throw new Error('ECONNREFUSED'); } });
      expect(live.stderr).toBe('[myco] member: agent scratch directory — no capture\n');
      expect(live.starts).toEqual([]);
      expect(() => memberTranscriptRoutingKey('registry', tree, r.mycoHome, process.env)).toThrow(live.stderr.trim());
      expect(fs.existsSync(path.join(r.mycoHome, 'member', 'transcripts'))).toBe(false);
      const spool = new MemberSpool(readRegistryEntry(root, r.mycoHome)!, { mycoHome: r.mycoHome });
      expect(spool.readRecords('scratch-live')).toEqual([]);
      const report = await r.run();
      expect(report.projects).toEqual([]); expect(report.dropped).toBe(1);
      expect(r.planRequests).toEqual([]);
    } finally {
      r.restore();
      if (held === undefined) delete process.env.MYCO_HOME; else process.env.MYCO_HOME = held;
    }
  });

  it('recovers a deleted worktree only while its retained Git record proves the repository', async () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-worktree-')));
    const { root, tree } = repository(base, 'deleted');
    const r = await rig([root], 1, store(base, [path.join(tree, 'src')], 1));
    try {
      fs.rmSync(tree, { recursive: true });
      const report = await r.run();
      expect(report.projects.map((p) => [p.projectId, p.agents[0].imported])).toEqual([['proj_1', 1]]);
      expect(Bun.spawnSync(['git', 'worktree', 'prune'], { cwd: root, stdout: 'ignore', stderr: 'ignore' }).exitCode).toBe(0);
      const pruned = await r.run();
      expect(pruned.projects).toEqual([]);
      expect(pruned.unboundDirectories).toEqual({ [path.join(tree, 'src')]: 1 });
    } finally { r.restore(); }
  });

  it('excludes scratch transcripts before offering history, even with an explicit map', async () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-worktree-')));
    const { root } = repository(base, 'connected');
    const scratch = path.join(os.tmpdir(), 'claude-501', 'project', 'scratchpad', 'agent');
    const r = await rig([root], 1, store(base, [scratch], 1));
    try {
      const report = await r.run({ mappings: [{ from: os.tmpdir(), to: root }] });
      expect(report.projects).toEqual([]);
      expect(report.dropped).toBe(1);
      expect(r.planRequests).toEqual([]);
    } finally { r.restore(); }
  });

  it('keeps a personal homelab worktree off work, including deleted records and explicit maps', async () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-worktree-')));
    const work = repository(base, 'work');
    const personal = repository(base, 'homelab');
    const missingCwd = path.join(personal.tree, 'removed-directory');
    const r = await rig([work.root], 1, store(base, [personal.tree, missingCwd], 1));
    const personalServer = await memberRig();
    try {
      registerTestMember({ mycoHome: r.mycoHome, root: personal.root, serverUrl: 'https://personal-test.invalid', projectId: 'proj_1', token: personalServer.token, tokenId: personalServer.tokenId });
      recordDefaultDeployment('https://member-test.invalid', { mycoHome: r.mycoHome });
      for (const deleted of [false, true]) {
        if (deleted) fs.rmSync(personal.tree, { recursive: true });
        const report = await r.run({ mappings: [{ from: base, to: work.root }] });
        expect(report.projects).toEqual([]);
        expect(report.unboundDirectories).toEqual({ [personal.tree]: 1, [missingCwd]: 1 });
        expect(r.planRequests).toEqual([]);
        const imported = await runImport({ serverUrl: 'https://personal-test.invalid' }, { fetch: personalServer.fetch, mycoHome: r.mycoHome, machineId: TEST_MACHINE_ID });
        expect(imported.projects.map((p) => [p.projectId, p.agents[0].imported])).toEqual([['proj_1', deleted ? 0 : 2]]);
      }
    } finally { r.restore(); }
  });
});
