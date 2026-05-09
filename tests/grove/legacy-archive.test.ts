import { describe, it, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  archiveLegacyVaultData,
  completeLegacyArchive,
  GROVE_ACTIVATION_MARKER,
} from '@myco/grove/activation.js';

function makeFakeVault(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-archive-'));
  // Survivors per the Grove filesystem-layout plan: project identity,
  // user config, project-authored task overrides, hook fallback buffer,
  // migration marker, runtime pin, secrets, machine id.
  fs.writeFileSync(path.join(dir, 'project.toml'), '[project]\nid = "proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"\n');
  fs.writeFileSync(path.join(dir, 'myco.yaml'), 'version: 3\n');
  fs.writeFileSync(path.join(dir, 'local.yaml'), 'machine: test\n');
  fs.writeFileSync(path.join(dir, 'runtime.command'), 'myco-run\n');
  fs.writeFileSync(path.join(dir, 'secrets.env'), 'OPENAI_API_KEY=test\n');
  fs.writeFileSync(path.join(dir, 'machine_id'), 'test-machine\n');
  fs.mkdirSync(path.join(dir, 'tasks'));
  fs.writeFileSync(path.join(dir, 'tasks', 'custom.yaml'), 'name: custom\n');
  fs.mkdirSync(path.join(dir, 'buffer'));
  fs.writeFileSync(path.join(dir, 'buffer', 'session.jsonl'), '{}\n');
  fs.mkdirSync(path.join(dir, 'migration'));
  fs.writeFileSync(path.join(dir, 'migration', 'grove-activation.json'), '{"status":"activated"}\n');

  // Archived: legacy DBs and per-vault daemon state.
  fs.writeFileSync(path.join(dir, 'myco.db'), 'fake db');
  fs.writeFileSync(path.join(dir, 'myco.db-shm'), '');
  fs.writeFileSync(path.join(dir, 'vectors.db'), 'fake vec');
  fs.mkdirSync(path.join(dir, 'attachments'));
  fs.writeFileSync(path.join(dir, 'attachments', 'foo.png'), 'png');
  fs.mkdirSync(path.join(dir, 'logs'));
  fs.writeFileSync(path.join(dir, 'logs', 'daemon.log'), 'log\n');
  fs.mkdirSync(path.join(dir, 'staging'));
  fs.writeFileSync(path.join(dir, 'staging', 'skill.md'), 'staged\n');
  fs.mkdirSync(path.join(dir, 'team'));
  fs.writeFileSync(path.join(dir, 'team', 'config.json'), '{}\n');

  return dir;
}

