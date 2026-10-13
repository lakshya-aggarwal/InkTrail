import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createChapterRepository } from '../../src/chapters/chapter-repository.js';
import { openDatabase } from '../../src/db/database.js';
import { migrate } from '../../src/db/migrate.js';
import { ConflictError, NotFoundError, SourceFetchError, ValidationError } from '../../src/domain/errors.js';
import { createNovelRepository } from '../../src/novels/novel-repository.js';
import { createAdapterRegistry } from '../../src/sources/adapter-registry.js';
import { createKujiangAdapter } from '../../src/sources/kujiang-adapter.js';
import { createSourceImportService } from '../../src/sources/source-import-service.js';
import { createSourceRepository } from '../../src/sources/source-repository.js';

const chapterUrl = 'https://www.kujiang.com/book/9/906595';
const nextChapterUrl = 'https://www.kujiang.com/book/9/906596';
const fixturePath = new URL('../fixtures/kujiang/chapter.html', import.meta.url);
const clock = () => new Date('2026-10-12T00:00:00.000Z');

async function chapterHtml() {
  return readFile(fixturePath, 'utf8');
}

function createRepositories() {
  const database = openDatabase({ databasePath: ':memory:' });
  migrate(database);
  return repositoriesForDatabase(database);
}

function createLegacyRepositories() {
  const database = openDatabase({ databasePath: ':memory:' });
  database.exec(readFileSync(new URL('../../src/db/migrations/001-library.sql', import.meta.url), 'utf8'));
  database.exec(readFileSync(new URL('../../src/db/migrations/002-sources.sql', import.meta.url), 'utf8'));
  database.prepare('insert into schema_migrations (version, applied_at) values (?, ?)').run(1, '2026-10-12T00:00:00.000Z');
  database.prepare('insert into schema_migrations (version, applied_at) values (?, ?)').run(2, '2026-10-12T00:00:00.000Z');
  return repositoriesForDatabase(database);
}

function repositoriesForDatabase(database) {
  return {
    database,
    novels: createNovelRepository(database, clock),
    chapters: createChapterRepository(database, clock),
    sources: createSourceRepository(database, clock)
  };
}

function createService(repositories, fetch) {
  const adapter = createKujiangAdapter({ fetch });
  return createSourceImportService({
    database: repositories.database,
    repositories,
    adapterRegistry: createAdapterRegistry([adapter]),
    clock
  });
}

function tableCounts(database) {
  return Object.fromEntries(['chapters', 'novel_sources', 'chapter_sources'].map((table) => [
    table,
    database.prepare(`select count(*) as count from ${table}`).get().count
  ]));
}

test('imports a source chapter with explicit reader order and persisted provenance', async (t) => {
  const repositories = createRepositories();
  t.after(() => repositories.database.close());
  const novel = repositories.novels.createNovel({ title: 'Ink Trail' });
  const service = createService(repositories, async () => new Response(await chapterHtml(), {
    headers: { 'content-type': 'text/html' }
  }));

  const imported = await service.importChapter({ novelId: novel.id, sourceUrl: chapterUrl, chapterNumber: 7 });

  assert.equal(imported.created, true);
  assert.equal(imported.chapter.chapterNumber, 7);
  assert.equal(imported.chapter.originalText, '夜色落在城墙上，远处的灯火仍未熄灭。\n\n他抬起头\n\n看见了归来的路。\n\n她说上一章的旧书里夹着一张加入书架的便签。');
  assert.equal(imported.chapter.sourceUrl, chapterUrl);
  assert.deepEqual(imported.source, repositories.sources.getChapterSource({
    novelId: novel.id,
    site: 'kujiang',
    normalizedUrl: chapterUrl
  }));
  assert.equal(imported.source.externalChapterId, '906595');
  assert.equal(imported.source.contentSha256, createHash('sha256').update(imported.chapter.originalText).digest('hex'));
  assert.deepEqual(tableCounts(repositories.database), { chapters: 1, novel_sources: 1, chapter_sources: 1 });
});

