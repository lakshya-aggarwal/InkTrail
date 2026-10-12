import assert from 'node:assert/strict';
import test from 'node:test';
import { startTestApp } from '../support/http.js';

test('GET /api/v1/health returns an ok status', async () => {
  const app = await startTestApp();
  const response = await app.request('/api/v1/health');

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok' });
  await app.close();
});
