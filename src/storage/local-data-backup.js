import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

const MANIFEST_FILE = 'inktrail-backup.json';

export class LocalDataBackupError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LocalDataBackupError';
  }
}

function text(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new LocalDataBackupError(`${label} is required.`);
  return resolve(value);
}

function safeRelativePath(value) {
  return typeof value === 'string' && value.length > 0 && !value.includes('\\') && !isAbsolute(value) && value !== MANIFEST_FILE && value.split('/').every((segment) => segment && segment !== '.' && segment !== '..');
}

function isNestedPath(parent, child) {
  const between = relative(parent, child);
  return between && !between.startsWith('..') && !isAbsolute(between);
}

async function claimDestination(path, label) {
  const lockPath = `${path}.inktrail-lock`;
  let createdLock = false;
  try {
    const lock = await open(lockPath, 'wx');
    createdLock = true;
    await lock.close();
  } catch (error) {
    if (createdLock) await unlink(lockPath).catch(() => {});
    if (error?.code === 'EEXIST') throw new LocalDataBackupError(`${label} is already being created or must not already exist.`);
    throw error;
  }
  const release = async () => unlink(lockPath).catch((error) => {
    if (error?.code !== 'ENOENT') throw error;
  });
  try {
    await lstat(path);
    await release();
    throw new LocalDataBackupError(`${label} must not already exist.`);
  } catch (error) {
    if (error?.code === 'ENOENT') return release;
    await release();
    throw error;
  }
}

async function requireDirectory(path, label) {
  let details;
  try {
    details = await lstat(path);
  } catch (error) {
    throw new LocalDataBackupError(`${label} does not exist.`);
  }
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new LocalDataBackupError(`${label} must be a real directory.`);
  }
}

async function sha256(path) {
  const digest = createHash('sha256');
  await new Promise((resolvePromise, reject) => {
    const input = createReadStream(path);
    input.on('data', (chunk) => digest.update(chunk));
    input.on('error', reject);
    input.on('end', resolvePromise);
  });
  return digest.digest('hex');
}

async function listRegularFiles(directory, prefix = '') {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const sourcePath = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new LocalDataBackupError('local data must not contain symbolic links.');
    if (entry.isDirectory()) files.push(...await listRegularFiles(sourcePath, relativePath));
    else if (entry.isFile()) files.push(relativePath);
    else throw new LocalDataBackupError('local data must contain only regular files and directories.');
  }
  return files;
}

async function stageDirectory(target) {
  const parent = dirname(target);
  await mkdir(parent, { recursive: true });
  return join(parent, `.${basename(target)}.staging-${randomUUID()}`);
}

async function copyVerifiedFiles({ sourceDirectory, targetDirectory, files, expected = null }) {
  const records = [];
  const sourceRealDirectory = await realpath(sourceDirectory);
  for (const relativePath of files) {
    const sourcePath = join(sourceDirectory, relativePath);
    const targetPath = join(targetDirectory, relativePath);
    const details = await lstat(sourcePath);
    if (!details.isFile() || details.isSymbolicLink()) throw new LocalDataBackupError('backup source changed while copying.');
    if (await realpath(sourcePath) !== resolve(sourceRealDirectory, relativePath)) {
      throw new LocalDataBackupError('backup source must not traverse symbolic links.');
    }
    await mkdir(dirname(targetPath), { recursive: true });
    await copyFile(sourcePath, targetPath);
    const checksum = await sha256(targetPath);
    const expectedRecord = expected?.get(relativePath);
    if (expectedRecord && (checksum !== expectedRecord.sha256 || details.size !== expectedRecord.bytes)) {
      throw new LocalDataBackupError('backup integrity verification failed.');
    }
    records.push({ path: relativePath, bytes: details.size, sha256: checksum });
  }
  return records;
}

function samePaths(left, right) {
  return left.length === right.length && left.every((path, index) => path === right[index]);
}

async function publishDirectory({ stagingDirectory, targetDirectory, manifest = null, label }) {
  const releaseDestination = await claimDestination(targetDirectory, label);
  try {
    if (manifest) {
      await writeFile(join(stagingDirectory, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
    }
    await rename(stagingDirectory, targetDirectory);
  } finally {
    await releaseDestination();
  }
}

function validateManifest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.formatVersion !== 1 || !Array.isArray(value.files)) {
    throw new LocalDataBackupError('backup manifest is invalid.');
  }
  const paths = new Set();
  const records = new Map();
  for (const entry of value.files) {
    if (!entry || typeof entry !== 'object' || !safeRelativePath(entry.path) || paths.has(entry.path) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
      throw new LocalDataBackupError('backup manifest contains an invalid file record.');
    }
    paths.add(entry.path);
    records.set(entry.path, { bytes: entry.bytes, sha256: entry.sha256 });
  }
  return records;
}

export async function backupLocalData({ dataDirectory, backupDirectory, createdAt = () => new Date().toISOString() }) {
  const source = text(dataDirectory, 'dataDirectory');
  const target = text(backupDirectory, 'backupDirectory');
  await requireDirectory(source, 'dataDirectory');
  if (isNestedPath(source, target)) throw new LocalDataBackupError('backupDirectory must not be inside dataDirectory.');

  const staging = await stageDirectory(target);
  try {
    await mkdir(staging);
    const files = await listRegularFiles(source);
    if (files.includes(MANIFEST_FILE)) throw new LocalDataBackupError(`dataDirectory cannot contain the reserved ${MANIFEST_FILE} file.`);
    const records = await copyVerifiedFiles({ sourceDirectory: source, targetDirectory: staging, files });
    await publishDirectory({
      stagingDirectory: staging,
      targetDirectory: target,
      manifest: { formatVersion: 1, createdAt: createdAt(), files: records },
      label: 'backupDirectory'
    });
    return { backupDirectory: target, fileCount: records.length, totalBytes: records.reduce((sum, record) => sum + record.bytes, 0) };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

export async function restoreLocalData({ backupDirectory, dataDirectory }) {
  const source = text(backupDirectory, 'backupDirectory');
  const target = text(dataDirectory, 'dataDirectory');
  await requireDirectory(source, 'backupDirectory');
  if (isNestedPath(source, target)) throw new LocalDataBackupError('dataDirectory must not be inside backupDirectory.');

  let records;
  try {
    records = validateManifest(JSON.parse(await readFile(join(source, MANIFEST_FILE), 'utf8')));
  } catch (error) {
    if (error instanceof LocalDataBackupError) throw error;
    throw new LocalDataBackupError('backup manifest is invalid.');
  }
  const files = [...records.keys()].sort();
  const physicalFiles = (await listRegularFiles(source)).filter((path) => path !== MANIFEST_FILE).sort();
  if (!samePaths(files, physicalFiles)) throw new LocalDataBackupError('backup manifest does not describe every backup file.');
  const staging = await stageDirectory(target);
  try {
    await mkdir(staging);
    await copyVerifiedFiles({ sourceDirectory: source, targetDirectory: staging, files, expected: records });
    await publishDirectory({ stagingDirectory: staging, targetDirectory: target, label: 'dataDirectory' });
    return { dataDirectory: target, fileCount: files.length, totalBytes: [...records.values()].reduce((sum, record) => sum + record.bytes, 0) };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}
