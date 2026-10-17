import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { SourceFetchError, ValidationError } from '../../src/domain/errors.js';
import { canonicalizeNovelPingChapterUrl, createNovelPingExtractor, parseNovelPingEvidenceHtml } from '../../src/sources/novelping-extractor.js';

const chapterUrl = 'https://novelping.com/book/return-of-the-war-god/chapter-2491-shen-guanghai';
const fixturePath = new URL('../fixtures/novelping/chapter.html', import.meta.url);

async function chapterHtml() {
  return readFile(fixturePath, 'utf8');
}

function htmlResponse(html, init = {}) {
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' }, ...init });
}

test('canonicalizes only exact NovelPing chapter URLs', () => {
  assert.equal(canonicalizeNovelPingChapterUrl(chapterUrl), chapterUrl);
  for (const url of [
    `${chapterUrl}?tracking=1`, `${chapterUrl}#chapter`, `https://reader:secret@novelping.com/book/return-of-the-war-god/chapter-2491-shen-guanghai`,
    'http://novelping.com/book/return-of-the-war-god/chapter-2491-shen-guanghai', 'https://www.novelping.com/book/return-of-the-war-god/chapter-2491-shen-guanghai',
    'https://novelping.com:443/book/return-of-the-war-god/chapter-2491-shen-guanghai', 'https://novelping.com/book/return-of-the-war-god/chapter-0-shen-guanghai',
    'https://novelping.com/book/return-of-the-war-god/chapter-2491-shen-guanghai/'
  ]) assert.equal(canonicalizeNovelPingChapterUrl(url), null);
});

test('extracts only normalized metadata and a deterministic evidence hash from the fixture', async () => {
  const evidence = parseNovelPingEvidenceHtml(await chapterHtml(), chapterUrl);
  assert.deepEqual(evidence, {
    canonicalNovelPingUrl: chapterUrl,
    novelTitle: 'return of the war god',
    author: 'tian can tu dou',
    chapterNumber: 2491,
    chapterTitle: 'shen guanghai',
    extractorVersion: 'novelping-kujiang-v1',
    evidenceHash: '757920810c9527f38730e979eb7a1fd2d5226349c7367ed4c59e02ae45495f25'
  });
  assert.equal(JSON.stringify(evidence).includes('Translated prose'), false);
});

test('rejects missing, ambiguous, invalid, and URL-mismatched metadata', () => {
  for (const html of [
    '<span data-novel-title>Novel</span><h1 data-chapter-number="2491">Title</h1>',
    '<span data-novel-title>Novel</span><span data-novel-title>Novel Two</span><h1 data-chapter-number="2491" data-chapter-title>Title</h1>',
    '<span data-novel-title>Novel</span><h1 data-chapter-number="0" data-chapter-title>Title</h1>',
    '<span data-novel-title>Novel</span><h1 data-chapter-number="2490" data-chapter-title>Title</h1>'
  ]) assert.throws(() => parseNovelPingEvidenceHtml(html, chapterUrl), ValidationError);
});

test('uses only canonical HTML requests and preserves chapter identity across redirects', async () => {
  const calls = [];
  const extractor = createNovelPingExtractor({
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (calls.length === 1) return htmlResponse('', { status: 302, headers: { location: chapterUrl } });
      return htmlResponse(await chapterHtml());
    }
  });
  await extractor.fetchEvidence(chapterUrl);
  assert.deepEqual(calls.map(({ url }) => url), [chapterUrl, chapterUrl]);
  assert.equal(calls[0].options.headers.accept, 'text/html');
  assert.equal(calls[0].options.redirect, 'manual');

  const unsafe = createNovelPingExtractor({ fetch: async () => htmlResponse('', { status: 302, headers: { location: 'https://novelping.com/book/return-of-the-war-god/chapter-2492' } }) });
  await assert.rejects(() => unsafe.fetchEvidence(chapterUrl), SourceFetchError);
});

test('maps timeout, content type, body limits, and malformed HTML to safe retryable errors', async () => {
  const timeoutExtractor = createNovelPingExtractor({
    fetch: async (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))),
    timeoutMs: 1
  });
  const cases = [
    () => timeoutExtractor.fetchEvidence(chapterUrl),
    () => createNovelPingExtractor({ fetch: async () => htmlResponse('', { status: 503 }) }).fetchEvidence(chapterUrl),
    () => createNovelPingExtractor({ fetch: async () => new Response('not html', { headers: { 'content-type': 'text/plain' } }) }).fetchEvidence(chapterUrl),
    () => createNovelPingExtractor({ fetch: async () => htmlResponse('x'.repeat(20)), maxBodyBytes: 10 }).fetchEvidence(chapterUrl),
    () => createNovelPingExtractor({ fetch: async () => htmlResponse('<h1 data-chapter-number="2491" data-chapter-title>Title</h1>') }).fetchEvidence(chapterUrl)
  ];
  for (const request of cases) await assert.rejects(request, (error) => error instanceof SourceFetchError && error.retryable === true);
});
