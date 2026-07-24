/**
 * Copyright 2026 Myco Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';

import { migrateTeamsHomeIfNeeded } from '@myco/team/migrate-home.js';

const [legacyHome, destinationHome] = process.argv.slice(2);
if (!legacyHome || !destinationHome) {
  process.stderr.write('migration crash helper: required args missing\n');
  process.exit(64);
}

process.env.MYCO_TEAM_HOME = destinationHome;
const legacyTeams = path.join(legacyHome, 'teams');
const archive = `${legacyTeams}.bak-pre-myco-team`;
const renameSync = fs.renameSync.bind(fs);
fs.renameSync = ((source, destination) => {
  renameSync(source, destination);
  if (path.resolve(String(source)) === path.resolve(legacyTeams)
    && path.resolve(String(destination)) === path.resolve(archive)) {
    process.exit(86);
  }
}) as typeof fs.renameSync;

migrateTeamsHomeIfNeeded([legacyHome]);
process.exit(70);
