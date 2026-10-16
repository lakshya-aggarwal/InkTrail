import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createChapterRepository } from '../../src/chapters/chapter-repository.js';
import { openDatabase } from '../../src/db/database.js';
import { migrate } from '../../src/db/migrate.js';
import { ConflictError } from '../../src/domain/errors.js';
import { createNovelRepository } from '../../src/novels/novel-repository.js';
import { createSourceCatalogRepository } from '../../src/sources/source-catalog-repository.js';
import { createSourceCatalogService } from '../../src/sources/source-catalog-service.js';
import { createSourceRepository } from '../../src/sources/source-repository.js';
import { createKujiangAdapter } from '../../src/sources/kujiang-adapter.js';

const bookUrl = 'https://www.kujiang.com/book/9';
const clock = () => new Date('2026-10-17T00:00:00.000Z');

function createRepositories() {
  const database = openDatabase({ databasePath: ':memory:' });
  migrate(database);
  return {
    database,
    novels: createNovelRepository(database, clock),
    chapters: createChapterRepository(database, clock),
    sources: createSourceRepository(database, clock),
    catalogs: createSourceCatalogRepository(database, clock)
  };
}

async function catalogHtml() {
  return readFile(new URL('../fixtures/kujiang/catalog.html', import.meta.url), 'utf8');
}

function createService(repositories, fetch) {
  return createSourceCatalogService({
    database: repositories.database,
    repositories,
    catalogAdapter: createKujiangAdapter({ fetch })
  });
}

test('stores an immutable fetched catalog without chapter or provenance side effects', async (t) => {
  const repositories = createRepositories();
  t.after(() => repositories.database.close());
  const novel = repositories.novels.createNovel({ title: 'Ink Trail' });
  const service = createService(repositories, async () => new Response(await catalogHtml(), { headers: { 'content-type': 'text/html' } }));

  const snapshot = await service.fetchCatalogSnapshot({ novelId: novel.id, bookUrl });

  assert.equal(snapshot.catalog.canonicalBookUrl, bookUrl);
  assert.equal(snapshot.entries.length, 3);
  assert.equal(repositories.database.prepare('select count(*) as count from novel_sources').get().count, 1);
  assert.equal(repositories.database.prepare('select count(*) as count from chapters').get().count, 0);
  assert.equal(repositories.database.prepare('select count(*) as count from chapter_sources').get().count, 0);
});

test('returns the same snapshot for equivalent canonical catalog content and appends changed content', async (t) => {
  const repositories = createRepositories();
  t.after(() => repositories.database.close());
  const novel = repositories.novels.createNovel({ title: 'Ink Trail' });
  let html = await catalogHtml();
  const service = createService(repositories, async () => new Response(html, { headers: { 'content-type': 'text/html' } }));

  const first = await service.fetchCatalogSnapshot({ novelId: novel.id, bookUrl });
  const again = await service.fetchCatalogSnapshot({ novelId: novel.id, bookUrl });
  html = html.replace('第三章归途', '第三章新归途');
  const changed = await service.fetchCatalogSnapshot({ novelId: novel.id, bookUrl });

  assert.equal(again.catalog.id, first.catalog.id);
  assert.notEqual(changed.catalog.id, first.catalog.id);
  assert.equal(repositories.catalogs.listSnapshots(novel.id).length, 2);
});

test('does not replace or share a book source already owned by another novel', async (t) => {
  const repositories = createRepositories();
  t.after(() => repositories.database.close());
  const firstNovel = repositories.novels.createNovel({ title: 'First' });
  const secondNovel = repositories.novels.createNovel({ title: 'Second' });
  const service = createService(repositories, async () => new Response(await catalogHtml(), { headers: { 'content-type': 'text/html' } }));

  await service.fetchCatalogSnapshot({ novelId: firstNovel.id, bookUrl });
  await assert.rejects(() => service.fetchCatalogSnapshot({ novelId: secondNovel.id, bookUrl }), ConflictError);

  assert.equal(repositories.catalogs.listSnapshots(firstNovel.id).length, 1);
  assert.equal(repositories.catalogs.listSnapshots(secondNovel.id).length, 0);
  assert.equal(repositories.database.prepare('select count(*) as count from novel_sources').get().count, 1);
});

test('does not silently select a different Kujiang book for the same novel', async (t) => {
  const repositories = createRepositories();
  t.after(() => repositories.database.close());
  const novel = repositories.novels.createNovel({ title: 'Ink Trail' });
  const service = createService(repositories, async (url) => new Response(
    (await catalogHtml()).replaceAll('/book/9/', new URL(url).pathname.startsWith('/book/10/') ? '/book/10/' : '/book/9/'),
    { headers: { 'content-type': 'text/html' } }
  ));

  await service.fetchCatalogSnapshot({ novelId: novel.id, bookUrl });
  await assert.rejects(() => service.fetchCatalogSnapshot({ novelId: novel.id, bookUrl: 'https://www.kujiang.com/book/10' }), ConflictError);

  assert.equal(repositories.catalogs.listSnapshots(novel.id).length, 1);
  assert.equal(repositories.database.prepare('select count(*) as count from novel_sources').get().count, 1);
});
