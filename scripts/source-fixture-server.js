import { mkdtempSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';

const sourceUrl = /^https:\/\/www\.kujiang\.com\/book\/[1-9]\d*\/[1-9]\d*$/;
const failedSourceUrl = 'https://www.kujiang.com/book/9/906597';
const fixturePath = new URL('../test/fixtures/kujiang/chapter.html', import.meta.url);

async function fixtureFetch(url) {
  const value = String(url);
  const chapterId = new URL(value).pathname.split('/').at(-1);
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
  if (url === failedSourceUrl) {
    throw new Error('fixture source fetch failure');
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
  runnerOptions: { retryDelayMs: 5 }
});
const port = Number(process.env.PORT ?? 4278);
app.server.listen(port, '127.0.0.1');
await once(app.server, 'listening');
console.log(`InkTrail source fixture server listening on http://127.0.0.1:${port}`);
