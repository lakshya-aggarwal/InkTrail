import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const execute = promisify(execFile);
const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
const runtimeDirectory = join(projectRoot, 'desktop', 'src-tauri', 'resources', 'runtime');
const prepareScript = join(projectRoot, 'scripts', 'prepare-desktop-runtime.js');

test('stages the existing Node service as a generated desktop runtime', async () => {
  const { stdout } = await execute(process.execPath, [prepareScript]);
  const staged = JSON.parse(stdout);

  assert.equal(staged.runtimeDirectory, runtimeDirectory);
  assert.equal(JSON.parse(await readFile(join(runtimeDirectory, 'runtime.json'), 'utf8')).nodeVersion, process.version);
  await access(join(runtimeDirectory, 'src', 'server.js'));
  await access(join(runtimeDirectory, 'public', 'index.html'));
  assert.ok((await stat(join(runtimeDirectory, 'node'))).mode & 0o100);
});
