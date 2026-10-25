/** Client-root bootstrap and destination admission for the stdio bridge. */
import { fileURLToPath } from 'node:url';
import { SERVER_INSTRUCTIONS, servedMcpVersions } from '@goondocks/myco-shared/mcp-protocol';
import { getPluginVersion } from '@myco/version.js';
import { randomUUID } from 'node:crypto';
import { SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/server';
import type { JSONRPCMessage, JSONRPCRequest } from '@modelcontextprotocol/server';
import type { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { memberHomeFor } from '@myco/member/home-for-folder.js';
import { resolveMycoHome } from '@myco/paths/home.js';
import { resolveDeploymentUpstream, soleDeploymentUpstream, type DeploymentUpstream } from './deployment-upstream.js';

const PROTOCOL_VERSIONS = servedMcpVersions(SUPPORTED_PROTOCOL_VERSIONS);

export const ROOTS_BOOTSTRAP_TIMEOUT_MS = 30_000;
export const ROOTS_BOOTSTRAP_MAX_MESSAGES = 32;
export const ROOTS_MAX_COUNT = 128;

/** Connected roots name one Project; wholly unconnected roots require one readable Deployment. */
export function clientRootDestination(uris: readonly string[], env: NodeJS.ProcessEnv = process.env): () => DeploymentUpstream {
  const folders = uris.map(uri => {
    const url = new URL(uri);
    if ((url.hostname !== '' && url.hostname !== 'localhost') || url.search || url.hash) throw new Error('Myco client roots must be local file URIs');
    return fileURLToPath(url);
  });
  const homes = folders.map(folder => memberHomeFor(folder, env).home);
  const fallbackHome = resolveMycoHome({ env });
  let frozen: { home: string; url: string; projectId?: string } | undefined;
  return () => {
    const roots = folders.map((cwd, index) => {
      const home = memberHomeFor(cwd, env).home;
      if (home !== homes[index]) throw new Error('The project home changed; reconnect Myco tools');
      let unconnected = false;
      const upstream = resolveDeploymentUpstream('registry', { cwd, mycoHome: home, env, invokedBy: 'mcp',
        claimsUnconnected: () => { unconnected = true; return true; },
        missingMembershipMessage: () => 'A client root has no connected Project; connect every root or open one Project, then reconnect Myco tools' });
      if (!upstream && !unconnected) throw new Error('A client root membership is unavailable; reconnect Myco tools after restoring it');
      return { home, upstream };
    });
    const candidates = roots.flatMap(root => root.upstream === null ? [] : [{ home: root.home, upstream: root.upstream }]);
    if (candidates.length === 0) {
      const home = roots[0]?.home ?? fallbackHome;
      if (roots.some(root => root.home !== home)) throw new Error('Client roots name different Myco homes; open one Project and reconnect Myco tools');
      if (folders.length === 0 && resolveMycoHome({ env }) !== fallbackHome) throw new Error('The machine home changed; reconnect Myco tools');
      const upstream = soleDeploymentUpstream(home);
      if (!upstream) throw new Error('Myco tools need client roots or exactly one readable Deployment membership; open one connected Project and reconnect Myco tools');
      candidates.push({ home, upstream });
    } else if (candidates.length !== roots.length) {
      throw new Error('A client root has no connected Project; connect every root or open one Project, then reconnect Myco tools');
    }
    const selected = candidates[0];
    const identity = { home: selected.home, url: selected.upstream.serverUrl, projectId: selected.upstream.projectId };
    if (candidates.some(candidate => candidate.home !== identity.home || candidate.upstream.serverUrl !== identity.url || candidate.upstream.projectId !== identity.projectId)) {
      throw new Error('Client roots name different Myco destinations; open one Project and reconnect Myco tools');
    }
    if (frozen && (frozen.home !== identity.home || frozen.url !== identity.url || frozen.projectId !== identity.projectId)) {
      throw new Error('The project connection changed; reconnect Myco tools');
    }
    frozen = identity;
    return selected.upstream;
  };
}

export interface RootsBootstrap {
  initialize: JSONRPCRequest;
  destination: () => DeploymentUpstream;
  release(handler: (message: JSONRPCMessage) => void): void;
  invalidate(): void;
  refuse(error: unknown): Promise<void>;
}

/** A refused connection answers requests locally and admits no upstream traffic. */
export async function refuseClientRoots(downstream: StdioServerTransport, error: unknown, queued: JSONRPCMessage[] = []): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const refuse = async (request: JSONRPCMessage): Promise<void> => {
    if ('method' in request && 'id' in request) await downstream.send({ jsonrpc: '2.0', id: request.id,
      error: { code: -32000, message } });
  };
  downstream.onmessage = request => { void refuse(request).catch(error => downstream.onerror?.(error)); };
  await Promise.all(queued.splice(0).map(refuse));
}

/** Initialization completes locally before requesting roots; no upstream exists during bootstrap. */
export async function bootstrapClientRoots(downstream: StdioServerTransport): Promise<RootsBootstrap> {
  const queued: JSONRPCMessage[] = [];
  const requestId = `myco-roots-${randomUUID()}`;
  let initialize: JSONRPCRequest | undefined;
  let requested = false;
  let failure: Error | undefined;
  let finish: (uris: string[]) => void;
  let fail: (error: Error) => void;
  const roots = new Promise<string[]>((resolve, reject) => { finish = resolve; fail = reject; });
  const recordFailure = (error: unknown): void => {
    failure = error instanceof Error ? error : new Error(String(error));
    fail(failure);
  };
  const timer = setTimeout(() => recordFailure(new Error('Myco client roots initialization timed out; reconnect Myco tools')), ROOTS_BOOTSTRAP_TIMEOUT_MS);
  downstream.onclose = () => recordFailure(new Error('The MCP client closed during roots initialization'));
  downstream.onerror = recordFailure;
  downstream.onmessage = message => {
    void (async () => {
      if ('method' in message && message.method === 'notifications/roots/list_changed') {
        throw new Error('Client roots changed; reconnect Myco tools');
      }
      if ('method' in message && message.method === 'initialize' && 'id' in message) {
        if (initialize) throw new Error('Duplicate MCP initialization');
        initialize = message;
        const version = message.params?.protocolVersion;
        await downstream.send({ jsonrpc: '2.0', id: message.id, result: {
          protocolVersion: typeof version === 'string' && PROTOCOL_VERSIONS.includes(version) ? version : PROTOCOL_VERSIONS[0],
          instructions: SERVER_INSTRUCTIONS, capabilities: { tools: {} }, serverInfo: { name: 'myco', version: getPluginVersion() },
        } });
        return;
      }
      if ('method' in message && message.method === 'notifications/initialized') {
        if (!initialize || requested) throw new Error('Unexpected MCP initialized notification');
        requested = true;
        const capabilities = initialize.params?.capabilities;
        if (capabilities && typeof capabilities === 'object' && 'roots' in capabilities) {
          await downstream.send({ jsonrpc: '2.0', id: requestId, method: 'roots/list' });
        } else finish([]);
        return;
      }
      if (!('method' in message) && message.id === requestId) {
        if (!requested || !('result' in message) || !Array.isArray(message.result.roots)) throw new Error('The MCP client could not provide roots');
        const roots = message.result.roots;
        if (roots.length > ROOTS_MAX_COUNT || roots.some(root => !root || typeof root !== 'object' || !('uri' in root) || typeof root.uri !== 'string')) throw new Error('The MCP client returned invalid roots');
        finish(roots.map(root => root.uri));
        return;
      }
      if (queued.length >= ROOTS_BOOTSTRAP_MAX_MESSAGES) throw new Error('Too many MCP messages before client roots resolved');
      queued.push(message);
    })().catch(recordFailure);
  };
  try {
    await downstream.start();
    const uris = await roots;
    if (!initialize) throw new Error('MCP initialization is missing');
    const destination = clientRootDestination(uris);
    destination();
    return { initialize, destination: () => {
      if (failure) throw failure;
      return destination();
    }, refuse: error => refuseClientRoots(downstream, error, queued), invalidate() { failure = new Error('Client roots changed; reconnect Myco tools'); }, release(handler) {
      if (failure) throw failure;
      downstream.onmessage = handler;
      for (const message of queued.splice(0)) handler(message);
    } };
  } catch (error) {
    await refuseClientRoots(downstream, error, queued);
    throw error;
  } finally { clearTimeout(timer); }
}
