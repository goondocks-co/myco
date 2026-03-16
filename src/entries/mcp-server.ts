import { ensureNativeDeps } from '../native-deps.js';
ensureNativeDeps();
const { main } = await import('../mcp/server.js');
await main();
