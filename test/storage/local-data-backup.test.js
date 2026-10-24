import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { LocalDataBackupError, backupLocalData, restoreLocalData } from '../../src/storage/local-data-backup.js';

const execute = promisify(execFile);

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'inktrail-backup-'));
  const dataDirectory = join(root, 'data');
  const backupDirectory = join(root, 'backup');
  const restoreDirectory = join(root, 'restored');
  await mkdir(join(dataDirectory, 'exports'), { recursive: true });
  await writeFile(join(dataDirectory, 'inktrail.sqlite'), 'sqlite bytes', { flag: 'w' });
  await writeFile(join(dataDirectory, 'exports', 'novel.epub'), 'epub bytes', { flag: 'w' });
  t.after(() => rm(root, { recursive: true, force: true }));
  return { dataDirectory, backupDirectory, restoreDirectory };
}

test('backs up and restores the full local data directory with verified files', async (t) => {
  const paths = await fixture(t);
  const backup = await backupLocalData({ ...paths, createdAt: () => '2026-10-24T00:00:00.000Z' });
  const restored = await restoreLocalData({ backupDirectory: paths.backupDirectory, dataDirectory: paths.restoreDirectory });

  assert.deepEqual(backup, { backupDirectory: paths.backupDirectory, fileCount: 2, totalBytes: 22 });
  assert.deepEqual(restored, { dataDirectory: paths.restoreDirectory, fileCount: 2, totalBytes: 22 });
  assert.equal(await readFile(join(paths.restoreDirectory, 'inktrail.sqlite'), 'utf8'), 'sqlite bytes');
  assert.equal(await readFile(join(paths.restoreDirectory, 'exports', 'novel.epub'), 'utf8'), 'epub bytes');
});

test('refuses existing restore destinations and detects altered backup files', async (t) => {
  const paths = await fixture(t);
  await backupLocalData(paths);
  await writeFile(join(paths.backupDirectory, 'inktrail.sqlite'), 'altered');

  await assert.rejects(() => restoreLocalData({ backupDirectory: paths.backupDirectory, dataDirectory: paths.restoreDirectory }), LocalDataBackupError);
  await assert.rejects(() => restoreLocalData({ backupDirectory: paths.backupDirectory, dataDirectory: paths.backupDirectory }), LocalDataBackupError);
});

test('rejects an incomplete manifest and symbolic links in a backup', async (t) => {
  const paths = await fixture(t);
  await backupLocalData(paths);
  const manifestPath = join(paths.backupDirectory, 'inktrail-backup.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const completeManifest = structuredClone(manifest);
  manifest.files = manifest.files.filter((file) => file.path !== 'exports/novel.epub');
  await writeFile(manifestPath, JSON.stringify(manifest));

  await assert.rejects(() => restoreLocalData({ backupDirectory: paths.backupDirectory, dataDirectory: paths.restoreDirectory }), LocalDataBackupError);
  await writeFile(manifestPath, JSON.stringify(completeManifest));
  await rm(join(paths.backupDirectory, 'exports'), { recursive: true });
  await symlink(paths.dataDirectory, join(paths.backupDirectory, 'exports'));

  await assert.rejects(() => restoreLocalData({ backupDirectory: paths.backupDirectory, dataDirectory: join(paths.restoreDirectory, 'symlinked') }), LocalDataBackupError);
});

test('fails before publishing when data contains the reserved backup manifest name', async (t) => {
  const paths = await fixture(t);
  await writeFile(join(paths.dataDirectory, 'inktrail-backup.json'), '{}');

  await assert.rejects(() => backupLocalData(paths), LocalDataBackupError);
});

test('concurrent InkTrail backups do not replace each other’s output', async (t) => {
  const paths = await fixture(t);
  const results = await Promise.allSettled([
    backupLocalData(paths),
    backupLocalData(paths)
  ]);

  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  assert.equal(JSON.parse(await readFile(join(paths.backupDirectory, 'inktrail-backup.json'), 'utf8')).files.length, 2);
});

test('a failed backup releases its destination lock for a later retry', async (t) => {
  const paths = await fixture(t);
  await assert.rejects(() => backupLocalData({ ...paths, createdAt: () => 1n }));

  await backupLocalData(paths);
  assert.equal(JSON.parse(await readFile(join(paths.backupDirectory, 'inktrail-backup.json'), 'utf8')).files.length, 2);
});

test('backup and restore commands execute the verified local data workflow', async (t) => {
  const paths = await fixture(t);
  const backupScript = fileURLToPath(new URL('../../scripts/backup-local-data.js', import.meta.url));
  const restoreScript = fileURLToPath(new URL('../../scripts/restore-local-data.js', import.meta.url));

  const backup = await execute(process.execPath, [backupScript, paths.dataDirectory, paths.backupDirectory]);
  const restored = await execute(process.execPath, [restoreScript, paths.backupDirectory, paths.restoreDirectory]);

  assert.equal(JSON.parse(backup.stdout).fileCount, 2);
  assert.equal(JSON.parse(restored.stdout).fileCount, 2);
  assert.equal(await readFile(join(paths.restoreDirectory, 'exports', 'novel.epub'), 'utf8'), 'epub bytes');
});
