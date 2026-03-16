import { ensureNativeDeps } from '../native-deps.js';
ensureNativeDeps();
await import('../mcp/server.js');
