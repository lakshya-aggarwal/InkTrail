import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { startTestApp } from '../support/http.js';

let app;

beforeEach(async () => {
  app = await startTestApp();
});

afterEach(async () => {
  await app.close();
});

async function requestJson(app, method, path, body) {
  const response = await app.request(path, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

test('POST /api/v1/novels creates a novel and GET lists it', async () => {
  const created = await requestJson(app, 'POST', '/api/v1/novels', {
    title: 'Return of the War God',
    sourceUrl: 'https://example.test/book/war-god'
  });
  assert.equal(created.status, 201);

  const listed = await requestJson(app, 'GET', '/api/v1/novels');
  assert.deepEqual(listed.body.items.map(({ id, title }) => ({ id, title })), [{
    id: created.body.id,
    title: 'Return of the War God'
  }]);
});

test('novel, chapter, and reading-progress routes preserve library state', async () => {
  const novel = await requestJson(app, 'POST', '/api/v1/novels', { title: 'Return of the War God' });
  const chapter = await requestJson(app, 'POST', `/api/v1/novels/${novel.body.id}/chapters`, {
    chapterNumber: 1,
    title: 'Arrival',
    originalText: 'Original Chinese'
  });
  const reader = await requestJson(app, 'GET', `/api/v1/novels/${novel.body.id}/chapters/1`);
  const progress = await requestJson(app, 'PATCH', `/api/v1/novels/${novel.body.id}/reading-progress`, { chapterNumber: 1 });
  const storedNovel = await requestJson(app, 'GET', `/api/v1/novels/${novel.body.id}`);

  assert.equal(chapter.status, 201);
  assert.equal(reader.status, 200);
  assert.equal(reader.body.originalText, 'Original Chinese');
  assert.deepEqual(progress, {
    status: 200,
    body: { readingProgress: { novelId: novel.body.id, chapterNumber: 1, updatedAt: progress.body.readingProgress.updatedAt } }
  });
  assert.deepEqual(storedNovel.body.readingProgress, progress.body.readingProgress);
});

test('a duplicate chapter request returns conflict without replacing the original', async () => {
  const novel = await requestJson(app, 'POST', '/api/v1/novels', { title: 'Return of the War God' });
  const first = await requestJson(app, 'POST', `/api/v1/novels/${novel.body.id}/chapters`, {
    chapterNumber: 1,
    title: 'Arrival',
    originalText: 'Original Chinese'
  });
  const duplicate = await requestJson(app, 'POST', `/api/v1/novels/${novel.body.id}/chapters`, {
    chapterNumber: 1,
    title: 'Replacement',
    originalText: 'Replacement text'
  });
  const stored = await requestJson(app, 'GET', `/api/v1/novels/${novel.body.id}/chapters/1`);

  assert.equal(first.status, 201);
  assert.equal(duplicate.status, 409);
  assert.deepEqual(duplicate.body, {
    error: {
      code: 'conflict',
      message: 'chapter number already exists for novel',
      retryable: false
    }
  });
  assert.equal(stored.body.originalText, 'Original Chinese');
});

test('write routes require valid JSON and domain errors have a stable shape', async () => {
  const nonJson = await app.request('/api/v1/novels', {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: 'not json'
  });
  const malformed = await app.request('/api/v1/novels', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{'
  });
  const invalid = await requestJson(app, 'POST', '/api/v1/novels', { title: ' ' });
  const missing = await requestJson(app, 'GET', '/api/v1/novels/missing');

  assert.deepEqual({ status: nonJson.status, body: await nonJson.json() }, {
    status: 415,
    body: { error: { code: 'unsupported_media_type', message: 'Expected application/json', retryable: false } }
  });
  assert.deepEqual({ status: malformed.status, body: await malformed.json() }, {
    status: 400,
    body: { error: { code: 'invalid_json', message: 'Malformed JSON body', retryable: false } }
  });
  assert.deepEqual(invalid, {
    status: 400,
    body: { error: { code: 'validation_error', message: 'title is required', retryable: false } }
  });
  assert.deepEqual(missing, {
    status: 404,
    body: { error: { code: 'not_found', message: 'novel not found', retryable: false, resourceId: 'missing' } }
  });
});
