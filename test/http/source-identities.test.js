import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { startTestApp } from '../support/http.js';

let app;

async function requestJson(method, path, body) {
  const response = await app.request(path, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

function identity(bookId) {
  return {
    bookUrl: `https://www.kujiang.com/book/${bookId}`,
    novelTitle: '战神狂飙',
    novelTitleAliases: ['return of the war god'],
    author: '天蚕土豆',
    authorAliases: ['tian can tu dou'],
    chapterTitleAliases: { '101': ['lamp fire'] }
  };
}

beforeEach(async () => { app = await startTestApp(); });
afterEach(async () => { await app.close(); });

test('source identity resources are strict, novel-scoped, and removable', async () => {
  const novel = await requestJson('POST', '/api/v1/novels', { title: 'Resolver Trail' });
  const other = await requestJson('POST', '/api/v1/novels', { title: 'Other Trail' });
  const created = await requestJson('POST', `/api/v1/novels/${novel.body.id}/source-identities`, identity(9));
  const listed = await requestJson('GET', `/api/v1/novels/${novel.body.id}/source-identities`);
  const extra = await requestJson('POST', `/api/v1/novels/${novel.body.id}/source-identities`, { ...identity(10), extra: true });
  const foreign = await requestJson('POST', `/api/v1/novels/${other.body.id}/source-identities`, identity(9));
  const removed = await app.request(`/api/v1/novels/${novel.body.id}/source-identities/${created.body.id}`, { method: 'DELETE' });
  const missing = await app.request(`/api/v1/novels/${novel.body.id}/source-identities/${created.body.id}`, { method: 'DELETE' });

  assert.equal(created.status, 201);
  assert.equal(created.body.canonicalBookUrl, 'https://www.kujiang.com/book/9');
  assert.deepEqual(listed.body.items.map(({ id, canonicalBookUrl }) => ({ id, canonicalBookUrl })), [{ id: created.body.id, canonicalBookUrl: created.body.canonicalBookUrl }]);
  assert.deepEqual(extra, {
    status: 400,
    body: { error: { code: 'validation_error', message: 'input must contain bookUrl and novelTitle with no unsupported fields', retryable: false } }
  });
  assert.deepEqual(foreign, {
    status: 409,
    body: { error: { code: 'conflict', message: 'source identity already belongs to another novel', retryable: false } }
  });
  assert.equal(removed.status, 204);
  assert.deepEqual({ status: missing.status, body: await missing.json() }, {
    status: 404,
    body: { error: { code: 'not_found', message: 'source identity not found', retryable: false, resourceId: created.body.id } }
  });
});
