import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type { DaemonLogger } from './logger.js';

export interface DaemonServerConfig {
  vaultDir: string;
  logger: DaemonLogger;
}

type RouteHandler = (body: unknown) => Promise<unknown>;

export class DaemonServer {
  port = 0;
  private server: http.Server | null = null;
  private vaultDir: string;
  private logger: DaemonLogger;
  private routes: Map<string, { method: string; handler: RouteHandler }> = new Map();

  constructor(config: DaemonServerConfig) {
    this.vaultDir = config.vaultDir;
    this.logger = config.logger;
    this.registerDefaultRoutes();
  }

  registerRoute(method: string, routePath: string, handler: RouteHandler): void {
    this.routes.set(`${method} ${routePath}`, { method, handler });
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handleRequest(req, res));
      this.server.on('error', reject);

      this.server.listen(0, '127.0.0.1', () => {
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
      myco: true,
      pid: process.pid,
      uptime: process.uptime(),
    }));
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const key = `${req.method} ${req.url}`;
    const route = this.routes.get(key);

    if (!route) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }

    try {
      const body = req.method === 'POST' ? await readBody(req) : undefined;
      const result = await route.handler(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
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
