/*
 * Copyright 2026 Myco Contributors
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
/**
 * Help text may only document flags the parser accepts.
 *
 * `myco join --help` advertised `--server-url <headscale-url>`, `--hostname`,
 * and `--overlay-address` — flags nothing read. A user following the help got a
 * silently ignored argument and no error, because an unknown flag simply never
 * matches a `flags.get(...)`. Nothing failed when the parser changed, since the
 * help is a string and strings do not typecheck against behaviour.
 *
 * This asserts the direction that matters: every long flag a help text
 * ADVERTISES is read somewhere in its command's module. The reverse (an
 * undocumented flag) is deliberately allowed — debugging seams exist.
 */
import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import { JOIN_HELP, LEAVE_HELP } from '@myco/cli/join';
import { HOST_HELP } from '@myco/cli/host';

const SRC = path.join(import.meta.dir, '..', '..', 'packages', 'myco', 'src');

/** Long flags a help text tells the user to pass. */
function advertisedFlags(help: string): string[] {
  return [...new Set(Array.from(help.matchAll(/--([a-z][a-z0-9-]+)/g), (m) => m[1]!))];
}

/** Flags a module actually reads, via the shared `parseFlags` map. */
function parsedFlags(...files: string[]): Set<string> {
  const found = new Set<string>();
  for (const file of files) {
    const source = fs.readFileSync(path.join(SRC, file), 'utf-8');
    for (const m of source.matchAll(/flags\.(?:get|has)\(\s*'([^']+)'/g)) found.add(m[1]!);
    // Flags forwarded as request fields rather than read individually.
    for (const m of source.matchAll(/'([a-z][a-z0-9-]+)':\s*flags\.get/g)) found.add(m[1]!);
  }
  return found;
}

/** Help is prose, so a few words legitimately start with `--` without being
 *  flags of THIS command (`--serve` names an installer flag, `--help` is
 *  handled before parsing). */
const NOT_THIS_COMMANDS_FLAGS = new Set(['help', 'serve']);

describe('CLI help documents only flags the parser accepts', () => {
  const cases: Array<{ name: string; help: string; files: string[] }> = [
    { name: 'join', help: JOIN_HELP, files: ['cli/join.ts'] },
    { name: 'leave', help: LEAVE_HELP, files: ['cli/join.ts'] },
    { name: 'host', help: HOST_HELP, files: ['cli/host.ts'] },
  ];

  for (const { name, help, files } of cases) {
    test(`${name}: every advertised flag is read`, () => {
      const parsed = parsedFlags(...files);
      const phantom = advertisedFlags(help)
        .filter((f) => !NOT_THIS_COMMANDS_FLAGS.has(f))
        .filter((f) => !parsed.has(f));

      expect(
        phantom,
        `\`myco ${name} --help\` advertises ${phantom.join(', ')}, which nothing reads. `
        + 'A user passing them gets silence, not an error.',
      ).toEqual([]);
    });
  }

  test('no help text names a transport the product does not have', () => {
    // The member reaches a host at ONE public HTTPS URL. Anything describing a
    // network to join, a control plane to register with, or an address family
    // to dial is describing something a user cannot do.
    const forbidden = /headscale|tailscaled|tailnet node|overlay|100\.64\./i;
    for (const { name, help } of cases) {
      const offending = help.split('\n').filter((line) => forbidden.test(line));
      expect(offending, `\`myco ${name} --help\` describes a transport that does not exist:\n${offending.join('\n')}`)
        .toEqual([]);
    }
  });
});
