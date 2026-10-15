import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, test } from 'node:test';
import { startTestApp } from '../support/http.js';

const chapterUrl = 'https://www.kujiang.com/book/9/906595';
const fixturePath = new URL('../fixtures/kujiang/chapter.html', import.meta.url);
let app;

async function fixtureFetch() {
  return new Response(await readFile(fixturePath, 'utf8'), {
    headers: { 'content-type': 'text/html' }
  });
}

async function requestJson(method, path, body, headers = {}) {
  const response = await app.request(path, {
    method,
    headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

async function createSourcedNovel(title = 'Ink Trail') {
  const novel = await requestJson('POST', '/api/v1/novels', { title });
  await requestJson('POST', `/api/v1/novels/${novel.body.id}/source-chapters`, { sourceUrl: chapterUrl, chapterNumber: 1 });
  return novel.body;
}

async function waitForExport(novelId, exportId) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const result = await requestJson('GET', `/api/v1/novels/${novelId}/exports/${exportId}`);
    if (result.body.export.state === 'available') return result.body;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('export did not become available');
}

async function waitForExportState(novelId, exportId, state) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const result = await requestJson('GET', `/api/v1/novels/${novelId}/exports/${exportId}`);
    if (result.body.export.state === state) return result.body;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`export did not become ${state}`);
}

beforeEach(async () => {
  app = await startTestApp({ fetch: fixtureFetch });
});

afterEach(async () => {
  await app.close();
});

test('durable job HTTP resources preserve idempotency, state controls, and novel ownership', async () => {
  const novel = await createSourcedNovel();
  const other = await requestJson('POST', '/api/v1/novels', { title: 'Other Trail' });
  const body = { novelId: novel.id, type: 'translate_chapters', target: { chapterNumbers: [1] } };
  const first = await requestJson('POST', '/api/v1/jobs', body, { 'Idempotency-Key': 'chapter-one' });
  const replay = await requestJson('POST', '/api/v1/jobs', body, { 'Idempotency-Key': 'chapter-one' });
  const mismatch = await requestJson('POST', '/api/v1/jobs', { ...body, target: { chapterNumbers: [2] } }, { 'Idempotency-Key': 'chapter-one' });

  assert.equal(first.status, 201);
  assert.equal(first.body.attemptCount >= 0, true);
  assert.equal('claimToken' in first.body, false);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.id, first.body.id);
  assert.equal(mismatch.status, 409);

  const listed = await requestJson('GET', `/api/v1/jobs?novelId=${novel.id}`);
  assert.equal(listed.status, 200);
  assert.equal(listed.body.items[0].id, first.body.id);
  const detail = await requestJson('GET', `/api/v1/jobs/${first.body.id}?novelId=${novel.id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.job.id, first.body.id);
  assert.equal(Number.isSafeInteger(detail.body.job.attemptCount), true);
  assert.equal(Array.isArray(detail.body.attempts), true);
  const foreign = await requestJson('GET', `/api/v1/jobs/${first.body.id}?novelId=${other.body.id}`);
  assert.deepEqual(foreign, {
    status: 404,
    body: { error: { code: 'not_found', message: 'job not found', retryable: false, resourceId: first.body.id } }
  });
});

test('paused queued jobs resume through durable controls', async () => {
  await app.close();
  let releaseFirstTranslation;
  const firstTranslation = new Promise((resolve) => {
    releaseFirstTranslation = resolve;
  });
  let calls = 0;
  app = await startTestApp({
    fetch: fixtureFetch,
    translationProvider: {
      provider: 'fixture',
      model: 'fixture-model',
      async translate() {
        calls += 1;
        if (calls === 1) await firstTranslation;
        return { paragraphs: ['Translated chapter.'] };
      }
    }
  });
  const novel = await createSourcedNovel('Paused Trail');
  const job = await requestJson('POST', '/api/v1/jobs', {
    novelId: novel.id,
    type: 'translate_chapters',
    target: { chapterNumbers: [1] }
  });
  const pause = await requestJson('POST', `/api/v1/jobs/${job.body.id}/pause?novelId=${novel.id}`);
  releaseFirstTranslation();
  const resume = await requestJson('POST', `/api/v1/jobs/${job.body.id}/resume?novelId=${novel.id}`);
  const detail = await requestJson('GET', `/api/v1/jobs/${job.body.id}?novelId=${novel.id}`);

  assert.equal(job.status, 201);
  assert.equal(pause.status, 200);
  assert.equal(pause.body.state, 'paused');
  assert.equal(resume.status, 200);
  assert.equal(['queued', 'running', 'completed'].includes(detail.body.job.state), true);
});

test('EPUB routes snapshot revisions, report unavailable work, and serve verified downloads', async () => {
  await app.close();
  let releaseArchive;
  const archiveGate = new Promise((resolve) => {
    releaseArchive = resolve;
  });
  app = await startTestApp({
    fetch: fixtureFetch,
    writeEpubArchive: async ({ temporaryFile }) => {
      await archiveGate;
      await writeFile(temporaryFile, 'fixture EPUB');
    }
  });
  const novel = await createSourcedNovel();
  const translation = await requestJson('POST', `/api/v1/novels/${novel.id}/chapters/1/translations`);
  assert.equal(translation.status, 201);

  const created = await requestJson('POST', `/api/v1/novels/${novel.id}/exports`, {
    selection: { chapterNumbers: [1] }
  }, { 'Idempotency-Key': 'export-one' });
  assert.equal(created.status, 201);
  assert.equal(created.body.export.jobId, null);
  await waitForExportState(novel.id, created.body.export.id, 'building');
  const unavailable = await requestJson('GET', `/api/v1/novels/${novel.id}/exports/${created.body.export.id}/download`);
  assert.deepEqual(unavailable, {
    status: 409,
    body: { error: { code: 'conflict', message: 'EPUB export is not available', retryable: false } }
  });

  const paused = await requestJson('POST', `/api/v1/jobs/${created.body.job.id}/pause?novelId=${novel.id}`);
  assert.equal(paused.status, 200);
  assert.equal(paused.body.state, 'paused');
  const reset = await requestJson('GET', `/api/v1/novels/${novel.id}/exports/${created.body.export.id}`);
  assert.equal(reset.body.export.state, 'queued');
  releaseArchive();
  const resumed = await requestJson('POST', `/api/v1/jobs/${created.body.job.id}/resume?novelId=${novel.id}`);
  assert.equal(resumed.status, 200);
  const available = await waitForExport(novel.id, created.body.export.id);
  assert.equal(available.chapters[0].translationRevisionId, translation.body.revision.id);
  const download = await app.request(`/api/v1/novels/${novel.id}/exports/${created.body.export.id}/download`);
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('content-type'), 'application/epub+zip');
  assert.equal(download.headers.get('content-disposition'), `attachment; filename="${created.body.export.id}.epub"`);
  assert.equal(await download.text(), 'fixture EPUB');

  const other = await requestJson('POST', '/api/v1/novels', { title: 'Foreign Export' });
  const foreign = await requestJson('GET', `/api/v1/novels/${other.body.id}/exports/${created.body.export.id}`);
  assert.deepEqual(foreign, {
    status: 404,
    body: { error: { code: 'not_found', message: 'EPUB export not found', retryable: false, resourceId: created.body.export.id } }
  });
});
