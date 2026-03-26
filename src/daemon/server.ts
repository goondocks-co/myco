import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type { DaemonLogger } from './logger.js';
import { getPluginVersion } from '../version.js';
import { Router, type RouteHandler } from './router.js';
import { resolveStaticFile } from './static.js';
import { DAEMON_EVICT_TIMEOUT_MS, DAEMON_EVICT_POLL_MS } from '../constants.js';

const DEFAULT_STATUS = 200;

export interface DaemonServerConfig {
  vaultDir: string;
  logger: DaemonLogger;
  uiDir?: string;
  onRequest?: () => void;
}

export class DaemonServer {
  port = 0;
  readonly version: string;
  uiDir: string | null;
  private server: http.Server | null = null;
  private vaultDir: string;
  private logger: DaemonLogger;
  private router = new Router();
  private onRequest: (() => void) | null;

  constructor(config: DaemonServerConfig) {
    this.vaultDir = config.vaultDir;
    this.logger = config.logger;
    this.uiDir = config.uiDir ?? null;
    this.onRequest = config.onRequest ?? null;
    this.version = getPluginVersion();
    this.registerDefaultRoutes();
  }

  registerRoute(method: string, routePath: string, handler: RouteHandler): void {
    this.router.add(method, routePath, handler);
  }

  async start(port: number = 0): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handleRequest(req, res));
      this.server.on('error', reject);

      this.server.listen(port, '127.0.0.1', () => {
        const addr = this.server!.address() as { port: number };
        this.port = addr.port;
        this.writeDaemonJson();
        this.logger.info('daemon', 'Server started', { port: this.port, dashboard: `http://localhost:${this.port}/` });
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      this.removeDaemonJson();
      if (this.server) {
        this.server.close(() => {
          this.logger.info('daemon', 'Server stopped');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  private registerDefaultRoutes(): void {
    this.registerRoute('GET', '/health', async () => ({
      body: {
        myco: true,
        version: this.version,
        pid: process.pid,
        uptime: process.uptime(),
      },
    }));
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // API/daemon routes take priority over static files
    const match = this.router.match(req.method!, req.url!);

    if (match) {
      this.onRequest?.();
      try {
        const body = (req.method === 'POST' || req.method === 'PUT') ? await readBody(req) : undefined;
        const result = await match.handler({
          body,
          query: match.query,
          params: match.params,
          pathname: match.pathname,
        });
        const status = result.status ?? DEFAULT_STATUS;
        if (Buffer.isBuffer(result.body)) {
          res.writeHead(status, result.headers ?? {});
          res.end(result.body);
          return;
        }
        const headers = { 'Content-Type': 'application/json', ...result.headers };
        res.writeHead(status, headers);
        res.end(JSON.stringify(result.body));
      } catch (error) {
        this.logger.error('daemon', 'Request handler error', {
          path: req.url,
          error: (error as Error).message,
        });
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: (error as Error).message }));
      }
      return;
    }

    // No API route matched — serve static files (dashboard SPA)
    if (this.uiDir && req.method === 'GET') {
      const pathname = new URL(req.url!, 'http://localhost').pathname;
      const result = resolveStaticFile(this.uiDir, pathname);
      if (result) {
        try {
          const content = await fs.promises.readFile(result.filePath);
          res.writeHead(200, {
            'Content-Type': result.contentType,
            'Cache-Control': result.cacheControl,
          });
          res.end(content);
        } catch {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'not found' }));
        }
        return;
      }
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  }

  updateDaemonJsonSessions(sessions: string[]): void {
    const jsonPath = path.join(this.vaultDir, 'daemon.json');
    try {
      const info = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
      info.sessions = sessions;
      fs.writeFileSync(jsonPath, JSON.stringify(info, null, 2));
    } catch { /* daemon.json may not exist during shutdown */ }
  }

  /**
   * Kill any existing daemon for this vault before taking over.
   * Prevents orphaned daemons when spawned from worktrees or plugin upgrades.
   * Must be called BEFORE resolvePort() so the old daemon releases the port.
   */
  async evictExistingDaemon(): Promise<void> {
    const jsonPath = path.join(this.vaultDir, 'daemon.json');
    let existingPid: number | undefined;
    try {
      const content = fs.readFileSync(jsonPath, 'utf-8');
      const info = JSON.parse(content);
      if (typeof info.pid === 'number' && info.pid !== process.pid) {
        existingPid = info.pid;
      }
    } catch { /* no daemon.json or invalid — nothing to evict */ }

    if (!existingPid) return;

    // Check if the process is alive
    try { process.kill(existingPid, 0); } catch { return; /* already dead */ }

    this.logger.info('daemon', 'Evicting existing daemon', { pid: existingPid });
    try { process.kill(existingPid, 'SIGTERM'); } catch { return; }

    // Give SIGTERM a grace period, then escalate to SIGKILL to guarantee port release
    const deadline = Date.now() + DAEMON_EVICT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, DAEMON_EVICT_POLL_MS));
      try { process.kill(existingPid, 0); } catch { return; /* dead */ }
    }

    this.logger.warn('daemon', 'Evicted daemon did not exit in time, sending SIGKILL', { pid: existingPid });
    try { process.kill(existingPid, 'SIGKILL'); } catch { return; }

    // Verify SIGKILL took effect
    await new Promise((r) => setTimeout(r, DAEMON_EVICT_POLL_MS));
    try { process.kill(existingPid, 0); } catch { return; /* dead */ }
    this.logger.warn('daemon', 'Evicted daemon still alive after SIGKILL', { pid: existingPid });
  }

  private writeDaemonJson(): void {
    const info = {
      pid: process.pid,
      port: this.port,
      started: new Date().toISOString(),
      sessions: [] as string[],
    };
    const jsonPath = path.join(this.vaultDir, 'daemon.json');
    fs.writeFileSync(jsonPath, JSON.stringify(info, null, 2));
  }

  private removeDaemonJson(): void {
    const jsonPath = path.join(this.vaultDir, 'daemon.json');
    try {
      const content = fs.readFileSync(jsonPath, 'utf-8');
      const info = JSON.parse(content);
      // Only delete if we still own the file — a successor daemon may have taken over.
      if (info.pid !== process.pid) return;
      fs.unlinkSync(jsonPath);
    } catch { /* already gone or unreadable */ }
  }
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: string) => { data += chunk; });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}
