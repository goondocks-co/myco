/**
 * TOML helper unit tests.
 *
 * Particular emphasis on the upsert path's edge cases — a missing
 * newline between a rewritten section and the following section header
 * produces malformed TOML (`hooks = true[notice.model_migrations]`)
 * that codex's parser silently refuses, with no error surfaced to
 * Myco. Locking down with regression cases.
 */

import { describe, it, expect } from 'bun:test';
import { upsertTomlSection, buildTomlMcpSection } from '@myco/symbionts/toml-helpers.js';

describe('upsertTomlSection', () => {
  it('inserts into an empty document', () => {
    const out = upsertTomlSection('', 'features', { hooks: true });
    expect(out).toBe(`[features]\nhooks = true\n`);
  });

  it('appends a new section to a non-empty document', () => {
    const raw = `model = "gpt-5.5"\n`;
    const out = upsertTomlSection(raw, 'features', { hooks: true });
    expect(out).toBe(`model = "gpt-5.5"\n\n[features]\nhooks = true\n`);
  });

  it('replaces an existing section without colliding with the next section header', () => {
    // Regression: codex's real config.toml had `[features]` followed
    // immediately by `[notice.model_migrations]`. The upsert would
    // produce `hooks = true[notice.model_migrations]` (no newline
    // between), making the file unparseable.
    const raw = `model = "gpt-5.5"\n\n[features]\nhooks = false\n\n[notice.model_migrations]\n"gpt-5.1-codex-max" = "gpt-5.2-codex"\n`;
    const out = upsertTomlSection(raw, 'features', { hooks: true });
    // Must round-trip cleanly through a TOML parser. The shape
    // expectation: blank line between the rewritten block and the
    // following section header.
    expect(out).toContain('[features]\nhooks = true\n\n[notice.model_migrations]');
    expect(out).not.toContain('hooks = true[notice');
  });

  it('handles a section whose body is a single line (one-liner edge case)', () => {
    // The exact failure mode from the codex incident: section body is
    // just one key=value pair, immediately followed by the next section.
    const raw = `[features]\nhooks = true\n[trailing.section]\nkey = "value"\n`;
    const out = upsertTomlSection(raw, 'features', { hooks: true });
    expect(out).toContain('[features]\nhooks = true\n\n[trailing.section]');
  });

  it('is idempotent — running twice on the same input produces the same output', () => {
    // Contract used by the bootstrap loop: each tick re-applies the
    // settings template. A non-idempotent writer would invalidate
    // every downstream content-hash check (e.g. Codex's trust gate)
    // on every tick.
    const raw = `model = "gpt-5.5"\n\n[features]\nhooks = true\n\n[trailing]\nkey = "value"\n`;
    const once = upsertTomlSection(raw, 'features', { hooks: true });
    const twice = upsertTomlSection(once, 'features', { hooks: true });
    expect(twice).toBe(once);
  });

  it('preserves content before and after the rewritten section', () => {
    const raw = `model = "gpt-5.5"\n\n[features]\nhooks = false\n\n[mcp_servers.myco]\nurl = "http://localhost:1"\n`;
    const out = upsertTomlSection(raw, 'features', { hooks: true });
    expect(out.startsWith('model = "gpt-5.5"\n')).toBe(true);
    expect(out).toContain('[mcp_servers.myco]\nurl = "http://localhost:1"');
  });
});

describe('buildTomlMcpSection', () => {
  it('appends a new mcp_servers entry to an empty document', () => {
    const out = buildTomlMcpSection('', 'myco', { url: 'http://127.0.0.1:19344/mcp' });
    expect(out).toBe(`[mcp_servers.myco]\nurl = "http://127.0.0.1:19344/mcp"\n`);
  });

  it('replaces an existing mcp_servers entry without colliding with the next section header', () => {
    // Regression: Chris's real ~/.codex/config.toml had Myco's
    // [mcp_servers.myco] block followed immediately by Codex Desktop's
    // [mcp_servers.node_repl] section. The rewrite would produce
    // `url = "..."[mcp_servers.node_repl]` (no newline between), making
    // the file unparseable — which silently disabled ALL Codex hooks for
    // every Myco-enabled project until the file was hand-repaired.
    const raw =
      `[mcp_servers.myco]\nurl = "http://old"\n\n[mcp_servers.node_repl]\nargs = []\n`;
    const out = buildTomlMcpSection(raw, 'myco', { url: 'http://127.0.0.1:19344/mcp' });
    expect(out).toContain('[mcp_servers.myco]\nurl = "http://127.0.0.1:19344/mcp"\n\n[mcp_servers.node_repl]');
    expect(out).not.toMatch(/"\[mcp_servers\.node_repl\]/);
  });

  it('handles a section whose body is a single line (one-liner edge case)', () => {
    // Direct repro of the production corruption shape: one-line body
    // followed immediately by the next section.
    const raw = `[mcp_servers.myco]\nurl = "http://old"\n[mcp_servers.node_repl]\nargs = []\n`;
    const out = buildTomlMcpSection(raw, 'myco', { url: 'http://new' });
    expect(out).toContain('[mcp_servers.myco]\nurl = "http://new"\n\n[mcp_servers.node_repl]');
  });

  it('is idempotent — running twice on the same input produces the same output', () => {
    const raw = `[mcp_servers.myco]\nurl = "http://old"\n\n[mcp_servers.node_repl]\nargs = []\n`;
    const once = buildTomlMcpSection(raw, 'myco', { url: 'http://new' });
    const twice = buildTomlMcpSection(once, 'myco', { url: 'http://new' });
    expect(twice).toBe(once);
  });

  it('preserves content before the rewritten mcp_servers entry', () => {
    const raw =
      `[hooks.state."/some/path:session_start:0:0"]\ntrusted_hash = "sha256:abc"\n\n[mcp_servers.myco]\nurl = "http://old"\n\n[mcp_servers.node_repl]\nargs = []\n`;
    const out = buildTomlMcpSection(raw, 'myco', { url: 'http://new' });
    expect(out).toContain('[hooks.state."/some/path:session_start:0:0"]\ntrusted_hash = "sha256:abc"');
    expect(out).toContain('[mcp_servers.node_repl]');
  });
});
