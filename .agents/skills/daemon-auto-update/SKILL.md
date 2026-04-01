---
name: myco:daemon-auto-update
description: |
  Use this skill when adding or modifying self-update capability in the Myco daemon — including
  npm version checking, release channels (stable/beta), update state caching, detached restart
  flow, or the Operations page UI surface. Activate even if the user only mentions "update badge",
  "version check", "auto-update", or "restart after upgrade". Also applies when debugging
  update-related failures: race conditions on restart, MYCO_CMD not propagating to the shell
  script, null guards on cold cache reads, or CJS loader errors after `npm update -g`.
managed_by: myco
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Implement Daemon Auto-Update

Adds self-update capability to the Myco daemon: lazy npm registry checks, stable/beta release
channels, a detached install-and-restart flow, and a UI badge on the Operations page. The check
is triggered by UI polling rather than a background timer; the apply step runs as a shell script
that outlives the daemon process it replaces.

## Prerequisites

- `semver` is a direct dependency in `package.json` (not just transitive — make it explicit).
- The daemon HTTP server is running via Express in `src/daemon/main.ts`.
- The daemon's HTTP port is accessible to the UI at the time of restart health-polling.

## Architecture Overview

Before writing any files, internalize why each piece is shaped the way it is:

- **Check is lazy** — the registry is fetched only when the UI calls `/api/update/status`,
  not via a background setInterval. This avoids extra network traffic and a class of shutdown
  races.
- **Apply is detached** — a shell script runs `npm install -g myco` then SIGTERMs the old
  daemon. The script must outlive the process it kills, so it runs with `detached: true` and
  `unref()` in Node.
- **State is global (`~/.myco/`)** — one npm package serves all projects on the machine; the
  update cache belongs to the machine, not any single vault.
- **No staging directory** — npm handles binary integrity; staged tarballs add complexity
  for no safety gain on a small package.

## Steps

### 1. Add constants

Create `src/constants/update.ts`:

```ts
export const UPDATE_CACHE_PATH   = path.join(os.homedir(), '.myco', 'last-update-check.json');
export const UPDATE_ERROR_PATH   = path.join(os.homedir(), '.myco', 'update-error.json');
export const UPDATE_STATE_PATH   = path.join(os.homedir(), '.myco', 'update.yaml');
export const UPDATE_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
export const NPM_REGISTRY_URL    = 'https://registry.npmjs.org';
export type  ReleaseChannel      = 'stable' | 'beta';
```

Keep paths here rather than hardcoding them in `update-checker.ts` or the route — if the
global state directory changes, one file changes.

### 2. Write the update checker

Create `src/daemon/update-checker.ts`. The checker's job: read the cache file, decide
whether it is stale, fetch `dist-tags` from npm if needed, compare with the running version,
and write the result back to disk.

```ts
import semver from 'semver';
import { UPDATE_CACHE_PATH, UPDATE_CACHE_TTL_MS, NPM_REGISTRY_URL } from '../constants/update';

export interface UpdateStatus {
  current: string;
  latest: string | null;
  channel: ReleaseChannel;
  updateAvailable: boolean;
  checkedAt: number | null;
}

export async function checkForUpdate(channel: ReleaseChannel = 'stable'): Promise<UpdateStatus> {
  // Dev exemption: skip check when running from source
  if (process.env.MYCO_DEV) {
    return { current: pkg.version, latest: null, channel, updateAvailable: false, checkedAt: null };
  }

  const cached = readCacheSafe(); // returns null on missing/corrupt file — always null-guard
  const now    = Date.now();

  if (cached && now - cached.checkedAt < UPDATE_CACHE_TTL_MS) {
    return cached;
  }

  const distTags = await fetchDistTags(); // GET /myco on NPM_REGISTRY_URL
  const latest   = channel === 'beta' ? (distTags.beta ?? distTags.latest) : distTags.latest;
  const result   = { current: pkg.version, latest, channel,
                     updateAvailable: !!latest && semver.gt(latest, pkg.version),
                     checkedAt: now };
  writeCache(result);
  return result;
}
```

**Null-guard the cache read.** On a cold machine or after a corrupt write, `readCacheSafe`
must return `null` rather than throw — otherwise the very first call to `/api/update/status`
crashes the daemon.

### 3. Write the update installer

Create `src/daemon/update-installer.ts`. The installer writes a temporary shell script and
spawns it detached so it survives the daemon's SIGTERM:

```ts
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

export function applyUpdate(version: string): void {
  const script = `#!/bin/sh
set -e
${MYCO_CMD:-myco} --version  # validate binary after install
npm install -g myco@${version}
kill ${process.pid}
`;
  // ↑ Use ${MYCO_CMD:-myco} fallback — MYCO_CMD must be propagated from the daemon's
  //   environment to the shell script. If the env var isn't set, fall back to 'myco'.

  const scriptPath = path.join(os.tmpdir(), `myco-update-${Date.now()}.sh`);
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });

  const child = spawn('/bin/sh', [scriptPath], {
    detached: true,
    stdio:    'ignore',
  });
  child.unref(); // let the daemon exit without waiting for this child
}
```

