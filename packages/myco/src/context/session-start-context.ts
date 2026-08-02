/**
 * Shared builder for session-start context text — used by the daemon's
 * `/context` route. Extracted so the heading format and join string have a
 * single source of truth.
 */

import type { MycoConfig } from '@myco/config/schema.js';
import { shouldInjectCortex } from './cortex-brief.js';
import { composeCortexInstructionInjection } from './cortex-injection-context.js';
import { getSessionStartDigestPayload, shouldInjectSessionStartDigest } from './session-start-digest.js';

export interface SessionStartContextPart {
  kind: 'cortex' | 'digest';
  /** The rendered text chunk (without the inter-part separator). */
  text: string;
  /** Digest tier the content came from, when applicable. */
  tier?: number;
}

export interface ComposedSessionStartContext {
  /** Individual parts preserved so callers can log which sources contributed. */
  parts: SessionStartContextPart[];
  /** Whether cortex injection is enabled for this config. */
  cortexEnabled: boolean;
  /** Whether digest injection is enabled for this config. */
  digestEnabled: boolean;
}

/**
 * Compose the cortex + digest parts for a session-start context based on the
 * live config. The daemon path supplies its own cortex content (via the
 * signed snapshot), so it passes `cortexContent` explicitly; the degraded
 * path reads the cortex content itself and passes it in the same way.
 *
 * Callers are responsible for:
 *   - joining with `\n\n`
 *   - appending per-session metadata (branch, session_id) after the parts
 *   - logging source attribution
 */
export function composeSessionStartContext(
  config: MycoConfig,
  cortexContent: string,
  scope: import('@myco/grove/ids.js').ProjectScope = { kind: 'global' },
  options: { cliToolTransport?: boolean; mycoBinary?: string } = {},
): ComposedSessionStartContext {
  const cortexEnabled = shouldInjectCortex(config);
  const digestEnabled = shouldInjectSessionStartDigest(config.cortex.digest);
  const parts: SessionStartContextPart[] = [];

  if (cortexEnabled && cortexContent) {
    const cortex = composeCortexInstructionInjection(cortexContent, 'session-start', {
      cliToolTransport: options.cliToolTransport,
      mycoBinary: options.mycoBinary,
    });
    if (cortex) parts.push({ kind: 'cortex', text: cortex.text });
  }
  if (digestEnabled) {
    const digest = getSessionStartDigestPayload(config.cortex.digest, scope);
    if (digest.content) {
      const tier = digest.tier ?? config.cortex.digest.tier;
      parts.push({
        kind: 'digest',
        text: `## Preferred Digest (Tier ${tier})\n${digest.content}`,
        tier,
      });
    }
  }

  return { parts, cortexEnabled, digestEnabled };
}
