import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { ConflictError, NotFoundError, ValidationError } from '../domain/errors.js';

const generatedName = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.epub$/;
const temporaryName = /^\.[a-f0-9-]{36}\.epub\.[a-f0-9-]{36}\.tmp$/;

function requireRootPath(rootPath) {
  if (typeof rootPath !== 'string' || rootPath.trim().length === 0) {
    throw new ValidationError('exportRoot is required');
  }
  return resolve(rootPath);
}

function requireGeneratedFileName(fileName) {
  if (typeof fileName !== 'string' || !generatedName.test(fileName)) {
    throw new ValidationError('fileName must be a generated EPUB name');
  }
  return fileName;
}

async function digestFile(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

export function createExportRoot({ exportRoot }) {
  const root = requireRootPath(exportRoot);

  function outputPath(fileName) {
    const safeFileName = requireGeneratedFileName(fileName);
    const output = resolve(root, safeFileName);
    if (dirname(output) !== root || basename(output) !== safeFileName) {
      throw new ValidationError('EPUB output must stay inside exportRoot');
    }
    return output;
  }

  function temporaryPath(fileName) {
    const output = outputPath(fileName);
    return join(root, `.${basename(output)}.${randomUUID()}.tmp`);
  }

  function assertTemporaryPath(filePath) {
    const resolved = resolve(filePath);
    if (dirname(resolved) !== root || !temporaryName.test(basename(resolved))) {
      throw new ValidationError('EPUB temporary file must stay inside exportRoot');
    }
    return resolved;
  }

  async function removeTemporary(filePath) {
    await rm(assertTemporaryPath(filePath), { force: true });
  }

  async function recoverTemporaryFiles() {
    await mkdir(root, { recursive: true });
    const entries = await readdir(root, { withFileTypes: true });
    await Promise.all(entries
      .filter((entry) => entry.isFile() && temporaryName.test(entry.name))
      .map((entry) => rm(join(root, entry.name), { force: true })));
  }

  async function publish({ fileName, temporaryFile }) {
    const temporary = assertTemporaryPath(temporaryFile);
    const output = outputPath(fileName);
    try {
      await lstat(output);
      throw new ConflictError('EPUB output already exists');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const file = await stat(temporary);
    if (!file.isFile()) throw new ValidationError('EPUB temporary output is not a file');
    const sha256 = await digestFile(temporary);
    await rename(temporary, output);
    return { path: output, byteSize: file.size, sha256 };
  }

  async function removeOutput(fileName) {
    await rm(outputPath(fileName), { force: true });
  }

  async function openAvailable({ fileName, byteSize, sha256 }) {
    const output = outputPath(fileName);
    let file;
    try {
      file = await lstat(output);
    } catch (error) {
      if (error.code === 'ENOENT') throw new NotFoundError('EPUB export file is unavailable');
      throw error;
    }
    if (!file.isFile() || file.size !== byteSize || await digestFile(output) !== sha256) {
      throw new ConflictError('EPUB export file failed verification');
    }
    return { path: output, byteSize: file.size, stream: createReadStream(output) };
  }

  return {
    root,
    outputPath,
    temporaryPath,
    recoverTemporaryFiles,
    removeTemporary,
    publish,
    removeOutput,
    openAvailable
  };
}
