/**
 * myco_logs tool was removed in the v2-foundation rewrite.
 * Daemon logs are accessed via the daemon API, not MCP tools.
 */

import { describe, it } from 'vitest';

describe('myco_logs (removed)', () => {
  it.skip('tool removed in v2 — logs are accessed via daemon API', () => {
    // This test file is a placeholder. The myco_logs MCP tool was removed
    // during the PGlite migration. Daemon log access is through the
    // daemon HTTP API, not through MCP tools.
  });
});
