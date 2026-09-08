/**
 * The closed parser registry: one entry per agent whose transcript the server
 * reads. Tests enumerate this rather than a hand-written list, so a parser
 * added without a fixture, or declaring a fidelity outside the closed set,
 * fails by name.
 *
 * An agent absent here has no server-side parse. Its capture still reaches the
 * Deployment through the member's own events; nothing is silently dropped.
 */
import { claudeCodeParser } from './claude-code.js';
import { clineParser } from './cline.js';
import { codexParser } from './codex.js';
import { cursorParser } from './cursor.js';
import { opencodeParser } from './opencode.js';
import { piParser } from './pi.js';
import type { TranscriptParser } from './index.js';

export const PARSERS: Readonly<Record<string, TranscriptParser>> = {
  [claudeCodeParser.agent]: claudeCodeParser,
  [clineParser.agent]: clineParser,
  [codexParser.agent]: codexParser,
  [cursorParser.agent]: cursorParser,
  [opencodeParser.agent]: opencodeParser,
  [piParser.agent]: piParser,
};

/** The parser for an agent, or null when the server reads none for it. */
export function parserFor(agent: string | null): TranscriptParser | null {
  return agent === null ? null : PARSERS[agent] ?? null;
}
