import { spawnSync } from 'node:child_process';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';

const PORT = 18788;
const BASE = `http://127.0.0.1:${PORT}`;
const READY_ATTEMPTS = 45;
const READY_INTERVAL_MS = 2_000;

function docker(...args) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 120_000 });
  if (result.status !== 0) throw new Error(`docker ${args[0]} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

async function ready(container) {
  for (let attempt = 0; attempt < READY_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(3_000) });
      if (response.status === 200) return;
    } catch { /* The listener may not have bound yet. */ }
    await new Promise((resolve) => setTimeout(resolve, READY_INTERVAL_MS));
  }
  throw new Error(`${container} did not become ready:\n${docker('logs', container)}`);
}

function cookie(secret, sub) {
  const now = Date.now();
  const body = Buffer.from(JSON.stringify({ sub, login: 'container-smoke', iat: now, exp: now + 3_600_000, typ: 'session' })).toString('base64url');
  const signature = createHmac('sha256', secret).update(body).digest('base64url');
  return `__Host-myco_session=${body}.${signature}`;
}

async function request(path, options, status) {
  const response = await fetch(`${BASE}${path}`, { ...options, signal: AbortSignal.timeout(10_000) });
  if (response.status !== status) {
    throw new Error(`${options?.method ?? 'GET'} ${path}: HTTP ${response.status}, expected ${status}: ${await response.text()}`);
  }
  return response;
}

async function main() {
  const image = process.argv[2] ?? 'myco-server:native';
  const replacementImage = process.argv[3] ?? image;
  const suffix = randomUUID().slice(0, 12);
  const volume = `myco-ci-persistence-${suffix}`;
  const dataDir = process.env.MYCO_SMOKE_DATA_DIR;
  if (dataDir) mkdirSync(dataDir, { recursive: true });
  const mount = dataDir ?? volume;
  const first = `myco-ci-first-${suffix}`;
  const second = `myco-ci-second-${suffix}`;
  const secret = randomBytes(32).toString('base64url');
  const token = randomBytes(32).toString('base64url');
  const memberId = `mem_${suffix}`;
  const machineId = `machine_${suffix}`;
  const projectId = `proj_${suffix}`;
  const sessionId = `session_${suffix}`;
  const sub = String(Date.now());
  const body = `container persistence fixture ${suffix}\n`;
  const key = createHash('sha256').update(body).digest('hex');
  const owner = { cookie: cookie(secret, sub) };
  const member = { authorization: `Bearer ${token}`, 'x-myco-project': projectId, 'x-myco-protocol': '1' };
  const start = (name, selectedImage) => docker('run', '-d', '--name', name, '-v', `${mount}:/data`,
    '-p', `127.0.0.1:${PORT}:${PORT}`, '-e', `MYCO_PORT=${PORT}`, '-e', 'MYCO_BIND=all',
    '-e', `SESSION_SECRET=${secret}`, '-e', 'GITHUB_CLIENT_ID=container-smoke',
    '-e', 'GITHUB_CLIENT_SECRET=container-smoke-secret', selectedImage);
  const event = (kind, payload) => ({ eventId: randomUUID(), sessionId, kind, createdAt: Date.now(), channel: 'cli',
    producer: { adapter: 'container-smoke', version: '1' }, payload });
  const postEvent = async (kind, payload) => {
    const response = await request('/events', { method: 'POST', headers: { ...member, 'content-type': 'application/json' },
      body: JSON.stringify(event(kind, payload)) }, 200);
    const result = await response.json();
    if (result.persisted !== true) throw new Error(`${kind} was not persisted: ${JSON.stringify(result)}`);
  };
  const snapshot = async () => {
    const session = await (await request(`/api/projects/${projectId}/sessions/${sessionId}`, { headers: owner }, 200)).json();
    const attachments = await (await request(`/api/projects/${projectId}/sessions/${sessionId}/attachments`, { headers: owner }, 200)).json();
    const blob = await (await request(`/api/projects/${projectId}/blobs/${key}`, { headers: owner }, 200)).text();
    return { sessionId: session.session?.sessionId, projectId: session.projectId,
      attachments: attachments.rows, blob };
  };

  const containers = new Set();
  let failure;
  if (!dataDir) docker('volume', 'create', volume);
  try {
    start(first, image);
    containers.add(first);
    await ready(first);

    // Only the temporary principal is seeded directly; fixture data uses the shipped HTTP routes.
    const bootstrap = `
      import { Database } from 'bun:sqlite';
      const db = new Database('/data/myco.sqlite');
      const now = Date.now();
      db.query('INSERT INTO members (id, label, github_id, created_at, revoked_at, role) VALUES (?, ?, ?, ?, NULL, ?)')
        .run(${JSON.stringify(memberId)}, 'container-smoke', ${JSON.stringify(sub)}, now, 'admin');
      db.query('INSERT INTO machine_claims (machine_id, member_id, claimed_at) VALUES (?, ?, ?)')
        .run(${JSON.stringify(machineId)}, ${JSON.stringify(memberId)}, now);
      db.query('INSERT INTO member_credentials (id, member_id, machine_id, token_hash, issued_at, expires_at, lineage_root, lineage_started_at, rotates) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)')
        .run(${JSON.stringify(memberId)}, ${JSON.stringify(memberId)}, ${JSON.stringify(machineId)}, ${JSON.stringify(createHash('sha256').update(token).digest('hex'))},
          now, now + 3_600_000, ${JSON.stringify(memberId)}, now);
      db.close();`;
    docker('exec', first, 'bun', '-e', bootstrap);

    await request(`/api/projects`, { method: 'POST', headers: { ...owner, origin: BASE, 'content-type': 'application/json' },
      body: JSON.stringify({ projectId, name: 'Container persistence smoke' }) }, 201);
    const bytes = Buffer.from(body);
    const stored = await (await request(`/blobs/${key}`, { method: 'POST',
      headers: { ...member, 'content-type': 'text/plain', 'content-length': String(bytes.length) }, body: bytes }, 200)).json();
    if (stored.persisted !== true && stored.stored !== true) throw new Error(`blob was not persisted: ${JSON.stringify(stored)}`);
    await postEvent('session.start', { agent: 'codex', startedAt: Date.now() });
    await postEvent('attachment', { attachmentId: randomUUID(), blob: key, description: 'mounted volume fixture' });
    const before = await snapshot();
    if (before.sessionId !== sessionId || before.projectId !== projectId || before.blob !== body || before.attachments?.length !== 1) {
      throw new Error(`fixture before replacement is incomplete: ${JSON.stringify(before)}`);
    }

    docker('rm', '-f', first);
    containers.delete(first);
    start(second, replacementImage);
    containers.add(second);
    await ready(second);
    const after = await snapshot();
    if (JSON.stringify(after) !== JSON.stringify(before)) {
      throw new Error(`mounted volume contents changed across replacement: ${JSON.stringify({ before, after })}`);
    }
    process.stdout.write(`container replacement preserved ${sessionId}, attachment, and ${key} bytes\n`);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    const cleanupErrors = [];
    for (const container of containers) {
      try { docker('rm', '-f', container); } catch (error) { cleanupErrors.push(error); }
    }
    if (!dataDir) {
      try { docker('volume', 'rm', volume); } catch (error) { cleanupErrors.push(error); }
    }
    if (cleanupErrors.length) {
      const errors = [...(failure ? [failure] : []), ...cleanupErrors];
      throw new AggregateError(errors,
        `container smoke and cleanup failed: ${errors.map((error) => error.message).join('; ')}`);
    }
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
