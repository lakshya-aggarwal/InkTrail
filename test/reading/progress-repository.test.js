import assert from 'node:assert/strict';
import test from 'node:test';
import { openDatabase } from '../../src/db/database.js';
import { migrate } from '../../src/db/migrate.js';
import { NotFoundError, ValidationError } from '../../src/domain/errors.js';
import { createNovelRepository } from '../../src/novels/novel-repository.js';
import { createProgressRepository } from '../../src/reading/progress-repository.js';

function repositories() {
  const database = openDatabase({ databasePath: ':memory:' });
  migrate(database);
  const clock = () => new Date('2026-10-11T00:00:00.000Z');
  return {
    database,
    novels: createNovelRepository(database, clock),
    progress: createProgressRepository(database, clock)
  };
}

test('progress for one novel cannot change another novel', (t) => {
  const { database, novels, progress } = repositories();
  t.after(() => database.close());
  const first = novels.createNovel({ title: 'First' });
  const second = novels.createNovel({ title: 'Second' });

  progress.setReadingProgress({ novelId: first.id, chapterNumber: 4 });
  progress.setReadingProgress({ novelId: second.id, chapterNumber: 9 });

  assert.equal(progress.getReadingProgress(first.id).chapterNumber, 4);
  assert.equal(progress.getReadingProgress(second.id).chapterNumber, 9);
});

test('progress validates its boundary and preserves the novel key on updates', (t) => {
  const { database, novels, progress } = repositories();
  t.after(() => database.close());
  const novel = novels.createNovel({ title: 'Ink Trail' });

  progress.setReadingProgress({ novelId: novel.id, chapterNumber: 4 });
  assert.equal(progress.setReadingProgress({ novelId: novel.id, chapterNumber: 5 }).chapterNumber, 5);
  assert.equal(progress.getReadingProgress(novel.id).chapterNumber, 5);
  assert.throws(() => progress.setReadingProgress({ novelId: novel.id, chapterNumber: 0 }), ValidationError);
  assert.throws(() => progress.getReadingProgress('missing'), NotFoundError);
});
