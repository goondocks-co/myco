import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type { DaemonLogger } from './logger.js';
import { getPluginVersion } from '../version.js';
import { Router, type RouteHandler } from './router.js';
import { resolveStaticFile } from './static.js';

const DEFAULT_STATUS = 200;
const UI_REDIRECT_PATH = '/ui';
const UI_PATH_PREFIX = '/ui';

export interface DaemonServerConfig {
  vaultDir: string;
  logger: DaemonLogger;
  uiDir?: string;
}

export class DaemonServer {
  port = 0;
  readonly version: string;
  uiDir: string | null;
  private server: http.Server | null = null;
  private vaultDir: string;
  private logger: DaemonLogger;
  private router = new Router();

  constructor(config: DaemonServerConfig) {
    this.vaultDir = config.vaultDir;
    this.logger = config.logger;
    this.uiDir = config.uiDir ?? null;
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
        this.logger.info('daemon', 'Server started', { port: this.port });
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
    const url = new URL(req.url!, 'http://localhost');
    const pathname = url.pathname;

    // Static file serving for /ui* paths — handled before route matching
    if (pathname.startsWith(UI_PATH_PREFIX)) {
      if (pathname === UI_REDIRECT_PATH) {
        res.writeHead(301, { Location: `${UI_REDIRECT_PATH}/` });
        res.end();
        return;
      }

      if (!this.uiDir) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'UI not available' }));
        return;
      }

      const result = resolveStaticFile(this.uiDir, pathname);
      if (!result) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }

      const content = fs.readFileSync(result.filePath);
      res.writeHead(200, {
        'Content-Type': result.contentType,
        'Cache-Control': result.cacheControl,
      });
      res.end(content);
      return;
    }

    const match = this.router.match(req.method!, req.url!);

    if (!match) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }

    try {
      const body = (req.method === 'POST' || req.method === 'PUT') ? await readBody(req) : undefined;
      const result = await match.handler({
        body,
        query: match.query,
        params: match.params,
        pathname: match.pathname,
      });
      const status = result.status ?? DEFAULT_STATUS;
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
  }

  updateDaemonJsonSessions(sessions: string[]): void {
    const jsonPath = path.join(this.vaultDir, 'daemon.json');
    try {
      const info = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
      info.sessions = sessions;
      fs.writeFileSync(jsonPath, JSON.stringify(info, null, 2));
    } catch { /* daemon.json may not exist during shutdown */ }
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
    try { fs.unlinkSync(jsonPath); } catch { /* already gone */ }
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
