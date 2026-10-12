import assert from 'node:assert/strict';
import test from 'node:test';
import { openDatabase } from '../../src/db/database.js';
import { migrate } from '../../src/db/migrate.js';
import { ConflictError } from '../../src/domain/errors.js';
import { createChapterRepository } from '../../src/chapters/chapter-repository.js';
import { createNovelRepository } from '../../src/novels/novel-repository.js';
import { createSourceRepository } from '../../src/sources/source-repository.js';

function repositories() {
  const database = openDatabase({ databasePath: ':memory:' });
  migrate(database);
  const clock = () => new Date('2026-10-12T00:00:00.000Z');
  return {
    database,
    novels: createNovelRepository(database, clock),
    chapters: createChapterRepository(database, clock),
    sources: createSourceRepository(database, clock)
  };
}

function novelSourceInput(novelId) {
  return {
    novelId,
    site: 'kujiang',
    externalNovelId: '9',
    sourceUrl: 'https://www.kujiang.com/book/9',
    normalizedUrl: 'https://www.kujiang.com/book/9',
    title: 'Ink Trail'
  };
}

function chapterSourceInput({ novelId, chapterId, novelSourceId, contentSha256 = 'hash-a' }) {
  return {
    novelId,
    chapterId,
    novelSourceId,
    site: 'kujiang',
    externalChapterId: '906595',
    sourceUrl: 'https://www.kujiang.com/book/9/906595',
    normalizedUrl: 'https://www.kujiang.com/book/9/906595',
    sourceTitle: 'Arrival',
    previousSourceUrl: null,
    nextSourceUrl: null,
    fetchedAt: '2026-10-12T00:00:00.000Z',
    contentSha256
  };
}

test('creates and selects camelCase source provenance records', (t) => {
  const { database, novels, chapters, sources } = repositories();
  t.after(() => database.close());
  const novel = novels.createNovel({ title: 'Ink Trail' });
  const chapter = chapters.recordChapter({ novelId: novel.id, chapterNumber: 1, title: 'Arrival', originalText: 'Chinese' });
  const novelSource = sources.createOrGetNovelSource(novelSourceInput(novel.id));
  const input = chapterSourceInput({ novelId: novel.id, chapterId: chapter.id, novelSourceId: novelSource.id });
  const chapterSource = sources.createChapterSource(input);

  assert.deepEqual(sources.createOrGetNovelSource(novelSourceInput(novel.id)), novelSource);
  assert.deepEqual(sources.createChapterSource(input), chapterSource);
  assert.deepEqual(sources.getChapterSource({ novelId: novel.id, site: input.site, normalizedUrl: input.normalizedUrl }), chapterSource);
  assert.equal(chapterSource.novelId, novel.id);
  assert.equal(chapterSource.chapterId, chapter.id);
  assert.equal(chapterSource.contentSha256, 'hash-a');
});

test('rejects cross-novel source collisions and changed source content', (t) => {
  const { database, novels, chapters, sources } = repositories();
  t.after(() => database.close());
  const first = novels.createNovel({ title: 'First' });
  const second = novels.createNovel({ title: 'Second' });
  const firstChapter = chapters.recordChapter({ novelId: first.id, chapterNumber: 1, title: 'First', originalText: 'Chinese' });
  const secondChapter = chapters.recordChapter({ novelId: second.id, chapterNumber: 1, title: 'Second', originalText: 'Chinese' });
  const firstNovelSource = sources.createOrGetNovelSource(novelSourceInput(first.id));
  const input = chapterSourceInput({ novelId: first.id, chapterId: firstChapter.id, novelSourceId: firstNovelSource.id });
  sources.createChapterSource(input);

  assert.equal(sources.getChapterSource({ novelId: second.id, site: input.site, normalizedUrl: input.normalizedUrl }), null);
  assert.throws(() => sources.createOrGetNovelSource(novelSourceInput(second.id)), ConflictError);
  assert.throws(() => sources.createChapterSource({ ...input, contentSha256: 'hash-b' }), ConflictError);
  assert.throws(() => sources.createChapterSource({ ...input, novelId: second.id, chapterId: secondChapter.id }), ConflictError);
});
