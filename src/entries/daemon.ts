import { ensureNativeDeps } from '../native-deps.js';
ensureNativeDeps();
const { main } = await import('../daemon/main.js');
await main();
