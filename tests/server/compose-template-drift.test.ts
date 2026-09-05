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
import { COMPOSE_TEMPLATE, HARNESS_STOP_GRACE_SECONDS } from '@myco/server/compose-template.js';

const SHIPPED = fileURLToPath(new URL('../../packages/myco-server/compose.yaml', import.meta.url));

/** One service's block of the bundle, from its name to the next service or the next top-level key. */
function service(name: string): string {
  const header = `  ${name}:\n`;
  const start = COMPOSE_TEMPLATE.indexOf(`\n${header}`);
  expect(start, `${name} is declared`).toBeGreaterThan(-1);
  const body = COMPOSE_TEMPLATE.slice(start + 1 + header.length);
  const end = body.search(/^(\S|  \w[\w-]*:$)/m);
  return header + (end === -1 ? body : body.slice(0, end));
}

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
    expect(declared.map((d) => d.file).sort()).toEqual(['github_client_secret', 'harness_token', 'secret_wrap_key', 'session_secret']);
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

describe('the harness rides in the server\'s network namespace', () => {
  const harness = () => service('harness');

  it('runs the supervisor entry of the harness image', () => {
    expect(harness()).toContain('image: ghcr.io/goondocks-co/myco-harness:${MYCO_VERSION:-latest}');
    expect(harness()).toContain('command: ["bun", "run", "supervisor.js"]');
  });

  it('shares the server namespace and declares neither a port nor a network, which Compose refuses together', () => {
    expect(harness()).toContain('network_mode: "service:server"');
    expect(harness()).not.toMatch(/^\s+ports:$/m);
    expect(harness()).not.toMatch(/^\s+networks:$/m);
  });

  it('probes its own supervisor AND the server, so a wedged supervisor cannot report healthy', () => {
    // A wedged supervisor fails the first request; a harness whose namespace
    // went away with an out-of-band restart of the server still answers its own
    // probe and fails the second.
    const test = /^\s+test: \[(.+)\]$/m.exec(harness())![1]!;
    expect(test).toContain('"CMD-SHELL"');
    expect(test).toContain('http://127.0.0.1:8080/probe');
    expect(test).toContain('http://127.0.0.1:${MYCO_PORT:-8787}/health');
    expect(test).toContain("Host: 127.0.0.1:${MYCO_PORT:-8787}");
    // One shell command, both halves required.
    expect(test).toContain('&&');
    // The health log keeps a healthcheck's output, and /probe names run ids.
    expect([...test.matchAll(/-o \/dev\/null/g)]).toHaveLength(2);
    // Two requests do not fit the one-request window.
    expect(harness()).toContain('timeout: 10s');
  });

  it('runs the supervisor as root, so the launch token is not the runtime child\'s to read', () => {
    // The supervisor drops each child to the image's unprivileged user; a child
    // that could read the token could launch runs of its own.
    expect(harness()).toContain('user: "0:0"');
    // The server holds the image's own unprivileged user and declares none.
    expect(service('server')).not.toMatch(/^\s+user:/m);
  });

  it('gives each runtime a working directory on tmpfs the image\'s unprivileged user can create in', () => {
    expect(harness()).toContain('MYCO_WORK_DIR: /work');
    expect(harness()).toContain('tmpfs: ["/work:mode=1777"]');
  });

  it('names the supervisor port the server dials and bounds the memory the runtimes share', () => {
    expect(harness()).toContain('MYCO_SUPERVISOR_PORT: 8080');
    expect(service('server')).toContain('MYCO_HARNESS: http://127.0.0.1:8080');
    expect(harness()).toContain('memory: ${MYCO_HARNESS_MEMORY_LIMIT:-4g}');
  });

  it('holds the runs it is carrying for the whole grace, and starts only after the server', () => {
    expect(harness()).toContain(`stop_grace_period: ${HARNESS_STOP_GRACE_SECONDS}s`);
    expect(harness()).toContain('restart: unless-stopped');
    expect(harness()).toMatch(/depends_on:\n\s+- server/);
  });

  it('mounts the launch token in both services, which is what authenticates the launch', () => {
    for (const name of ['server', 'harness']) {
      expect({ name, mounted: service(name).includes('- myco_harness_token') }).toEqual({ name, mounted: true });
    }
    expect(service('server')).toContain('MYCO_HARNESS_TOKEN_FILE: /run/secrets/myco_harness_token');
    expect(service('harness')).toContain('MYCO_HARNESS_TOKEN_FILE: /run/secrets/myco_harness_token');
  });

  it('resolves the host on every daemon, so a model server on it is reached the same way', () => {
    // Docker Desktop resolves host.docker.internal on its own; Docker Engine on
    // Linux resolves it only where a service declares this mapping, and a
    // provider base_url naming the host fails to connect at dispatch without it.
    expect(service('server')).toMatch(/^\s+extra_hosts:\n\s+- "host\.docker\.internal:host-gateway"$/m);
    // The harness reaches it through the namespace it shares with the server.
    expect(service('harness')).not.toContain('extra_hosts');
  });

  it('gives the server the origin and the fleet its scheduled work and its dispatcher read', () => {
    expect(service('server')).toContain('MYCO_ORIGIN: ${MYCO_ORIGIN:-http://127.0.0.1:${MYCO_PORT:-8787}}');
    expect(service('server')).toContain('MYCO_FLEET: ${MYCO_FLEET:-4}');
  });

  it('CONTROL: the service reader stops at the next service', () => {
    // A reader that returned the whole file would pass every assertion above.
    expect(service('server')).not.toContain('myco-harness');
    expect(service('harness')).not.toContain('myco-server');
  });
});
