import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { promisify } from 'node:util';

const run = promisify(execFile);
const redoclyCliPath = fileURLToPath(new URL('../../node_modules/@redocly/cli/bin/cli.js', import.meta.url));
const openapiPath = fileURLToPath(new URL('../../openapi/inktrail.v1.yaml', import.meta.url));

test('Idempotency-Key schema accepts ordinary keys and rejects whitespace-only values', async () => {
  const { stdout } = await run(process.execPath, [redoclyCliPath, 'bundle', openapiPath, '--ext', 'json']);
  const document = JSON.parse(stdout);
  const pattern = document.components.parameters.IdempotencyKey.schema.pattern;
  const matcher = new RegExp(pattern);

  assert.equal(matcher.test('resolution-1'), true);
  assert.equal(matcher.test(' \t '), false);
});
