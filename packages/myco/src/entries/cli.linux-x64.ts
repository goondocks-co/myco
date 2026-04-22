/**
 * Per-target entry — linux-x64. See cli.darwin-arm64.ts for details.
 */

// @ts-expect-error - Bun file-embed import assertion
import libsqliteEmbed from '../../vendor-src/libsqlite3/linux-x64/libsqlite3.so' with { type: 'file' };
// @ts-expect-error
import vec0Embed from 'sqlite-vec-linux-x64/vec0.so' with { type: 'file' };
// @ts-expect-error
import ripgrepEmbed from '@vscode/ripgrep/bin/rg' with { type: 'file' };

import { registerEmbeddedNativeDeps } from '../runtime/native-deps.js';
import { setPluginVersion } from '../version.js';
import pkg from '../../package.json' with { type: 'json' };

setPluginVersion(pkg.version);

await registerEmbeddedNativeDeps({
  libsqliteEmbed,
  vec0Embed,
  ripgrepEmbed,
  version: pkg.version,
});

await import('./cli.js');