**MYCO_CMD propagation.** When the user installs via a non-default path, `npm install -g`
puts the binary somewhere that may not be on PATH by the shell script's `PATH`. Export
`MYCO_CMD=$(which myco)` at daemon startup and include it in the script's environment.
Failing to do this silently breaks the post-install validation step.

**Race condition.** Between `kill ${process.pid}` and the daemon shutting down, the UI may
immediately poll `/health`. Handle this on the UI side (see Step 6), not by adding a sleep
to the shell script.

### 4. Create the route

Create `src/daemon/routes/update.ts` and register it in `src/daemon/main.ts`. Four endpoints:

| Method | Path | Purpose |
|--------|------|---------|
| GET  | `/api/update/status`   | Return cached or freshly fetched update status |
| POST | `/api/update/apply`    | Trigger `applyUpdate(version)` |
| POST | `/api/update/dismiss`  | Write a dismissed-version entry to `update.yaml` |
| GET  | `/api/update/channel`  | Read current channel from `update.yaml` |

```ts
router.get('/status', async (req, res) => {
  try {
    const status = await checkForUpdate(getChannel());
    res.json(status);
  } catch (err) {
    // Write error to UPDATE_ERROR_PATH so the UI can surface it
    writeUpdateError(err);
    res.status(500).json({ error: 'update check failed' });
  }
});

router.post('/apply', (req, res) => {
  const { version } = req.body;
  if (!version) return res.status(400).json({ error: 'version required' });
  applyUpdate(version);
  res.json({ ok: true, message: 'Update in progress — daemon will restart' });
});
```

### 5. Resolve worker source paths

When the daemon calls `locateWorkerSource()` (or equivalent) to find any worker file after
an `npm update -g` install, always check `dist/src/<path>` before `src/<path>`. Use
`resolvePackageRoot()` to anchor the search rather than `__dirname` or `process.cwd()`.

```ts
function locateWorkerSource(relPath: string): string {
  const root = resolvePackageRoot();
  const distPath = path.join(root, 'dist', 'src', relPath);
  if (fs.existsSync(distPath)) return distPath;
  return path.join(root, 'src', relPath); // dev fallback
}
```

Failing to check `dist/src/` first is the single most common cause of "file not found" errors
after a global install, because the compiled output lives under `dist/` but developer muscle
memory points to `src/`.

### 6. Build the UI

**Hook** — Create `ui/src/hooks/useUpdateStatus.ts`. Poll `/api/update/status` on an interval
(e.g., every 5 minutes). The hook owns the polling lifecycle; it should not live in a root
layout component.

```ts
export function useUpdateStatus(intervalMs = 5 * 60 * 1000) {
  const [status, setStatus] = useState<UpdateStatus | null>(null);

  useEffect(() => {
    const fetch = async () => {
      const res = await api.get<UpdateStatus>('/update/status');
      setStatus(res.data);
    };
    fetch();
    const id = setInterval(fetch, intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);

  return status;
}
```

**Badge** — Create `ui/src/layout/UpdateBadge.tsx` as a self-contained component that calls
`useUpdateStatus` internally. Do **not** hoist the polling into `Layout.tsx` or any root
component. Badge state is local to the badge; making it global creates unnecessary coupling
and complicates the restart race condition below.

**Restart race condition.** After the user clicks "Apply", the daemon will SIGTERM itself.
The UI should poll `GET /health` from the `UpdateBadge` component (or a dedicated hook), not
rely on the update status endpoint, to detect when the new daemon is up. Show "Restarting…"
until `/health` returns 200 again, then refresh update status.

**Operations page** — Surface the badge and apply controls on the Operations page under a
"System" tab. Use URL-persisted tab state (`?tab=system`) so deep-linking and back-navigation
work without extra state management.

### 7. Handle the transient CJS loader error

After `npm update -g`, users may see a CJS loader error on the very first invocation of the
new binary. This is a transient artifact of npm's non-atomic binary replacement window — the
old shim briefly points to the new module before the node_modules tree is fully in place. It
is **not a code bug**. The fix is: document it, wait ~1 second, and retry. Do not add retry
logic inside the binary itself; that masks the symptom without solving the race and adds
startup latency for all users.

## Common Pitfalls

- **`MYCO_CMD` not in shell script env** — The script runs in a minimal environment. Either
  pass `env: { ...process.env }` to `spawn()` or hard-code the resolved binary path.
- **`readCacheSafe` not null-guarding** — Cold machines have no cache file. Any code path
  that reads the cache must handle `null` explicitly.
- **Polling in `Layout.tsx`** — Putting `useUpdateStatus` in the root layout means the
  interval persists across all routes and makes the apply flow harder to test in isolation.
  Keep it inside `UpdateBadge`.
- **`dist/src/` vs `src/` confusion** — After a global install, worker files are always
  under `dist/`. Check `dist/src/` first in `locateWorkerSource`.
- **Sync protocol version** — If you need to gate updates on compatibility with a sync
  partner (e.g., team sync), use a separate integer `sync_protocol_version` field, not semver
  comparison alone. Semver describes the package; protocol version describes the wire format.
