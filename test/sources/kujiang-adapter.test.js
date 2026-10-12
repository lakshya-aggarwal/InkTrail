import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createAdapterRegistry } from '../../src/sources/adapter-registry.js';
import {
  canonicalizeKujiangUrl,
  createKujiangAdapter,
  parseKujiangChapterHtml
} from '../../src/sources/kujiang-adapter.js';
import { SourceFetchError } from '../../src/sources/source-errors.js';

const chapterUrl = 'https://www.kujiang.com/book/9/906595';
const fixturePath = new URL('../fixtures/kujiang/chapter.html', import.meta.url);

async function chapterHtml() {
  return readFile(fixturePath, 'utf8');
}

function htmlResponse(html, init = {}) {
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' }, ...init });
}

test('canonicalizes only exact Kujiang chapter URLs', () => {
  assert.equal(canonicalizeKujiangUrl(`${chapterUrl}?from=reader#chapter`), chapterUrl);
  for (const url of [
    'http://www.kujiang.com/book/9/906595',
    'https://kujiang.com/book/9/906595',
    'https://www.kujiang.com:443/book/9/906595',
    'https://www.kujiang.com/book/9/906595/',
    'https://www.kujiang.com/book/9/906595/extra',
    'https://www.kujiang.com/book/a/906595',
    'https://example.com/book/9/906595'
  ]) {
    assert.equal(canonicalizeKujiangUrl(url), null);
  }
});

test('parses bounded Chinese chapter content and source metadata from a static fixture', async () => {
  assert.deepEqual(parseKujiangChapterHtml(await chapterHtml(), chapterUrl), {
    site: 'kujiang',
    externalNovelId: '9',
    externalChapterId: '906595',
    sourceUrl: chapterUrl,
    normalizedUrl: chapterUrl,
    title: '第2491章 归途 & 灯火',
    paragraphs: [
      '夜色落在城墙上，远处的灯火仍未熄灭。',
      '他抬起头',
      '看见了归来的路。'
    ],
    previousSourceUrl: 'https://www.kujiang.com/book/9/906594',
    nextSourceUrl: 'https://www.kujiang.com/book/9/906596'
  });
});

test('rejects malformed content that has no Chinese story paragraph', () => {
  assert.throws(
    () => parseKujiangChapterHtml('<h1 data-chapter-title>Chapter</h1><article data-chapter-content><p>Read next</p></article>', chapterUrl),
    /Chinese story paragraphs/
  );
});

test('rejects an empty chapter title', () => {
  assert.throws(
    () => parseKujiangChapterHtml('<h1 data-chapter-title> </h1><article data-chapter-content><p>这是正文。</p></article>', chapterUrl),
    /chapter title/
  );
});

test('uses an injected fetch client and requests only canonical HTML', async () => {
  const calls = [];
  const adapter = createKujiangAdapter({
    fetch: async (url, options) => {
      calls.push({ url, options });
      return htmlResponse(await chapterHtml());
    }
  });

  const chapter = await adapter.fetchChapter(`${chapterUrl}?tracking=1`);
  assert.equal(chapter.title, '第2491章 归途 & 灯火');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, chapterUrl);
  assert.equal(calls[0].options.headers.accept, 'text/html');
  assert.equal(calls[0].options.redirect, 'manual');
});

test('revalidates redirects before requesting their target', async () => {
  const calls = [];
  const adapter = createKujiangAdapter({
    fetch: async (url) => {
      calls.push(url);
      if (calls.length === 1) {
        return htmlResponse('', { status: 302, headers: { location: 'https://example.com/book/9/906596' } });
      }
      return htmlResponse(await chapterHtml());
    }
  });

  await assert.rejects(() => adapter.fetchChapter(chapterUrl), SourceFetchError);
  assert.deepEqual(calls, [chapterUrl]);
});

test('maps timeout, non-OK, oversized, and malformed source responses to retryable errors', async () => {
  const timeoutAdapter = createKujiangAdapter({
    fetch: async (_url, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))),
    timeoutMs: 1
  });
  const cases = [
    () => timeoutAdapter.fetchChapter(chapterUrl),
    () => createKujiangAdapter({ fetch: async () => htmlResponse('', { status: 503 }) }).fetchChapter(chapterUrl),
    () => createKujiangAdapter({ fetch: async () => htmlResponse('x'.repeat(20)), maxBodyBytes: 10 }).fetchChapter(chapterUrl),
    () => createKujiangAdapter({ fetch: async () => htmlResponse('<article data-chapter-content><p>English only</p></article>') }).fetchChapter(chapterUrl)
  ];

  for (const request of cases) {
    await assert.rejects(request, (error) => error instanceof SourceFetchError && error.retryable === true);
  }
});

test('returns the supported adapter only for Kujiang chapter URLs', () => {
  const kujiang = createKujiangAdapter({ fetch: async () => htmlResponse('') });
  const registry = createAdapterRegistry([kujiang]);

  assert.equal(registry.getAdapter(chapterUrl), kujiang);
  assert.equal(registry.getAdapter('https://example.com/book/9/906595'), null);
});
