import fs from 'node:fs';

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
  try {
    const buf = fs.readFileSync(0);
    return Promise.resolve(buf.length > 0 ? buf.toString('utf-8') : '{}');
  } catch {
    return Promise.resolve('{}');
  }
}
