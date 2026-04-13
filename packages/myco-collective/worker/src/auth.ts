export const ADMIN_TOKEN_KEY = 'collective_admin_token';
export const MCP_TOKEN_KEY = 'collective_mcp_token';
export const WORKER_TOKEN_KEY = 'collective_worker_token';
const TOKEN_BYTE_LENGTH = 24;

function hashToken(token: string): string {
  let hash = 0;
  for (let index = 0; index < token.length; index++) {
    hash = ((hash << 5) - hash + token.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(16).padStart(8, '0').slice(0, 8);
}

export async function ensureBootstrapTokens(
  secrets: KVNamespace,
  adminToken: string | undefined,
  mcpToken: string | undefined,
): Promise<{ adminToken: string | null; mcpToken: string | null; workerToken: string | null }> {
  let storedAdmin = await secrets.get(ADMIN_TOKEN_KEY);
  let storedMcp = await secrets.get(MCP_TOKEN_KEY);
  let storedWorker = await secrets.get(WORKER_TOKEN_KEY);

  if (!storedAdmin && adminToken) {
    await secrets.put(ADMIN_TOKEN_KEY, adminToken);
    storedAdmin = adminToken;
  }
  if (!storedMcp && mcpToken) {
    await secrets.put(MCP_TOKEN_KEY, mcpToken);
    storedMcp = mcpToken;
  }
  if (!storedWorker) {
    storedWorker = randomToken();
    await secrets.put(WORKER_TOKEN_KEY, storedWorker);
  }

  return { adminToken: storedAdmin, mcpToken: storedMcp, workerToken: storedWorker };
}

async function validateBearer(request: Request, secrets: KVNamespace, key: string): Promise<Response | null> {
  const header = request.headers.get('Authorization');
  const token = header?.startsWith('Bearer ') ? header.slice(7) : '';
  const expected = await secrets.get(key);
  if (!token || !expected || token !== expected) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return null;
}

export async function validateAdminAuth(request: Request, secrets: KVNamespace): Promise<Response | null> {
  return validateBearer(request, secrets, ADMIN_TOKEN_KEY);
}

export async function validateMcpAuth(request: Request, secrets: KVNamespace): Promise<Response | null> {
  return validateBearer(request, secrets, MCP_TOKEN_KEY);
}

export async function validateWorkerAuth(request: Request, secrets: KVNamespace): Promise<Response | null> {
  return validateBearer(request, secrets, WORKER_TOKEN_KEY);
}

export function tokenHash(token: string | null): string | null {
  return token ? hashToken(token) : null;
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(TOKEN_BYTE_LENGTH));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function rotateTokens(
  secrets: KVNamespace,
  which: 'admin' | 'mcp' | 'all' = 'all',
): Promise<{ adminToken: string | null; mcpToken: string | null }> {
  const nextAdminToken = which === 'admin' || which === 'all' ? randomToken() : null;
  const nextMcpToken = which === 'mcp' || which === 'all' ? randomToken() : null;

  if (nextAdminToken) {
    await secrets.put(ADMIN_TOKEN_KEY, nextAdminToken);
  }
  if (nextMcpToken) {
    await secrets.put(MCP_TOKEN_KEY, nextMcpToken);
  }

  return { adminToken: nextAdminToken, mcpToken: nextMcpToken };
}
