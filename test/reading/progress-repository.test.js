import assert from 'node:assert/strict';
import test from 'node:test';
import { openDatabase } from '../../src/db/database.js';
import { migrate } from '../../src/db/migrate.js';
import { NotFoundError, ValidationError } from '../../src/domain/errors.js';
import { createChapterRepository } from '../../src/chapters/chapter-repository.js';
import { createNovelRepository } from '../../src/novels/novel-repository.js';
import { createProgressRepository } from '../../src/reading/progress-repository.js';

function repositories() {
  const database = openDatabase({ databasePath: ':memory:' });
  migrate(database);
  const clock = () => new Date('2026-10-11T00:00:00.000Z');
  return {
    database,
    novels: createNovelRepository(database, clock),
    chapters: createChapterRepository(database, clock),
    progress: createProgressRepository(database, clock)
  };
}

test('progress for one novel cannot change another novel', (t) => {
  const { database, novels, chapters, progress } = repositories();
  t.after(() => database.close());
  const first = novels.createNovel({ title: 'First' });
  const second = novels.createNovel({ title: 'Second' });

  chapters.recordChapter({ novelId: first.id, chapterNumber: 4, title: 'Four', originalText: 'Four' });
  chapters.recordChapter({ novelId: second.id, chapterNumber: 9, title: 'Nine', originalText: 'Nine' });

  progress.setReadingProgress({ novelId: first.id, chapterNumber: 4 });
  progress.setReadingProgress({ novelId: second.id, chapterNumber: 9 });

  assert.equal(progress.getReadingProgress(first.id).chapterNumber, 4);
  assert.equal(progress.getReadingProgress(second.id).chapterNumber, 9);
});

test('progress validates its boundary and preserves the novel key on updates', (t) => {
  const { database, novels, chapters, progress } = repositories();
  t.after(() => database.close());
  const novel = novels.createNovel({ title: 'Ink Trail' });

  chapters.recordChapter({ novelId: novel.id, chapterNumber: 4, title: 'Four', originalText: 'Four' });
  chapters.recordChapter({ novelId: novel.id, chapterNumber: 5, title: 'Five', originalText: 'Five' });

  progress.setReadingProgress({ novelId: novel.id, chapterNumber: 4 });
  assert.equal(progress.setReadingProgress({ novelId: novel.id, chapterNumber: 5 }).chapterNumber, 5);
  assert.equal(progress.getReadingProgress(novel.id).chapterNumber, 5);
  assert.throws(() => progress.setReadingProgress({ novelId: novel.id, chapterNumber: 0 }), ValidationError);
  assert.throws(() => progress.getReadingProgress('missing'), NotFoundError);
});

test('progress rejects missing and cross-novel chapters without overwriting progress', (t) => {
  const { database, novels, chapters, progress } = repositories();
  t.after(() => database.close());
  const novel = novels.createNovel({ title: 'Ink Trail' });
  const otherNovel = novels.createNovel({ title: 'Other Trail' });

  chapters.recordChapter({ novelId: novel.id, chapterNumber: 1, title: 'One', originalText: 'One' });
  chapters.recordChapter({ novelId: otherNovel.id, chapterNumber: 2, title: 'Two', originalText: 'Two' });
  progress.setReadingProgress({ novelId: novel.id, chapterNumber: 1 });

  assert.throws(() => progress.setReadingProgress({ novelId: novel.id, chapterNumber: 3 }), NotFoundError);
  assert.throws(() => progress.setReadingProgress({ novelId: novel.id, chapterNumber: 2 }), NotFoundError);
  assert.equal(progress.getReadingProgress(novel.id).chapterNumber, 1);
});