describe('archiveLegacyVaultData', () => {
  it('moves legacy data into a timestamped archive directory', () => {
    const vault = makeFakeVault();
    try {
      const archiveDir = archiveLegacyVaultData(vault);

      expect(archiveDir).not.toBeNull();
      expect(path.basename(archiveDir!).startsWith('.archive-')).toBe(true);
      expect(fs.existsSync(path.join(archiveDir!, 'myco.db'))).toBe(true);
      expect(fs.existsSync(path.join(archiveDir!, 'vectors.db'))).toBe(true);
      expect(fs.existsSync(path.join(archiveDir!, 'attachments', 'foo.png'))).toBe(true);
      expect(fs.existsSync(path.join(archiveDir!, 'logs', 'daemon.log'))).toBe(true);
      expect(fs.existsSync(path.join(archiveDir!, 'staging', 'skill.md'))).toBe(true);
      expect(fs.existsSync(path.join(archiveDir!, 'team', 'config.json'))).toBe(true);

      // Survivors stay at the top of the vault.
      expect(fs.existsSync(path.join(vault, 'project.toml'))).toBe(true);
      expect(fs.existsSync(path.join(vault, 'myco.yaml'))).toBe(true);
      expect(fs.existsSync(path.join(vault, 'local.yaml'))).toBe(true);
      expect(fs.existsSync(path.join(vault, 'runtime.command'))).toBe(true);
      expect(fs.existsSync(path.join(vault, 'secrets.env'))).toBe(true);
      expect(fs.existsSync(path.join(vault, 'machine_id'))).toBe(true);
      expect(fs.existsSync(path.join(vault, 'tasks', 'custom.yaml'))).toBe(true);
      expect(fs.existsSync(path.join(vault, 'buffer', 'session.jsonl'))).toBe(true);
      expect(fs.existsSync(path.join(vault, 'migration', 'grove-activation.json'))).toBe(true);

      // Archived items are gone from the top.
      expect(fs.existsSync(path.join(vault, 'myco.db'))).toBe(false);
      expect(fs.existsSync(path.join(vault, 'attachments'))).toBe(false);
      expect(fs.existsSync(path.join(vault, 'logs'))).toBe(false);
      expect(fs.existsSync(path.join(vault, 'staging'))).toBe(false);
      expect(fs.existsSync(path.join(vault, 'team'))).toBe(false);
    } finally {
      fs.rmSync(vault, { recursive: true, force: true });
    }
  });

  it('returns null when there is nothing to archive', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-archive-empty-'));
    try {
      fs.writeFileSync(path.join(dir, 'project.toml'), '[project]\nid = "proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"\n');
      const result = archiveLegacyVaultData(dir);
      expect(result).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('completeLegacyArchive', () => {
  function writeMarker(vault: string, withArchiveFlag: boolean): void {
    const dir = path.join(vault, 'migration');
    fs.mkdirSync(dir, { recursive: true });
    const marker: Record<string, unknown> = {
      status: 'activated',
      migration_id: 'mig_test',
      project_root: '/tmp/proj',
      project_id: 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      project_name: 'p',
      grove_id: 'grove_test',
      grove_slug: 'p',
      grove_binding_id: 'gbind_test',
      source_db_path: '/tmp/proj/.myco/myco.db',
      target_db_path: '/tmp/g/myco.db',
      activated_at: new Date().toISOString(),
      import_result: {},
      validation: {},
    };
    if (withArchiveFlag) {
      marker.legacy_archived = { archived_at: new Date().toISOString(), archive_dir: '' };
    }
    fs.writeFileSync(
      path.join(dir, GROVE_ACTIVATION_MARKER),
      `${JSON.stringify(marker, null, 2)}\n`,
    );
  }

  it('archives and stamps the marker when never archived before', () => {
    const vault = makeFakeVault();
    try {
      writeMarker(vault, false);

      const result = completeLegacyArchive(vault);
      expect(result.archived_dir).not.toBeNull();
      expect(result.already_complete).toBe(false);

      const marker = JSON.parse(
        fs.readFileSync(path.join(vault, 'migration', GROVE_ACTIVATION_MARKER), 'utf-8'),
      ) as { legacy_archived?: { archive_dir: string } };
      expect(marker.legacy_archived?.archive_dir).toBe(result.archived_dir!);
    } finally {
      fs.rmSync(vault, { recursive: true, force: true });
    }
  });

  it('returns already_complete when archive flag is set and nothing remains', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-archive-done-'));
    try {
      fs.writeFileSync(path.join(dir, 'project.toml'), '[project]\nid = "proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"\n');
      writeMarker(dir, true);

      const result = completeLegacyArchive(dir);
      expect(result.archived_dir).toBeNull();
      expect(result.already_complete).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns archived_dir when prior archive flag exists but new legacy items appeared', () => {
    const vault = makeFakeVault();
    try {
      // Marker says archived, but the vault still has legacy files (the
      // partial-archive case the user actually hit on dogfood).
      writeMarker(vault, true);

      const result = completeLegacyArchive(vault);
      expect(result.archived_dir).not.toBeNull();
      expect(fs.existsSync(path.join(vault, 'myco.db'))).toBe(false);
    } finally {
      fs.rmSync(vault, { recursive: true, force: true });
    }
  });
});
