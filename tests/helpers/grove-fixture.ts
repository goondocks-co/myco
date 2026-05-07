/**
 * Shared test scaffolding for Grove-aware daemon tests.
 *
 * Tests need an isolated MYCO_HOME, a logger, and helpers to materialize
 * Groves and register projects. Without this helper each test file
 * reinvents the same mkdtempSync + env-swap dance, drifting subtly over
 * time. New tests should consume `setupGroveFixture()` and call its
 * methods directly.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DaemonLogger } from '@myco/daemon/logger.js';
import { ensureGroveDatabase } from '@myco/grove/database.js';
import {
  createGrove,
  registerProjectInGrove,
  type GroveRecord,
} from '@myco/grove/registry.js';

export interface GroveFixtureCtx {
  workDir: string;
  mycoHome: string;
  logger: DaemonLogger;
  cleanup: () => void;
  createGrove: (name: string) => GroveRecord;
  registerProject: (grove: GroveRecord, projectId: string, slug: string) => string;
}

/**
 * Build a fresh MYCO_HOME under a tmp dir, swap process.env, and return
 * helpers + cleanup. Call `cleanup()` from afterEach. Subsequent calls in
 * the same test stack each get their own tmp dir.
 */
export function setupGroveFixture(): GroveFixtureCtx {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grove-fx-'));
  const mycoHome = path.join(workDir, 'home');
  fs.mkdirSync(mycoHome, { recursive: true });
  const previousMycoHome = process.env.MYCO_HOME;
  process.env.MYCO_HOME = mycoHome;

  const logger = new DaemonLogger(path.join(workDir, 'logs'), { level: 'error' });

  return {
    workDir,
    mycoHome,
    logger,
    cleanup() {
      if (previousMycoHome === undefined) {
        delete process.env.MYCO_HOME;
      } else {
        process.env.MYCO_HOME = previousMycoHome;
      }
      fs.rmSync(workDir, { recursive: true, force: true });
    },
    createGrove(name: string): GroveRecord {
      const grove = createGrove(name, mycoHome);
      ensureGroveDatabase(grove.id, mycoHome);
      return grove;
    },
    registerProject(grove: GroveRecord, projectId: string, slug: string): string {
      const projectRoot = path.join(workDir, 'projects', slug);
      fs.mkdirSync(path.join(projectRoot, '.myco'), { recursive: true });
      registerProjectInGrove(
        grove.id,
        { projectId, projectName: slug, projectRoot },
        mycoHome,
      );
      return projectRoot;
    },
  };
}
