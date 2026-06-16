import fs from 'node:fs';

/**
 * Stdin buffered upstream by the launch preamble (Antigravity workspace
 * lookup, see cli/launch-preamble.ts) and re-fed in-process so the handler
 * does not read an already-drained fd 0. Consumed once: the first readStdin()
 * returns it and clears it, so a second read falls through to fd 0.
 */
let injectedStdin: Buffer | null = null;

/**
 * Inject (or, with null, clear) a stdin buffer that the next readStdin()
 * consumes before touching fd 0.
 */
export function setBufferedStdin(buf: Buffer | null): void {
  injectedStdin = buf;
}

/**
 * Read all of stdin to EOF as UTF-8.
 *
 * Uses the synchronous fd-read path rather than event-based stream listeners
 * because some agent hosts (Cursor, observed at v3.5.17) write the JSON
 * payload and close the stdin pipe before the node process attaches its
 * stream listeners. Under the event-based variant, the close races the
 * listener attach: 'end' fires before any 'data' arrives at the buffer,
 * the promise resolves to `'{}'`, and every downstream handler silently
 * bails on the missing session_id check. The race was non-deterministic
 * — postToolUse sometimes landed, sometimes didn't — and produced no
 * trace anywhere because the bail path is exit 0 / empty stdout / empty
 * stderr by design.
 *
 * `fs.readFileSync(0)` blocks until EOF on the stdin file descriptor and
 * returns whatever was buffered. If stdin is empty/closed it returns an
 * empty buffer, which we coerce to `'{}'` so JSON.parse always succeeds.
 *
 * Hook stdin is always a pipe (never a TTY) under every supported symbiont,
 * so blocking on fd 0 is safe.
 */
export function readStdin(): Promise<string> {
  if (injectedStdin !== null) {
    const buf = injectedStdin;
    injectedStdin = null;
    return Promise.resolve(buf.length > 0 ? buf.toString('utf-8') : '{}');
  }
  try {
    const buf = fs.readFileSync(0);
    return Promise.resolve(buf.length > 0 ? buf.toString('utf-8') : '{}');
  } catch {
    return Promise.resolve('{}');
  }
}
