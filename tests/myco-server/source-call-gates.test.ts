import { expect, it } from 'bun:test';
import { sourceCalls, memberWrites } from './helpers/source-calls.js';

it('pins named import aliases for secret construction, openers and minters', () => {
  for (const name of ['deploymentSecretStore', 'openProviderCredential', 'openHarnessCredential', 'mintInsert', 'issueIdentityLinkAuthority']) {
    expect(sourceCalls(`import { ${name} as alias } from './module.js'; function route() { alias(); }`))
      .toEqual([{ called: name, owner: 'route' }]);
    expect(sourceCalls(`import * as secret from './module.js'; function route() { secret.${name}(); }`))
      .toEqual([{ called: name, owner: 'route' }]);
  }
});

it('finds every members mutation case-insensitively, including replacement and conflict updates', () => {
  for (const sql of [
    'insert or replace into members (id) values (?)', 'RePlAcE INTO members (id) values (?)',
    'update members set role = ?', 'delete FROM members where id = ?',
    'INSERT INTO members (id) VALUES (?) ON CONFLICT(id) DO UPDATE SET role = ?',
  ]) expect(memberWrites(`const sql = \`${sql}\`;`)).toEqual([sql]);
});
