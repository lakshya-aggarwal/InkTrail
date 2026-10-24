import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

test('server entrypoint reports its bound loopback URL and closes gracefully on desktop shutdown', async (t) => {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'inktrail-desktop-server-'));
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, INKTRAIL_DATA_DIR: dataDirectory, PORT: '0' },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGKILL');
    await rm(dataDirectory, { recursive: true, force: true });
  });

  const [line] = await once(child.stdout, 'data');
  const match = line.toString().match(/^INKTRAIL_READY (http:\/\/127\.0\.0\.1:\d+)\n$/);
  assert.ok(match, `unexpected ready output: ${line}`);
  const response = await fetch(`${match[1]}/api/v1/health`);
  assert.deepEqual(await response.json(), { status: 'ok' });

  child.stdin.write('INKTRAIL_SHUTDOWN\n');
  const [exitCode, signal] = await once(child, 'exit');
  assert.equal(exitCode, 0);
  assert.equal(signal, null);
});