test('re-importing unchanged source content is idempotent', async (t) => {
  const repositories = createRepositories();
  t.after(() => repositories.database.close());
  const novel = repositories.novels.createNovel({ title: 'Ink Trail' });
  const service = createService(repositories, async () => new Response(await chapterHtml(), {
    headers: { 'content-type': 'text/html' }
  }));
  const input = { novelId: novel.id, sourceUrl: chapterUrl, chapterNumber: 4 };

  const first = await service.importChapter(input);
  const second = await service.importChapter(input);

  assert.deepEqual(second, { ...first, created: false });
  assert.deepEqual(tableCounts(repositories.database), { chapters: 1, novel_sources: 1, chapter_sources: 1 });
});

test('imports distinct chapters from one source novel with shared book provenance', async (t) => {
  const repositories = createRepositories();
  t.after(() => repositories.database.close());
  const novel = repositories.novels.createNovel({ title: 'Ink Trail' });
  const service = createService(repositories, async () => new Response(await chapterHtml(), {
    headers: { 'content-type': 'text/html' }
  }));

  await service.importChapter({ novelId: novel.id, sourceUrl: chapterUrl, chapterNumber: 1 });
  const second = await service.importChapter({ novelId: novel.id, sourceUrl: nextChapterUrl, chapterNumber: 2 });

  assert.equal(second.chapter.chapterNumber, 2);
  assert.equal(second.source.sourceUrl, nextChapterUrl);
  assert.deepEqual(tableCounts(repositories.database), { chapters: 2, novel_sources: 1, chapter_sources: 2 });
  assert.deepEqual(repositories.database.prepare(`
    select source_url, normalized_url from novel_sources where novel_id = ?
  `).all(novel.id).map((row) => ({ ...row })), [{
    source_url: 'https://www.kujiang.com/book/9',
    normalized_url: 'https://www.kujiang.com/book/9'
  }]);
});

test('migrates 83de539 chapter-level provenance before importing the next chapter', async (t) => {
  const repositories = createLegacyRepositories();
  t.after(() => repositories.database.close());
  const novel = repositories.novels.createNovel({ title: 'Ink Trail' });
  const otherNovel = repositories.novels.createNovel({ title: 'Other source' });
  const firstChapter = repositories.chapters.recordChapter({
    novelId: novel.id,
    chapterNumber: 1,
    title: 'First',
    originalText: 'First source text',
    sourceUrl: chapterUrl
  });
  const legacyNovelSource = repositories.sources.createOrGetNovelSource({
    novelId: novel.id,
    site: 'kujiang',
    externalNovelId: '9',
    sourceUrl: chapterUrl,
    normalizedUrl: chapterUrl,
    title: novel.title
  });
  repositories.sources.createChapterSource({
    novelId: novel.id,
    chapterId: firstChapter.id,
    novelSourceId: legacyNovelSource.id,
    site: 'kujiang',
    externalChapterId: '906595',
    sourceUrl: chapterUrl,
    normalizedUrl: chapterUrl,
    sourceTitle: 'First',
    previousSourceUrl: null,
    nextSourceUrl: nextChapterUrl,
    fetchedAt: '2026-10-12T00:00:00.000Z',
    contentSha256: 'legacy-hash'
  });
  repositories.sources.createOrGetNovelSource({
    novelId: otherNovel.id,
    site: 'other',
    externalNovelId: '1',
    sourceUrl: 'https://source.example/chapters/1',
    normalizedUrl: 'https://source.example/chapters/1',
    title: otherNovel.title
  });

  migrate(repositories.database);
  const service = createService(repositories, async () => new Response(await chapterHtml(), {
    headers: { 'content-type': 'text/html' }
  }));
  const second = await service.importChapter({ novelId: novel.id, sourceUrl: nextChapterUrl, chapterNumber: 2 });

  assert.equal(second.source.novelSourceId, legacyNovelSource.id);
  assert.deepEqual(repositories.database.prepare(`
    select site, source_url, normalized_url from novel_sources order by site
  `).all().map((row) => ({ ...row })), [
    {
      site: 'kujiang',
      source_url: 'https://www.kujiang.com/book/9',
      normalized_url: 'https://www.kujiang.com/book/9'
    },
    {
      site: 'other',
      source_url: 'https://source.example/chapters/1',
      normalized_url: 'https://source.example/chapters/1'
    }
  ]);
  assert.equal(repositories.database.prepare(`
    select count(*) as count from chapter_sources where novel_source_id = ?
  `).get(legacyNovelSource.id).count, 2);
});

