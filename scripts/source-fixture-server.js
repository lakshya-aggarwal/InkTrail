import { mkdtempSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';

const sourceUrl = /^https:\/\/www\.kujiang\.com\/book\/[1-9]\d*\/[1-9]\d*$/;
const failedSourceUrl = 'https://www.kujiang.com/book/9/906597';
const catalogUrl = 'https://www.kujiang.com/book/9/catalog';
const novelPingUrl = 'https://novelping.com/book/return-of-the-war-god/chapter-2-lamp-fire';
const unresolvedNovelPingUrl = 'https://novelping.com/book/unknown/chapter-2-lamp-fire';
const retryNovelPingUrl = 'https://novelping.com/book/return-of-the-war-god/chapter-2-retry';
const fixtureResolutionIds = [101, 201];
const fixturePath = new URL('../test/fixtures/kujiang/chapter.html', import.meta.url);
const catalogFixturePath = new URL('../test/fixtures/kujiang/catalog.html', import.meta.url);
const novelPingFixturePath = new URL('../test/fixtures/novelping/chapter-2.html', import.meta.url);

async function fixtureFetch(url) {
  const value = String(url);
  if (value === novelPingUrl) {
    return new Response(await readFile(novelPingFixturePath, 'utf8'), {
      headers: { 'content-type': 'text/html; charset=utf-8' }
    });
  }
  if (value === unresolvedNovelPingUrl) {
    return new Response('<main><a data-novel-title>Unknown novel</a><h1 data-chapter-number="2" data-chapter-title>Lamp Fire</h1></main>', {
      headers: { 'content-type': 'text/html; charset=utf-8' }
    });
  }
  if (value === retryNovelPingUrl) throw new Error('fixture NovelPing fetch failure');
  const fixtureResolution = /^https:\/\/novelping\.com\/book\/fixture-source-(\d+)\/chapter-2-lamp-fire$/.exec(value);
  if (fixtureResolution) {
    return new Response(`<main><a data-novel-title>Fixture source ${fixtureResolution[1]}</a><h1 data-chapter-number="2" data-chapter-title>Lamp Fire</h1></main>`, {
      headers: { 'content-type': 'text/html; charset=utf-8' }
    });
  }
  if (value === catalogUrl) {
    return new Response(await readFile(catalogFixturePath, 'utf8'), {
      headers: { 'content-type': 'text/html; charset=utf-8' }
    });
  }
  if (/^https:\/\/www\.kujiang\.com\/book\/8(?:101|201)\/catalog$/.test(value)) {
    const bookId = new URL(value).pathname.split('/')[2];
    return new Response(`<section class="kjsection-catalog"><a href="/book/${bookId}/100">第一章 起程</a><a href="/book/${bookId}/101">第二章 灯火</a></section>`, {
      headers: { 'content-type': 'text/html; charset=utf-8' }
    });
  }
  if (/^https:\/\/www\.kujiang\.com\/book\/(91|92|93|94)\d*\/catalog$/.test(value)) {
    if (/\/(93|94)\d*\/catalog$/.test(value)) await new Promise((resolve) => setTimeout(resolve, 2_500));
    const bookId = new URL(value).pathname.split('/')[2];
    return new Response(`<section class="kjsection-catalog"><a href="/book/${bookId}/7918">Fixture slow chapter</a></section>`, {
      headers: { 'content-type': 'text/html; charset=utf-8' }
    });
  }
  if (value === failedSourceUrl) {
    throw new Error('fixture source fetch failure');
  }
  if (/^https:\/\/www\.kujiang\.com\/book\/(95|96)\d*\/catalog$/.test(value)) {
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    throw new Error('fixture catalog fetch failure');
  }
  const chapterId = new URL(value).pathname.split('/').at(-1);
  if (chapterId === '7918') await new Promise((resolve) => setTimeout(resolve, 2_500));
  const fixtureMode = chapterId.startsWith('7') ? chapterId.at(-1) : null;
  if (fixtureMode === '8' || fixtureMode === '9') {
    const marker = fixtureMode === '8' ? 'E2E_SLOW_TRANSLATION' : 'E2E_UNAVAILABLE_TRANSLATION';
    return new Response(`<h1 class="article-title">Fixture chapter</h1><article class="article-content"><p>测试内容 ${marker}</p></article>`, {
      headers: { 'content-type': 'text/html; charset=utf-8' }
    });
  }
  if (sourceUrl.test(value)) {
    return new Response(await readFile(fixturePath, 'utf8'), {
      headers: { 'content-type': 'text/html; charset=utf-8' }
    });
  }
  throw new Error('fixture source URL is not configured');
}

const fixtureTranslationProvider = {
  provider: 'fixture',
  model: 'fixture-model',
  async translate({ originalChinese }) {
    if (originalChinese.includes('E2E_SLOW_TRANSLATION')) {
      await new Promise((resolve) => setTimeout(resolve, 2_500));
    }
    if (originalChinese.includes('E2E_UNAVAILABLE_TRANSLATION')) {
      const error = new Error('fixture translation provider unavailable');
      error.retryable = true;
      throw error;
    }
    return {
      paragraphs: originalChinese
        .split(/\n\s*\n/)
        .filter(Boolean)
        .map((_, index) => `Fixture translation ${index + 1}.`)
    };
  }
};

const app = await createApp({
  databasePath: join(mkdtempSync(join(tmpdir(), 'inktrail-source-fixture-')), 'inktrail.sqlite'),
  fetch: fixtureFetch,
  translationProvider: fixtureTranslationProvider,
  resolverCandidateIdentities: [{
    bookUrl: 'https://www.kujiang.com/book/9',
    novelTitle: '战神狂飙',
    novelTitleAliases: ['return of the war god'],
    author: '天蚕土豆',
    authorAliases: ['tian can tu dou'],
    chapterTitleAliases: { '101': ['lamp fire'] }
  }, ...fixtureResolutionIds.map((id) => ({
    bookUrl: `https://www.kujiang.com/book/8${id}`,
    novelTitle: `Fixture source ${id}`,
    novelTitleAliases: [`fixture source ${id}`],
    chapterTitleAliases: { '101': ['lamp fire'] }
  }))],
  runnerOptions: { retryDelayMs: 5 }
});
const port = Number(process.env.PORT ?? 4278);
app.server.listen(port, '127.0.0.1');
await once(app.server, 'listening');
console.log(`InkTrail source fixture server listening on http://127.0.0.1:${port}`);
