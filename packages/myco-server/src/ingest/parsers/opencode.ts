/**
 * OpenCode's transcript is written by Myco's own plugin: opencode stores a
 * session as one JSON file per message and per part, which carries no byte
 * offset to ship a delta against.
 */
import { pluginEventsParser } from './plugin-events.js';
import type { TranscriptParser } from './index.js';

export const opencodeParser: TranscriptParser = pluginEventsParser({ agent: 'opencode' });
