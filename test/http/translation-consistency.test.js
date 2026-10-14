import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, test } from 'node:test';
import { TranslationProviderError } from '../../src/domain/errors.js';
import { startTestApp } from '../support/http.js';

let app;
const chapterUrl = 'https://www.kujiang.com/book/9/906595';
const fixturePath = new URL('../fixtures/kujiang/chapter.html', import.meta.url);

async function fixtureFetch() {
  return new Response(await readFile(fixturePath, 'utf8'), {
    headers: { 'content-type': 'text/html' }
  });
}

beforeEach(async () => {
  app = await startTestApp({ fetch: fixtureFetch });
});

afterEach(async () => {
  await app.close();
});

async function requestJson(method, path, body) {
  const response = await app.request(path, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

async function sourceChapter() {
  const novel = await requestJson('POST', '/api/v1/novels', { title: 'Ink Trail' });
  const imported = await requestJson('POST', `/api/v1/novels/${novel.body.id}/source-chapters`, {
    sourceUrl: chapterUrl,
    chapterNumber: 7
  });
  return { novel, chapter: imported.body.chapter };
}

test('translation, feedback, and verified memory routes expose stable contracts', async () => {
  const { novel, chapter } = await sourceChapter();
  const translation = await requestJson('POST', `/api/v1/novels/${novel.body.id}/chapters/7/translations`);

  assert.equal(translation.status, 201);
  assert.deepEqual(Object.keys(translation.body).sort(), ['findings', 'revision']);
  assert.equal(translation.body.revision.chapterId, chapter.id);
  assert.equal(translation.body.revision.provider, 'fixture');
  assert.deepEqual(translation.body.findings, []);

  const feedback = await requestJson('POST', `/api/v1/novels/${novel.body.id}/chapters/7/feedback`, {
    translationRevisionId: translation.body.revision.id,
    selectedText: 'Fixture translation 1.',
    sourceContext: 'Source context',
    translatedContext: 'Fixture translation 1.',
    proposedCorrection: 'Corrected translation.',
    reason: 'Verified terminology'
  });
  assert.equal(feedback.status, 201);
  assert.equal(feedback.body.status, 'pending');

  const reports = await requestJson('GET', `/api/v1/novels/${novel.body.id}/chapters/7/feedback`);
  assert.deepEqual(reports, { status: 200, body: { items: [feedback.body] } });

  const decision = await requestJson('PATCH', `/api/v1/novels/${novel.body.id}/feedback/${feedback.body.id}`, {
    status: 'approved',
    memory: {
      sourceTerm: 'senior brother',
      preferredRendering: 'senior brother',
      semanticScope: 'ranks',
      evidence: 'Verified terminology',
      confidence: 1
    }
  });
  assert.equal(decision.status, 200);
  assert.equal(decision.body.report.status, 'approved');
  assert.equal(decision.body.revision.revision, 2);
  assert.equal(decision.body.memory.novelId, novel.body.id);

  const memory = await requestJson('GET', `/api/v1/novels/${novel.body.id}/verified-memory`);
  assert.deepEqual(memory, { status: 200, body: { items: [decision.body.memory] } });
});

test('translation routes map missing sourced chapters and provider failures without provider leaks', async () => {
  const novel = await requestJson('POST', '/api/v1/novels', { title: 'Ink Trail' });
  const missing = await requestJson('POST', `/api/v1/novels/${novel.body.id}/chapters/7/translations`);
  assert.deepEqual(missing, {
    status: 404,
    body: { error: { code: 'not_found', message: 'sourced chapter not found', retryable: false, resourceId: '7' } }
  });

  await app.close();
  app = await startTestApp({
    fetch: fixtureFetch,
    translationProvider: {
      provider: 'fixture',
      model: 'fixture-model',
      async translate() {
        throw new TranslationProviderError('prompt: secret source; raw provider body');
      }
    }
  });
  const { novel: sourcedNovel } = await sourceChapter();
  const failure = await requestJson('POST', `/api/v1/novels/${sourcedNovel.body.id}/chapters/7/translations`);
  assert.deepEqual(failure, {
    status: 502,
    body: { error: { code: 'translation_provider_failed', message: 'Translation provider could not complete the request', retryable: true } }
  });
});

test('feedback routes preserve validation, not-found, and conflict envelopes', async () => {
  const { novel, chapter } = await sourceChapter();
  const missing = await requestJson('GET', `/api/v1/novels/${novel.body.id}/chapters/8/feedback`);
  const missingNovel = await requestJson('PATCH', '/api/v1/novels/missing/feedback/report', { status: 'rejected' });
  const invalid = await requestJson('POST', `/api/v1/novels/${novel.body.id}/chapters/7/feedback`, []);
  const translation = await requestJson('POST', `/api/v1/novels/${novel.body.id}/chapters/7/translations`);
  const feedback = await requestJson('POST', `/api/v1/novels/${novel.body.id}/chapters/7/feedback`, {
    translationRevisionId: translation.body.revision.id,
    selectedText: 'Fixture translation 1.',
    sourceContext: 'Source context',
    translatedContext: 'Fixture translation 1.',
    proposedCorrection: 'Corrected translation.',
    reason: 'Verified terminology'
  });
  const missingMemory = await requestJson('PATCH', `/api/v1/novels/${novel.body.id}/feedback/${feedback.body.id}`, { status: 'approved' });
  const approved = await requestJson('PATCH', `/api/v1/novels/${novel.body.id}/feedback/${feedback.body.id}`, {
    status: 'approved',
    memory: { sourceTerm: 'term', preferredRendering: 'term', semanticScope: 'scope', evidence: 'evidence', confidence: 1 }
  });
  const conflict = await requestJson('PATCH', `/api/v1/novels/${novel.body.id}/feedback/${feedback.body.id}`, { status: 'rejected' });

  assert.equal(chapter.chapterNumber, 7);
  assert.deepEqual(missing, {
    status: 404,
    body: { error: { code: 'not_found', message: 'chapter not found', retryable: false, resourceId: '8' } }
  });
  assert.deepEqual(missingNovel, {
    status: 404,
    body: { error: { code: 'not_found', message: 'novel not found', retryable: false, resourceId: 'missing' } }
  });
  assert.deepEqual(invalid, {
    status: 400,
    body: { error: { code: 'validation_error', message: 'input must be an object', retryable: false } }
  });
  assert.deepEqual(missingMemory, {
    status: 400,
    body: { error: { code: 'validation_error', message: 'sourceTerm is required', retryable: false } }
  });
  assert.equal(approved.status, 200);
  assert.deepEqual(conflict, {
    status: 409,
    body: { error: { code: 'conflict', message: 'feedback status transition is not allowed', retryable: false } }
  });
});
