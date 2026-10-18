import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, test } from 'node:test';
import { SourceFetchError, ValidationError } from '../../src/domain/errors.js';
import { startTestApp } from '../support/http.js';

const bookUrl = 'https://www.kujiang.com/book/9';
const catalogUrl = `${bookUrl}/catalog`;
const chapterUrl = 'https://novelping.com/book/return-of-the-war-god/chapter-2-lamp-fire';
const unresolvedUrl = 'https://novelping.com/book/unknown/chapter-2-lamp-fire';
const failedUrl = 'https://novelping.com/book/return-of-the-war-god/chapter-2-failed';
const catalogFixturePath = new URL('../fixtures/kujiang/catalog.html', import.meta.url);
let app;
let failCatalog;

function evidenceFor(novelPingUrl, novelTitle = 'return of the war god') {
  return {
    canonicalNovelPingUrl: novelPingUrl,
    novelTitle,
    author: null,
    chapterNumber: 2,
    chapterTitle: 'lamp fire',
    extractorVersion: 'novelping-kujiang-v1',
    evidenceHash: createHash('sha256').update(novelPingUrl).digest('hex')
  };
}

const novelPingExtractor = {
  async fetchEvidence(novelPingUrl) {
    if (novelPingUrl === failedUrl) throw new SourceFetchError('fixture upstream failure');
    if (novelPingUrl === chapterUrl) return evidenceFor(novelPingUrl);
    if (novelPingUrl === unresolvedUrl) return evidenceFor(novelPingUrl, 'unknown novel');
    throw new ValidationError('unsupported NovelPing chapter URL');
  }
};

async function fixtureFetch(url) {
  if (String(url) === catalogUrl) {
    if (failCatalog) throw new Error('upstream catalog detail');
    return new Response(await readFile(catalogFixturePath, 'utf8'), { headers: { 'content-type': 'text/html' } });
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

beforeEach(async () => {
  failCatalog = false;
  app = await startTestApp({
    fetch: fixtureFetch,
    novelPingExtractor,
    resolverCandidateIdentities: [{
      bookUrl,
      novelTitle: '战神狂飙',
      novelTitleAliases: ['return of the war god'],
      chapterTitleAliases: { '101': ['lamp fire'] }
    }]
  });
});

afterEach(async () => {
  await app.close();
});

test('source resolution resources persist a safe accepted result, replay it, and explicitly create the existing import job', async () => {
  const novel = await requestJson('POST', '/api/v1/novels', { title: 'Resolver Trail' });
  const created = await requestJson('POST', `/api/v1/novels/${novel.body.id}/source-resolutions`, { novelPingUrl: chapterUrl }, { 'Idempotency-Key': 'resolution-1' });
  const replay = await requestJson('POST', `/api/v1/novels/${novel.body.id}/source-resolutions`, { novelPingUrl: chapterUrl }, { 'Idempotency-Key': 'resolution-1' });
  const listed = await requestJson('GET', `/api/v1/novels/${novel.body.id}/source-resolutions`);
  const detail = await requestJson('GET', `/api/v1/novels/${novel.body.id}/source-resolutions/${created.body.id}`);
  const jobsBeforeImport = await requestJson('GET', `/api/v1/jobs?novelId=${novel.body.id}`);
  const imported = await requestJson('POST', `/api/v1/novels/${novel.body.id}/source-resolutions/${created.body.id}/catalog-import`, undefined, { 'Idempotency-Key': 'resolution-import-1' });
  const importReplay = await requestJson('POST', `/api/v1/novels/${novel.body.id}/source-resolutions/${created.body.id}/catalog-import`, undefined, { 'Idempotency-Key': 'resolution-import-1' });

  assert.equal(created.status, 201);
  assert.equal(created.body.state, 'resolved');
  assert.equal(created.body.importEligible, true);
  assert.equal(created.body.evidence.chapterNumber, 2);
  assert.equal('originalText' in created.body, false);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.id, created.body.id);
  assert.deepEqual(listed.body.items.map((item) => item.id), [created.body.id]);
  assert.equal('evidence' in listed.body.items[0], false);
  assert.equal(detail.body.candidates[0].totalScore, 95);
  assert.equal(detail.body.candidates[0].metadata.novelTitle, '战神狂飙');
  assert.deepEqual(jobsBeforeImport.body.items, []);
  assert.equal(imported.status, 201);
  assert.equal(imported.body.type, 'source_import_catalog');
  assert.deepEqual(imported.body.target, { catalogId: created.body.acceptedSource.catalogId });
  assert.equal(importReplay.status, 200);
  assert.equal(importReplay.body.id, imported.body.id);
});

test('source resolution routes reject malformed, unresolved, failed, and foreign requests without exposing upstream text', async () => {
  const novel = await requestJson('POST', '/api/v1/novels', { title: 'Resolver Errors' });
  const other = await requestJson('POST', '/api/v1/novels', { title: 'Other Resolver' });
  const invalid = await requestJson('POST', `/api/v1/novels/${novel.body.id}/source-resolutions`, {});
  const extra = await requestJson('POST', `/api/v1/novels/${novel.body.id}/source-resolutions`, { novelPingUrl: chapterUrl, extra: true });
  const invalidKey = await requestJson('POST', `/api/v1/novels/${novel.body.id}/source-resolutions`, { novelPingUrl: chapterUrl }, { 'Idempotency-Key': ' ' });
  const unsupported = await app.request(`/api/v1/novels/${novel.body.id}/source-resolutions`, { method: 'POST', body: '{}' });
  const unresolved = await requestJson('POST', `/api/v1/novels/${novel.body.id}/source-resolutions`, { novelPingUrl: unresolvedUrl });
  const failed = await requestJson('POST', `/api/v1/novels/${novel.body.id}/source-resolutions`, { novelPingUrl: failedUrl });
  failCatalog = true;
  const catalogFailed = await requestJson('POST', `/api/v1/novels/${novel.body.id}/source-resolutions`, { novelPingUrl: chapterUrl });
  const foreign = await requestJson('GET', `/api/v1/novels/${other.body.id}/source-resolutions/${unresolved.body.id}`);
  const foreignImport = await requestJson('POST', `/api/v1/novels/${other.body.id}/source-resolutions/${unresolved.body.id}/catalog-import`);
  const unresolvedImport = await requestJson('POST', `/api/v1/novels/${novel.body.id}/source-resolutions/${unresolved.body.id}/catalog-import`);

  assert.deepEqual(invalid, {
    status: 400,
    body: { error: { code: 'validation_error', message: 'input must contain only novelPingUrl', retryable: false } }
  });
  assert.equal(extra.status, 400);
  assert.equal(invalidKey.status, 400);
  assert.equal(unsupported.status, 415);
  assert.equal(unresolved.status, 201);
  assert.equal(unresolved.body.state, 'unresolved');
  assert.equal(unresolved.body.importEligible, false);
  assert.deepEqual(failed, {
    status: 502,
    body: { error: { code: 'source_fetch_failed', message: 'Source chapter could not be fetched', retryable: true } }
  });
  assert.deepEqual(catalogFailed, {
    status: 502,
    body: { error: { code: 'source_fetch_failed', message: 'Source chapter could not be fetched', retryable: true } }
  });
  assert.deepEqual(foreign, {
    status: 404,
    body: { error: { code: 'not_found', message: 'source resolution attempt not found', retryable: false, resourceId: unresolved.body.id } }
  });
  assert.equal(foreignImport.status, 404);
  assert.equal(unresolvedImport.status, 409);
});
