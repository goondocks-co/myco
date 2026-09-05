/**
 * The server container starts privileged and does not serve privileged.
 *
 * A Compose secret outside swarm is a bind mount of the operator's own file, so
 * on a native daemon it arrives owned by that file's uid at 0600, which the
 * runtime user cannot read. The image therefore ends with no `USER`, and the
 * entrypoint copies the secrets somewhere the runtime user owns and drops
 * before it migrates or serves. Both halves are shipped files, and a change to
 * either alone puts the container back to serving as root or back to refusing
 * its own keys — which is decidable here and nowhere else in the suite.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('../../../packages/myco-server/', import.meta.url));
const dockerfile = (): string => readFileSync(`${SERVER}Dockerfile`, 'utf8');
const entrypoint = (): string => readFileSync(`${SERVER}docker-entrypoint.sh`, 'utf8');

/** The Dockerfile from the runtime stage on: the only stage whose `USER` reaches a running container. */
function runtimeStage(): string {
  const at = dockerfile().lastIndexOf('AS runtime');
  expect(at).toBeGreaterThan(-1);
  return dockerfile().slice(at);
}

/** Every uncommented line of a shipped file. */
const instructions = (text: string): string[] =>
  text.split('\n').map((line) => line.trim()).filter((line) => line !== '' && !line.startsWith('#'));

describe('the image hands PID 1 to the entrypoint as root', () => {
  it('declares no USER in the runtime stage, so the entrypoint can read the mounted secrets', () => {
    // A `USER myco` above the ENTRYPOINT takes the copy away, and every secret
    // a native daemon bind-mounts becomes unreadable to the process that needs it.
    expect(instructions(runtimeStage()).filter((line) => /^USER\b/.test(line))).toEqual([]);
  });

  it('still creates the unprivileged user and gives it the volume', () => {
    expect(runtimeStage()).toContain('useradd --system --uid 10001');
    expect(runtimeStage()).toContain('chown -R myco:myco /data');
  });

  it('runs the entrypoint, not the server, as its command', () => {
    expect(runtimeStage()).toContain('ENTRYPOINT ["./docker-entrypoint.sh"]');
  });
});

describe('the entrypoint takes the secrets and then drops', () => {
  it('copies every mounted secret to one the runtime user owns, read-only', () => {
    const script = entrypoint();
    expect(script).toContain('/run/secrets');
    expect(script).toContain('/run/myco/secrets');
    expect(script).toContain('chown "$RUNTIME_USER:$RUNTIME_USER" "$owned"');
    expect(script).toContain('chmod 0400 "$owned"');
    // Only the variables naming the mount move onto the copy; the compose
    // file's paths stay as they are.
    expect(script).toContain('_FILE');
    expect(script).toContain('export "$name=$owned"');
  });

  it('drops with setpriv before anything migrates or serves', () => {
    const script = entrypoint();
    const drop = script.indexOf('setpriv --reuid="$RUNTIME_USER"');
    const migrate = script.indexOf('--migrate-only');
    const serve = script.lastIndexOf('exec "$@"');
    expect(drop).toBeGreaterThan(-1);
    expect(drop).toBeLessThan(migrate);
    expect(drop).toBeLessThan(serve);
    expect(script).toContain('--init-groups');
  });

  it('refuses to serve if the drop did not take, rather than serving as root', () => {
    expect(entrypoint()).toContain('still root after dropping privileges');
    // An image lacking setpriv is named at startup, not served around.
    expect(entrypoint()).toContain('command -v setpriv');
  });

  it('serves a deployment that mounts no secrets at all', () => {
    // The container smoke runs the image with none, and a deployment establishes
    // its sign-in credential later.
    expect(entrypoint()).toContain('[ -d "$MOUNTED_SECRETS" ] || return 0');
  });
});
