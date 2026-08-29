import { describe, expect, it } from 'bun:test';
import { withoutCredentialFlag } from '@myco/cli/tool.js';
import { ENV_MEMBER_TOKEN, ENV_PROJECT, ENV_SERVER_URL } from '@myco/member/credential.js';
import { MEMBER_PROTOCOL, PROJECT_HEADER, PROTOCOL_HEADER } from '@myco/member/constants.js';
import { credentialFlagPresent, declaredCredentialSource, deploymentHeaders, resolveDeploymentUpstream } from '@myco/mcp/deployment-upstream.js';

/**
 * The Deployment upstream a declared credential source resolves to: the
 * `/mcp` and `/health` URLs under the member's server, and the three headers
 * every member request carries. The bridge and the CLI both build on this.
 */
describe('deployment upstream', () => {
  const token = 'A'.repeat(43);

  it('resolves the env triplet to the Deployment\'s /mcp and /health with the member headers', () => {
    const upstream = resolveDeploymentUpstream('env', { env: { [ENV_SERVER_URL]: 'https://srv.example/', [ENV_MEMBER_TOKEN]: token, [ENV_PROJECT]: 'proj_1' } });
    expect(upstream).toEqual({
      mcpUrl: new URL('https://srv.example/mcp'),
      healthUrl: new URL('https://srv.example/health'),
      headers: { authorization: `Bearer ${token}`, [PROTOCOL_HEADER]: String(MEMBER_PROTOCOL), [PROJECT_HEADER]: 'proj_1' },
      source: 'env',
      projectId: 'proj_1',
    });
  });

  it('is null when no credential resolves', () => {
    const lines: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; }) as typeof process.stderr.write;
    try {
      expect(resolveDeploymentUpstream('env', { env: {} })).toBeNull();
    } finally {
      process.stderr.write = original;
    }
    expect(lines.join('')).toContain('are not set');
  });

  it('carries the credential, the member protocol, and the Project on every request', () => {
    expect(Object.keys(deploymentHeaders({ token, projectId: 'p' })).sort()).toEqual(['authorization', PROJECT_HEADER, PROTOCOL_HEADER].sort());
  });

  it('reads the declared source from the command line in both flag forms, and strips it from the tool arguments', () => {
    expect(declaredCredentialSource(['mcp', '--credential', 'registry'])).toBe('registry');
    expect(declaredCredentialSource(['call', 'myco_plans', '--credential=env', '--json'])).toBe('env');
    expect(declaredCredentialSource(['call', 'myco_plans', '--json'])).toBeNull();
    expect(() => declaredCredentialSource(['call', '--credential', 'nowhere'])).toThrow(/registry\|env/);
    expect(() => declaredCredentialSource(['call', '--credential'])).toThrow(/registry\|env/);
    expect(credentialFlagPresent(['call', '--credential=env'])).toBe(true);
    expect(credentialFlagPresent(['call', '--json'])).toBe(false);
    expect(withoutCredentialFlag(['call', 'myco_plans', '--credential', 'env', '--json', '--input', '{}'])).toEqual(['call', 'myco_plans', '--json', '--input', '{}']);
    expect(withoutCredentialFlag(['list', '--credential=registry'])).toEqual(['list']);
  });
});
