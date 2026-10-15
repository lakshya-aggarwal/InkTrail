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
  if (sourceUrl.test(String(url))) {
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
  translationProvider: fixtureTranslationProvider
});
const port = Number(process.env.PORT ?? 4278);
app.server.listen(port, '127.0.0.1');
await once(app.server, 'listening');
console.log(`InkTrail source fixture server listening on http://127.0.0.1:${port}`);
