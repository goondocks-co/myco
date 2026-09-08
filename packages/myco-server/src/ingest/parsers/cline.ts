/**
 * Cline's transcript is written by Myco's own plugin: Cline rewrites two
 * whole-file JSON documents per session in place, so no byte offset survives a
 * turn.
 *
 * Cline wraps the model-facing user message in a mode envelope while its own
 * session metadata keeps the clean text. The plugin strips it at the boundary
 * and the parse strips it again, so a line written before the plugin learned to
 * still yields the prompt the person typed.
 */
import { pluginEventsParser } from './plugin-events.js';
import type { TranscriptParser } from './index.js';

export const clineParser: TranscriptParser = pluginEventsParser({
  agent: 'cline',
  stripEnvelopes: [
    { open: '<user_input mode="act">', close: '</user_input>' },
    { open: '<user_input mode="plan">', close: '</user_input>' },
  ],
});
