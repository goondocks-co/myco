/**
 * Tests for the Team Host affiliation hint (`teamHostHintFromManifest`) —
 * the prompt-only reading of `grove.remote { provider: 'team-host',
 * remote_id }` off an already-loaded project manifest.
 */
import { describe, expect, test } from 'bun:test';

import { parseProjectManifest, type ProjectManifest } from '../config/project-manifest.js';
import { teamHostHintFromManifest } from './hint.js';

function manifestWith(grove?: ProjectManifest['grove']): ProjectManifest {
  return { project: { id: 'proj_test' }, grove };
}

describe('teamHostHintFromManifest', () => {
  test('null manifest → null', () => {
    expect(teamHostHintFromManifest(null)).toBeNull();
  });

  test('no grove block → null', () => {
    expect(teamHostHintFromManifest(manifestWith(undefined))).toBeNull();
  });

  test('grove with no remote block → null', () => {
    expect(teamHostHintFromManifest(manifestWith({ mode: 'local' }))).toBeNull();
  });

  test('remote block with a different provider → null', () => {
    expect(teamHostHintFromManifest(manifestWith({
      mode: 'local',
      remote: { provider: 'other-provider', remote_id: 'host_abc' },
    }))).toBeNull();
  });

  test('remote provider matches but remote_id is missing → null', () => {
    expect(teamHostHintFromManifest(manifestWith({
      mode: 'local',
      remote: { provider: 'team-host' },
    }))).toBeNull();
  });

  test('valid team-host hint → { host_id }', () => {
    const hint = teamHostHintFromManifest(manifestWith({
      mode: 'local',
      remote: { provider: 'team-host', remote_id: 'host_abc123' },
    }));
    expect(hint).toEqual({ host_id: 'host_abc123' });
  });

  test('regression: a manifest with grove.remote plus a secret-like key elsewhere still rejects (existing guard)', () => {
    const toml = `
[project]
id = "proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

[grove]
mode = "local"
api_key = "sk-should-not-be-here"

[grove.remote]
provider = "team-host"
remote_id = "host_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
`;
    expect(() => parseProjectManifest(toml)).toThrow(/secret-like/);
  });
});
