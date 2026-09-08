/**
 * Meta gate: a test learns the Team Host port from the daemon that bound it.
 *
 * The team listener is the one surface where a test can be handed a port that
 * belongs to somebody else and never notice. Reserving a number up front —
 * bind :0, read it, close the probe, pass it into `new DaemonServer({ teamPort })`
 * — leaves a window between the release and the daemon's bind. The test driver
 * runs test files in parallel processes, so another process can take the number
 * inside that window; the daemon then falls back to an ephemeral port
 * (`retriedEphemeral` in `daemon/server.ts`) and the test sends its requests to
 * whoever now holds the stale one. When that is another daemon's team listener,
 * the request comes back 403 `forbidden_host` on a path the diff never touched.
 *
 * The shape that cannot race is the one production uses: the daemon asks the
 * kernel for a port, and the caller reads back what it got. `boundTeamPort()`
 * in `tests/helpers/team-socket.js` is the only way a test names the listener.
 *
 * ONE file may still put a port INTO the config, because port lifecycle is what
 * it tests — that a requested port is honoured, that a taken one degrades, that
 * a configured port is untouched when serving is off. It gets its numbers from
 * sockets it holds or from a listener it read back, never from a released probe.
 *
 * NOT COVERED, deliberately: `freePort()` in `tests/agent/server-entry.contract.test.ts`
 * and `tests/myco-server/selfhosted/harness-launch.test.ts`. Those hand a port to
 * a CHILD PROCESS through its environment before it starts, which no read-back
 * can replace, and they address a supervisor with no Host-derived check to
 * misfire. Extending this gate to them would mean changing what they test.
 *
 * Static source scan (node:fs) plus a runtime read of the helper's export
 * surface — two mechanisms, so a scan that silently walks nothing still fails.
 */
import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { boundTeamPort } from '../helpers/team-socket.js';
import * as teamSocket from '../helpers/team-socket.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TESTS_ROOT = path.join(REPO_ROOT, 'tests');

/** The file that owns team-listener port behaviour, and so may configure one. */
const PORT_LIFECYCLE_OWNER = path.join('tests', 'daemon', 'team-listener-lifecycle.test.ts');

/**
 * The helper's whole surface. A fourth name is how a port vendor comes back, so
 * adding one is a deliberate act that shows up here rather than in a flake.
 */
const HELPER_EXPORTS = ['boundTeamPort', 'portFetch', 'teamFetch'];

function listTypescript(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      listTypescript(full, out);
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
      out.push(full);
    }
  }
  return out;
}

const SOURCES = listTypescript(TESTS_ROOT).map((full) => ({
  rel: path.relative(REPO_ROOT, full),
  text: fs.readFileSync(full, 'utf-8'),
}));

/**
 * Every `new DaemonServer({ ... })` config literal in `text`, brace-balanced so
 * a nested object (`hostServe: { ... }`) does not end the match early.
 */
function daemonServerConfigLiterals(text: string): string[] {
  const literals: string[] = [];
  const opener = /new DaemonServer\(\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = opener.exec(text)) !== null) {
    let depth = 1;
    let i = match.index + match[0].length;
    for (; i < text.length && depth > 0; i += 1) {
      if (text[i] === '{') depth += 1;
      else if (text[i] === '}') depth -= 1;
    }
    literals.push(text.slice(match.index, i));
  }
  return literals;
}

describe('meta: team port read-back', () => {
  it('scans the real test tree, including the files that address the team listener', () => {
    // A walk that found nothing would pass every assertion below. Pin the
    // population against a fact the other mechanism supplies: the helper is
    // imported by the suites that talk to the listener.
    const consumers = SOURCES.filter((file) => /from '.*helpers\/team-socket\.js'/.test(file.text));
    expect(consumers.length).toBeGreaterThanOrEqual(10);
    expect(SOURCES.some((file) => file.rel === PORT_LIFECYCLE_OWNER)).toBe(true);
  });

  it('vends no pre-reserved port: nothing under tests/ names a port reservation helper', () => {
    const offenders = SOURCES
      .filter((file) => /\bteamTestPort\b/.test(file.text))
      .map((file) => file.rel);

    expect(offenders).toEqual([]);
  });

  it('configures a team port only in the file that tests port lifecycle', () => {
    const offenders = SOURCES
      .filter((file) => file.rel !== PORT_LIFECYCLE_OWNER)
      .filter((file) => daemonServerConfigLiterals(file.text).some((literal) => /\bteamPort\s*:/.test(literal)))
      .map((file) => file.rel);

    expect(offenders).toEqual([]);
  });

  it('exposes exactly one way to name the listener, and it reads the daemon back', () => {
    expect(Object.keys(teamSocket).sort()).toEqual(HELPER_EXPORTS);
    expect(boundTeamPort({ teamPort: 4242 })).toBe(4242);
    // An unbound listener is a setup mistake, and it says so here rather than
    // dialing a nonsense address several assertions later.
    expect(() => boundTeamPort({ teamPort: null })).toThrow(/not bound/);
  });
});
