/**
 * Copyright 2026 Chris Kirby
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import {
  ProtectedMachineConfigPathError,
  enableExternalMcpConfig,
  disableExternalMcpConfig,
  loadMachineConfig,
  saveMachineConfig,
  updateTierConfigRaw,
} from '@myco/config/loader.js';

function fixture(): { home: string; configPath: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-machine-config-protection-'));
  const configPath = path.join(home, 'config.yaml');
  fs.writeFileSync(configPath, YAML.stringify({
    machine_future: { keep: true },
    daemon: {
      external_mcp: {
        enabled: false,
        port: 8743,
        future_external_field: 'preserved',
      },
    },
  }));
  return { home, configPath };
}

describe('machine config external MCP protection', () => {
  test('the generic raw writer refuses an external MCP change without changing bytes', () => {
    const { home, configPath } = fixture();
    const before = fs.readFileSync(configPath);

    expect(() => updateTierConfigRaw({ kind: 'machine' }, (raw) => {
      const daemon = raw.daemon as Record<string, unknown>;
      daemon.external_mcp = { enabled: true, port: 9000 };
    }, { mycoHome: home })).toThrow(ProtectedMachineConfigPathError);

    expect(fs.readFileSync(configPath)).toEqual(before);
  });

  test('a stale whole-machine snapshot cannot restore enabled state', () => {
    const { home, configPath } = fixture();
    const stale = loadMachineConfig(home);
    stale.daemon.external_mcp = { enabled: true, port: 8743 };
    const before = fs.readFileSync(configPath);

    expect(() => saveMachineConfig(stale, home))
      .toThrow(ProtectedMachineConfigPathError);

    expect(fs.readFileSync(configPath)).toEqual(before);
  });

  test('an unrelated raw update preserves the exact external subtree', () => {
    const { home, configPath } = fixture();

    updateTierConfigRaw({ kind: 'machine' }, (raw) => {
      const daemon = raw.daemon as Record<string, unknown>;
      daemon.log_level = 'debug';
    }, { mycoHome: home });

    const raw = YAML.parse(fs.readFileSync(configPath, 'utf-8')) as {
      machine_future: { keep: boolean };
      daemon: {
        log_level: string;
        external_mcp: Record<string, unknown>;
      };
    };
    expect(raw.machine_future).toEqual({ keep: true });
    expect(raw.daemon.log_level).toBe('debug');
    expect(raw.daemon.external_mcp).toEqual({
      enabled: false,
      port: 8743,
      future_external_field: 'preserved',
    });
  });
});

describe('enableExternalMcpConfig — the one sanctioned enable writer', () => {
  test('stamps an explicit enabled subtree, preserves unknown siblings, and round-trips through disable', () => {
    const { home, configPath } = fixture();

    const enabled = enableExternalMcpConfig(home, { durable: true });
    expect(enabled.daemon.external_mcp.enabled).toBe(true);
    const raw = YAML.parse(fs.readFileSync(configPath, 'utf-8'));
    // The subtree is EXPLICIT on disk — the boot-breaking brownfield state
    // (token present, no explicit subtree) is unrepresentable after enable.
    expect(raw.daemon.external_mcp.enabled).toBe(true);
    expect(typeof raw.daemon.external_mcp.port).toBe('number');
    expect(raw.machine_future).toEqual({ keep: true });

    const disabled = disableExternalMcpConfig(home, { durable: true });
    expect(disabled.daemon.external_mcp.enabled).toBe(false);
  });

  test('preserves an existing explicit port instead of clobbering it with the default', () => {
    const { home, configPath } = fixture();
    const raw = YAML.parse(fs.readFileSync(configPath, 'utf-8'));
    raw.daemon = { ...raw.daemon, external_mcp: { enabled: false, port: 9911 } };
    fs.writeFileSync(configPath, YAML.stringify(raw));

    const enabled = enableExternalMcpConfig(home);
    expect(enabled.daemon.external_mcp).toMatchObject({ enabled: true, port: 9911 });
  });

  test('the general save path STILL refuses the subtree after the enable writer exists', () => {
    const { home } = fixture();
    enableExternalMcpConfig(home);
    const machine = loadMachineConfig(home);
    expect(() => saveMachineConfig({
      ...machine,
      daemon: { ...machine.daemon, external_mcp: { enabled: false, port: 8000 } },
    }, home)).toThrow(ProtectedMachineConfigPathError);
  });
});
