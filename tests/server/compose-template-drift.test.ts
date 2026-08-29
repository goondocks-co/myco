/**
 * The embedded template and the shipped Compose file are one artifact.
 *
 * `myco server create` writes the embedded copy, and the condition-4 gate reads
 * the file. Two sources means a publish spec can be corrected in one and stay
 * wrong in the other, with each gate reporting green about its own half.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { COMPOSE_TEMPLATE } from '@myco/server/compose-template.js';

const SHIPPED = fileURLToPath(new URL('../../packages/myco-server/compose.yaml', import.meta.url));

describe('compose template', () => {
  it('is byte-identical to the shipped Compose file', () => {
    expect(COMPOSE_TEMPLATE).toBe(readFileSync(SHIPPED, 'utf8'));
  });

  it('carries the loopback-qualified publish the condition-4 gate checks', () => {
    // The property the other gate proves about the file, asserted here about
    // the copy an operator actually runs.
    expect(COMPOSE_TEMPLATE).toContain('127.0.0.1:${MYCO_PORT:-8787}:${MYCO_PORT:-8787}');
  });

  it('selects the container bind shape', () => {
    expect(COMPOSE_TEMPLATE).toContain('MYCO_BIND: all');
  });

  it('hands every mounted secret to the process by its *_FILE variable, and passes the sign-in client id', () => {
    // The process reads a secret from the path `<NAME>_FILE` names
    // (`platform/bun/server-main.ts secretOf`); a mount without that variable is
    // a file nothing reads, and sign-in stays unconfigured with every file in place.
    const declared = [...COMPOSE_TEMPLATE.matchAll(/^\s{2}(myco_[a-z_]+):\n\s+file: \.\/secrets\/([a-z_]+)$/gm)].map((m) => ({ secret: m[1]!, file: m[2]! }));
    expect(declared.map((d) => d.file).sort()).toEqual(['github_client_secret', 'secret_wrap_key', 'session_secret']);
    for (const { secret, file } of declared) {
      expect({ file, env: COMPOSE_TEMPLATE.includes(`${file.toUpperCase()}_FILE: /run/secrets/${secret}`) }).toEqual({ file, env: true });
    }
    expect(COMPOSE_TEMPLATE).toContain('GITHUB_CLIENT_ID: ${GITHUB_CLIENT_ID:-}');
  });
});

describe('resource limits are declared where Compose reads them', () => {
  it('declares a memory limit under deploy.resources.limits', () => {
    // Verified against a running container: this stanza produces
    // HostConfig.Memory = 2147483648 under plain `docker compose`, with no
    // swarm involved. A limit written anywhere else is silently ignored.
    expect(COMPOSE_TEMPLATE).toContain('deploy:');
    expect(COMPOSE_TEMPLATE).toContain('resources:');
    expect(COMPOSE_TEMPLATE).toContain('limits:');
    expect(COMPOSE_TEMPLATE).toMatch(/limits:\s*\n\s*memory:/);
  });

  it('declares a drain window, which the signal handler now uses', () => {
    expect(COMPOSE_TEMPLATE).toContain('stop_grace_period:');
  });

  it('bounds the log files so a long-running Deployment cannot fill the disk', () => {
    expect(COMPOSE_TEMPLATE).toContain('max-size:');
    expect(COMPOSE_TEMPLATE).toContain('max-file:');
  });
});
