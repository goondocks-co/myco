/**
 * Per-target entry — linux-arm64. See cli.darwin-arm64.ts for details.
 */

// @ts-expect-error - Bun file-embed import assertion
import libsqliteEmbed from '../../vendor-src/libsqlite3/linux-arm64/libsqlite3.so' with { type: 'file' };
// @ts-expect-error
import vec0Embed from 'sqlite-vec-linux-arm64/vec0.so' with { type: 'file' };
// @ts-expect-error
import ripgrepEmbed from '@vscode/ripgrep/bin/rg' with { type: 'file' };

import { registerEmbeddedNativeDeps } from '../runtime/native-deps.js';
import { getPluginVersion } from '../version.js';

await registerEmbeddedNativeDeps({
  libsqliteEmbed,
  vec0Embed,
  ripgrepEmbed,
  version: getPluginVersion(),
});

await import('./cli.js');