test('rolls back provenance when the requested reader chapter number already exists', async (t) => {
  const repositories = createRepositories();
  t.after(() => repositories.database.close());
  const novel = repositories.novels.createNovel({ title: 'Ink Trail' });
  repositories.chapters.recordChapter({ novelId: novel.id, chapterNumber: 1, title: 'Manual', originalText: 'Existing chapter' });
  const service = createService(repositories, async () => new Response(await chapterHtml(), {
    headers: { 'content-type': 'text/html' }
  }));

  await assert.rejects(
    () => service.importChapter({ novelId: novel.id, sourceUrl: chapterUrl, chapterNumber: 1 }),
    ConflictError
  );
  assert.deepEqual(tableCounts(repositories.database), { chapters: 1, novel_sources: 0, chapter_sources: 0 });
});

test('rejects source mappings owned by another novel and changed content without writes', async (t) => {
  const repositories = createRepositories();
  t.after(() => repositories.database.close());
  const firstNovel = repositories.novels.createNovel({ title: 'First' });
  const secondNovel = repositories.novels.createNovel({ title: 'Second' });
  const service = createService(repositories, async () => new Response(await chapterHtml(), {
    headers: { 'content-type': 'text/html' }
  }));
  await service.importChapter({ novelId: firstNovel.id, sourceUrl: chapterUrl, chapterNumber: 1 });

  await assert.rejects(
    () => service.importChapter({ novelId: secondNovel.id, sourceUrl: chapterUrl, chapterNumber: 1 }),
    ConflictError
  );
  assert.deepEqual(tableCounts(repositories.database), { chapters: 1, novel_sources: 1, chapter_sources: 1 });

  const changedService = createService(repositories, async () => new Response(
    (await chapterHtml()).replace('夜色落在城墙上，远处的灯火仍未熄灭。', '夜色落在城墙上，城门已经关闭。'),
    { headers: { 'content-type': 'text/html' } }
  ));
  await assert.rejects(
    () => changedService.importChapter({ novelId: firstNovel.id, sourceUrl: chapterUrl, chapterNumber: 1 }),
    ConflictError
  );
  assert.deepEqual(tableCounts(repositories.database), { chapters: 1, novel_sources: 1, chapter_sources: 1 });
});

test('validates before fetch and leaves no state after source fetch or parse failures', async (t) => {
  const repositories = createRepositories();
  t.after(() => repositories.database.close());
  const novel = repositories.novels.createNovel({ title: 'Ink Trail' });
  let requests = 0;
  const service = createService(repositories, async () => {
    requests += 1;
    throw new SourceFetchError('source failed');
  });

  await assert.rejects(() => service.importChapter({ novelId: ' ', sourceUrl: chapterUrl, chapterNumber: 1 }), ValidationError);
  await assert.rejects(() => service.importChapter({ novelId: novel.id, sourceUrl: 'https://example.com/chapter', chapterNumber: 1 }), ValidationError);
  await assert.rejects(() => service.importChapter({ novelId: 'missing', sourceUrl: chapterUrl, chapterNumber: 1 }), NotFoundError);
  await assert.rejects(() => service.importChapter({ novelId: novel.id, sourceUrl: chapterUrl, chapterNumber: 0 }), ValidationError);
  assert.equal(requests, 0);
  await assert.rejects(
    () => service.importChapter({ novelId: novel.id, sourceUrl: chapterUrl, chapterNumber: 1 }),
    SourceFetchError
  );
  assert.deepEqual(tableCounts(repositories.database), { chapters: 0, novel_sources: 0, chapter_sources: 0 });

  const parseService = createService(repositories, async () => new Response('<article>not a chapter</article>', {
    headers: { 'content-type': 'text/html' }
  }));
  await assert.rejects(
    () => parseService.importChapter({ novelId: novel.id, sourceUrl: chapterUrl, chapterNumber: 1 }),
    SourceFetchError
  );
  assert.deepEqual(tableCounts(repositories.database), { chapters: 0, novel_sources: 0, chapter_sources: 0 });
});
