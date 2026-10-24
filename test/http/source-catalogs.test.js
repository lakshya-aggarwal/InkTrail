import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, test } from 'node:test';
import { startTestApp } from '../support/http.js';

const bookUrl = 'https://www.kujiang.com/book/9';
const catalogUrl = `${bookUrl}/catalog`;
const catalogFixturePath = new URL('../fixtures/kujiang/catalog.html', import.meta.url);
const chapterFixturePath = new URL('../fixtures/kujiang/chapter.html', import.meta.url);
let app;
let failCatalog = false;

async function fixtureFetch(url) {
  const value = String(url);
  if (value === catalogUrl) {
    if (failCatalog) throw new Error('upstream fixture detail');
    return new Response(await readFile(catalogFixturePath, 'utf8'), { headers: { 'content-type': 'text/html' } });
  }
  if (/^https:\/\/www\.kujiang\.com\/book\/9\/[1-9]\d*$/.test(value)) {
    return new Response(await readFile(chapterFixturePath, 'utf8'), { headers: { 'content-type': 'text/html' } });
  }
  throw new Error('fixture source URL is not configured');
}

async function requestJson(method, path, body, headers = {}) {
  const response = await app.request(path, {
    method,
    headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

async function waitForJob(novelId, jobId) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const detail = await requestJson('GET', `/api/v1/jobs/${jobId}?novelId=${novelId}`);
    if (detail.body.job.state === 'completed') return detail.body;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('source import job did not complete');
}

beforeEach(async () => {
  failCatalog = false;
  app = await startTestApp({ fetch: fixtureFetch });
});

afterEach(async () => {
  await app.close();
});

test('source catalog HTTP resources discover immutable metadata without importing chapters', async () => {
  const novel = await requestJson('POST', '/api/v1/novels', { title: 'Catalog Trail' });
  const created = await requestJson('POST', `/api/v1/novels/${novel.body.id}/source-catalogs`, { bookUrl });
  const replay = await requestJson('POST', `/api/v1/novels/${novel.body.id}/source-catalogs`, { bookUrl });
  const listed = await requestJson('GET', `/api/v1/novels/${novel.body.id}/source-catalogs`);
  const detail = await requestJson('GET', `/api/v1/novels/${novel.body.id}/source-catalogs/${created.body.id}`);
  const jobs = await requestJson('GET', `/api/v1/jobs?novelId=${novel.body.id}`);
  const chapter = await requestJson('GET', `/api/v1/novels/${novel.body.id}/chapters/1`);

  assert.equal(created.status, 201);
  assert.equal(created.body.canonicalBookUrl, bookUrl);
  assert.equal(created.body.entryCount, 3);
  assert.equal(created.body.importedEntryCount, 0);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.id, created.body.id);
  assert.deepEqual(listed.body.items.map((catalog) => catalog.id), [created.body.id]);
  assert.deepEqual(detail.body.entries.map((entry) => entry.ordinal), [1, 2, 3]);
  assert.equal('originalText' in detail.body.entries[0], false);
  assert.deepEqual(jobs.body.items, []);
  assert.equal(chapter.status, 404);
});

test('source catalog routes contain validation, fetch, and ownership failures', async () => {
  const novel = await requestJson('POST', '/api/v1/novels', { title: 'Catalog Errors' });
  const other = await requestJson('POST', '/api/v1/novels', { title: 'Other Catalog' });
  const invalid = await requestJson('POST', `/api/v1/novels/${novel.body.id}/source-catalogs`, { bookUrl: `${bookUrl}?tracking=1` });
  const extra = await requestJson('POST', `/api/v1/novels/${novel.body.id}/source-catalogs`, { bookUrl, other: true });
  const unsupported = await app.request(`/api/v1/novels/${novel.body.id}/source-catalogs`, { method: 'POST', body: '{}' });
  failCatalog = true;
  const failed = await requestJson('POST', `/api/v1/novels/${novel.body.id}/source-catalogs`, { bookUrl });
  failCatalog = false;
  const created = await requestJson('POST', `/api/v1/novels/${novel.body.id}/source-catalogs`, { bookUrl });
  const foreign = await requestJson('GET', `/api/v1/novels/${other.body.id}/source-catalogs/${created.body.id}`);

  assert.equal(invalid.status, 400);
  assert.equal(extra.status, 400);
  assert.equal(unsupported.status, 415);
  assert.deepEqual(failed, {
    status: 502,
    body: { error: { code: 'source_fetch_failed', message: 'Source chapter could not be fetched', retryable: true } }
  });
  assert.deepEqual(foreign, {
    status: 404,
    body: { error: { code: 'not_found', message: 'source catalog not found', retryable: false, resourceId: created.body.id } }
  });
});

test('source catalog discovery rejects a Kujiang book reserved by another novel identity', async () => {
  const firstNovel = await requestJson('POST', '/api/v1/novels', { title: 'Reserved source' });
  const secondNovel = await requestJson('POST', '/api/v1/novels', { title: 'Catalog target' });
  const identity = await requestJson('POST', `/api/v1/novels/${firstNovel.body.id}/source-identities`, {
    bookUrl,
    novelTitle: 'Reserved source'
  });
  const rejected = await requestJson('POST', `/api/v1/novels/${secondNovel.body.id}/source-catalogs`, { bookUrl });
  const catalogs = await requestJson('GET', `/api/v1/novels/${secondNovel.body.id}/source-catalogs`);

  assert.equal(identity.status, 201);
  assert.deepEqual(rejected, {
    status: 409,
    body: { error: { code: 'conflict', message: 'Kujiang source identity belongs to another novel', retryable: false } }
  });
  assert.deepEqual(catalogs.body.items, []);
});

test('source import jobs use catalog targets, preserve idempotency, and update catalog progress', async () => {
  const novel = await requestJson('POST', '/api/v1/novels', { title: 'Import Trail' });
  const catalog = await requestJson('POST', `/api/v1/novels/${novel.body.id}/source-catalogs`, { bookUrl });
  const input = { novelId: novel.body.id, type: 'source_import_catalog', target: { catalogId: catalog.body.id } };
  const created = await requestJson('POST', '/api/v1/jobs', input, { 'Idempotency-Key': 'catalog-import' });
  const replay = await requestJson('POST', '/api/v1/jobs', input, { 'Idempotency-Key': 'catalog-import' });
  const mismatch = await requestJson('POST', '/api/v1/jobs', {
    ...input,
    target: { catalogId: 'not-a-catalog' }
  }, { 'Idempotency-Key': 'catalog-import' });
  const detail = await waitForJob(novel.body.id, created.body.id);
  const listed = await requestJson('GET', `/api/v1/novels/${novel.body.id}/source-catalogs`);
  const chapter = await requestJson('GET', `/api/v1/novels/${novel.body.id}/chapters/1`);

  assert.equal(created.status, 201);
  assert.equal(created.body.type, 'source_import_catalog');
  assert.deepEqual(created.body.target, { catalogId: catalog.body.id });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.id, created.body.id);
  assert.equal(mismatch.status, 409);
  assert.equal(detail.attempts.every((attempt) => typeof attempt.catalogEntryId === 'string'), true);
  assert.equal(listed.body.items[0].importedEntryCount, 3);
  assert.equal(chapter.body.translationRevisionId, null);
});

test('source import jobs reject undocumented top-level fields before creating work', async () => {
  const novel = await requestJson('POST', '/api/v1/novels', { title: 'Strict Import Trail' });
  const catalog = await requestJson('POST', `/api/v1/novels/${novel.body.id}/source-catalogs`, { bookUrl });
  const rejected = await requestJson('POST', '/api/v1/jobs', {
    novelId: novel.body.id,
    type: 'source_import_catalog',
    target: { catalogId: catalog.body.id },
    unexpected: true
  });
  const jobs = await requestJson('GET', `/api/v1/jobs?novelId=${novel.body.id}`);

  assert.deepEqual(rejected, {
    status: 400,
    body: { error: { code: 'validation_error', message: 'input must contain only novelId, type, and target', retryable: false } }
  });
  assert.deepEqual(jobs.body.items, []);
});
