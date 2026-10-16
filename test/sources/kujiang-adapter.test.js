import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createAdapterRegistry } from '../../src/sources/adapter-registry.js';
import {
  canonicalizeKujiangBookUrl,
  canonicalizeKujiangUrl,
  createKujiangAdapter,
  parseKujiangCatalogHtml,
  parseKujiangChapterHtml
} from '../../src/sources/kujiang-adapter.js';
import { SourceFetchError, ValidationError } from '../../src/domain/errors.js';

const chapterUrl = 'https://www.kujiang.com/book/9/906595';
const bookUrl = 'https://www.kujiang.com/book/9';
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

test('canonicalizes only exact Kujiang book URLs without query or fragment variants', () => {
  assert.equal(canonicalizeKujiangBookUrl(bookUrl), bookUrl);
  for (const url of [
    `${bookUrl}/catalog`,
    `${bookUrl}?tracking=1`,
    `${bookUrl}#catalog`,
    'http://www.kujiang.com/book/9',
    'https://www.kujiang.com:443/book/9',
    'https://www.kujiang.com/book/9/',
    'https://www.kujiang.com/book/a',
    'https://example.com/book/9'
  ]) {
    assert.equal(canonicalizeKujiangBookUrl(url), null);
  }
});

test('parses only named catalog containers into ordered canonical chapters', async () => {
  const html = await readFile(new URL('../fixtures/kujiang/catalog.html', import.meta.url), 'utf8');

  assert.deepEqual(parseKujiangCatalogHtml(html, bookUrl).entries, [
    { ordinal: 1, externalChapterId: '100', sourceUrl: 'https://www.kujiang.com/book/9/100', normalizedUrl: 'https://www.kujiang.com/book/9/100', sourceTitle: '第一章 起程' },
    { ordinal: 2, externalChapterId: '101', sourceUrl: 'https://www.kujiang.com/book/9/101', normalizedUrl: 'https://www.kujiang.com/book/9/101', sourceTitle: '第二章 灯火' },
    { ordinal: 3, externalChapterId: '102', sourceUrl: 'https://www.kujiang.com/book/9/102', normalizedUrl: 'https://www.kujiang.com/book/9/102', sourceTitle: '第三章归途' }
  ]);
});

test('rejects missing, duplicate, paginated, unordered, and over-limit catalogs', async () => {
  const missing = await readFile(new URL('../fixtures/kujiang/catalog-missing.html', import.meta.url), 'utf8');
  const malformed = await readFile(new URL('../fixtures/kujiang/catalog-malformed.html', import.meta.url), 'utf8');
  const duplicate = await readFile(new URL('../fixtures/kujiang/catalog-duplicate.html', import.meta.url), 'utf8');
  const overflow = await readFile(new URL('../fixtures/kujiang/catalog-overflow.html', import.meta.url), 'utf8');
  const paginated = '<section data-book-catalog><a href="/book/9/100">第一章</a><a data-catalog-pagination href="?page=2">下一页</a></section>';
  const unordered = '<section data-book-catalog><a href="/book/9/101">第二章</a><a href="/book/9/100">第一章</a></section>';

  for (const html of [missing, malformed, duplicate, paginated, unordered]) {
    assert.throws(() => parseKujiangCatalogHtml(html, bookUrl), ValidationError);
  }
  assert.throws(() => parseKujiangCatalogHtml(overflow, bookUrl, 2), /entry limit/);
});

test('ignores nested-template decoys and preserves rendered narrative Chinese from a static fixture', async () => {
  assert.deepEqual(parseKujiangChapterHtml(await chapterHtml(), chapterUrl), {
    site: 'kujiang',
    externalNovelId: '9',
    externalChapterId: '906595',
    novelSourceUrl: 'https://www.kujiang.com/book/9',
    sourceUrl: chapterUrl,
    normalizedUrl: chapterUrl,
    title: '第2491章 归途 & 灯火',
    paragraphs: [
      '夜色落在城墙上，远处的灯火仍未熄灭。',
      '他抬起头',
      '看见了归来的路。',
      '她说上一章的旧书里夹着一张加入书架的便签。'
    ],
    previousSourceUrl: 'https://www.kujiang.com/book/9/906594',
    nextSourceUrl: 'https://www.kujiang.com/book/9/906596'
  });
});

test('excludes a marked wrapper and falls back to rendered div and br story text', async () => {
  const html = await readFile(new URL('../fixtures/kujiang/div-fallback.html', import.meta.url), 'utf8');
  const chapter = parseKujiangChapterHtml(html, chapterUrl);

  assert.deepEqual(chapter.paragraphs, ['真正正文', '第二行正文']);
});

test('preserves every narrative Chinese block in mixed paragraph markup', async () => {
  const html = await readFile(new URL('../fixtures/kujiang/mixed-markup.html', import.meta.url), 'utf8');
  const chapter = parseKujiangChapterHtml(html, chapterUrl);

  assert.deepEqual(chapter.paragraphs, ['第一段正文。', '第二段正文', '第二段续写。', '第三段正文。']);
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

test('keeps the request timeout active while a response body stalls', async () => {
  let cancelled = false;
  const timeoutMs = 10;
  const adapter = createKujiangAdapter({
    fetch: async () => new Response(new ReadableStream({
      cancel() {
        cancelled = true;
      }
    }), { headers: { 'content-type': 'text/html' } }),
    timeoutMs
  });
  const startedAt = Date.now();

  await assert.rejects(
    () => adapter.fetchChapter(chapterUrl),
    (error) => error instanceof SourceFetchError && error.retryable === true
  );
  assert.equal(cancelled, true);
  assert.ok(Date.now() - startedAt < timeoutMs * 10);
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

test('fetches exactly one catalog document, preserves fetch guards, and revalidates catalog redirects', async () => {
  const calls = [];
  const catalog = await readFile(new URL('../fixtures/kujiang/catalog.html', import.meta.url), 'utf8');
  const adapter = createKujiangAdapter({
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (calls.length === 1) return htmlResponse('', { status: 302, headers: { location: `${bookUrl}/catalog` } });
      return htmlResponse(catalog);
    }
  });

  const result = await adapter.fetchCatalog(bookUrl);
  assert.equal(result.entries.length, 3);
  assert.deepEqual(calls.map(({ url }) => url), [`${bookUrl}/catalog`, `${bookUrl}/catalog`]);
  assert.equal(calls[0].options.redirect, 'manual');

  const unsafe = createKujiangAdapter({
    fetch: async () => htmlResponse('', { status: 302, headers: { location: 'https://example.com/book/9/catalog' } })
  });
  await assert.rejects(() => unsafe.fetchCatalog(bookUrl), SourceFetchError);
  await assert.rejects(
    () => createKujiangAdapter({ fetch: async () => new Response('not html', { headers: { 'content-type': 'text/plain' } }) }).fetchCatalog(bookUrl),
    SourceFetchError
  );
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
