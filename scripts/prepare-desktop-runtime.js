import { chmod, cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtimeDirectory = join(projectRoot, 'desktop', 'src-tauri', 'resources', 'runtime');

await rm(runtimeDirectory, { recursive: true, force: true });
await mkdir(runtimeDirectory, { recursive: true });
await Promise.all([
  cp(join(projectRoot, 'src'), join(runtimeDirectory, 'src'), { recursive: true }),
  cp(join(projectRoot, 'public'), join(runtimeDirectory, 'public'), { recursive: true }),
  cp(join(projectRoot, 'node_modules'), join(runtimeDirectory, 'node_modules'), { recursive: true }),
  cp(join(projectRoot, 'package.json'), join(runtimeDirectory, 'package.json'), { recursive: true }),
  cp(process.execPath, join(runtimeDirectory, 'node'))
]);
await chmod(join(runtimeDirectory, 'node'), 0o755);
await writeFile(join(runtimeDirectory, 'runtime.json'), `${JSON.stringify({ nodeVersion: process.version }, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ runtimeDirectory, nodeVersion: process.version })}\n`);
