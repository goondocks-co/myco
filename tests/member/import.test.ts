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
import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runImport, isMemberStatePath, type ImportOptions } from '@myco/member/import.js';
import { attributeByPathSlug, attributeTranscript, rootSlug } from '@myco/symbionts/transcript-attribution.js';
import { BUNDLED_MANIFESTS } from '@myco/symbionts/manifests.generated.js';
import { expandRoot, manifestTranscriptDiscovery } from '@myco/symbionts/transcript-discovery.js';
import { parseTranscripts } from '@myco-server-worker/ingest/parse.js';
import { memberRig, tempMycoHome, TEST_MACHINE_ID } from './helpers/server.js';
import { registerTestMember } from './helpers/hooks.js';

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

async function rig(cwds: readonly string[], perCwd = 2) {
  const env = await memberRig();
  const mycoHome = tempMycoHome();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-import-'));
  const { home, files } = store(root, cwds, perCwd);
  const held = process.env.HOME;
  process.env.HOME = home;

  // ONE PROJECT PER ROOT. Binding every root to the same Project would let a
  // pass that funnelled every candidate into the first Project pass every
  // assertion below.
  const projectOf = new Map<string, string>();
  cwds.forEach((cwd, i) => {
    const projectId = i === 0 ? 'proj_1' : `proj_${i + 1}`;
    projectOf.set(cwd, projectId);
    env.env.sqlite.run(`INSERT OR IGNORE INTO projects (project_id, name, created_at) VALUES (?, ?, ?)`, projectId, projectId, Date.now());
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
  it('imports into the Deployment it was given, on a machine that belongs to two', async () => {
    const cwd = path.join(os.tmpdir(), 'myco-import-two-a');
    const other = path.join(os.tmpdir(), 'myco-import-two-b');
    const r = await rig([cwd]);
    try {
      // A second Deployment, bound to another checkout. The registry is one
      // file per root named by a hash of the root, so its order is a hash —
      // taking the first entry imports into whichever Deployment that hash
      // happened to sort first, which on this machine may hold no bindings at
      // all and import nothing while reporting every transcript unplaced.
      registerTestMember({ mycoHome: r.mycoHome, token: r.env.token, tokenId: r.env.tokenId, projectId: 'proj_9', serverUrl: 'https://other.invalid', root: other });

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
      const spoolDir = path.join(r.mycoHome, 'member', 'spool', 'proj_1');
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
    const home = '/tmp/myco-home';
    for (const inside of ['spool/proj_1/s1.jsonl', 'spool/proj_1/blobs/abc', 'deployments/aaaa.json', 'projects/bbbb.json']) {
      expect({ path: inside, refused: isMemberStatePath(`${home}/member/${inside}`, home) }).toEqual({ path: inside, refused: true });
    }
    // A store Myco keeps beside its own state is not its own state.
    expect(isMemberStatePath(`${home}/member/transcripts/opencode/s1.jsonl`, home)).toBe(false);
  });

  it('holds every shipped manifest’s roots outside the member state tree', () => {
    const home = '/tmp/myco-home-gate';
    const env = { ...process.env, HOME: '/tmp/fake-home', MYCO_HOME: home };
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
    const recorded = path.join(os.tmpdir(), 'myco-attr-recorded');
    const other = path.join(os.tmpdir(), 'myco-attr-other');
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
