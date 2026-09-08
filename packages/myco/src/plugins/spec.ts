/*
 * Copyright 2026 Goondocks.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * The one description of the Myco plugin, from which every client's manifest is
 * emitted.
 *
 * A plugin carries skills and one MCP entry and nothing else. It cannot carry a
 * hook: a hook command is the binary's absolute path, resolved on the target
 * machine at install time, and a distributable bundle has neither the binary nor
 * the path. That is the whole of the plugin/installer split.
 *
 * Every client wants the same two values from the person installing it — the
 * Deployment's URL, and an access key — and spells the asking differently.
 * Holding the pair here and emitting each dialect keeps the five prompts from
 * drifting apart, which is the failure a per-client hand-written manifest
 * invites.
 */

/** One value a client asks the installing person for. */
export interface PluginConfigKey {
  /** Identifier the manifests key on. */
  readonly id: string;
  /** Label a client shows. */
  readonly label: string;
  /** One sentence telling the person what to paste. */
  readonly description: string;
  /** Whether a client should mask the value it collects. */
  readonly secret: boolean;
}

/** The Deployment's base URL. The MCP endpoint is this plus the server's MCP path. */
export const DEPLOYMENT_URL_KEY: PluginConfigKey = {
  id: 'deployment_url',
  label: 'Deployment URL',
  description: "The base URL of your team's Myco deployment, for example https://myco.example.com",
  secret: false,
};

/**
 * The access key. It is an External Agent grant: the one credential shape the
 * Deployment admits without a machine identity, a protocol header or a Project
 * header, none of which a plugin can supply. It reaches one Project, it is
 * minted by an administrator, and it expires.
 */
export const ACCESS_KEY_KEY: PluginConfigKey = {
  id: 'access_key',
  label: 'Access key',
  description: 'A project access key from your deployment dashboard. It reaches one project and expires.',
  secret: true,
};

export const PLUGIN_CONFIG_KEYS: readonly PluginConfigKey[] = [DEPLOYMENT_URL_KEY, ACCESS_KEY_KEY];

/** Name every client's manifest carries, and the directory the bundle lives in. */
export const PLUGIN_NAME = 'myco';

/** One sentence, shown in a client's plugin directory. */
export const PLUGIN_DESCRIPTION =
  "Your project's memory: the sessions that happened, the durable observations drawn from them, and the plans. Skills and tools for reading why the code is the way it is, and for recording what you learn.";

export const PLUGIN_HOMEPAGE = 'https://myco.sh';
export const PLUGIN_LICENSE = 'Apache-2.0';
export const PLUGIN_AUTHOR = 'Goondocks';
export const PLUGIN_KEYWORDS: readonly string[] = ['myco', 'memory', 'context', 'sessions', 'spores'];

/** The name the MCP entry is registered under in every client. */
export const MCP_SERVER_NAME = 'myco';

/** Path the Deployment serves MCP on, appended to the configured URL. */
export const MCP_PATH = '/mcp';

/** The Agent Plugins 1.0 manifest schema every portable client validates against. */
export const AGENT_PLUGINS_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
